"""Shared BoardGameGeek XMLAPI2 client.

Two entry points:

  * `fetch_bgg(path, params)` — anonymous catalog requests (search, /thing).
    Adds the shared `BGG_API_TOKEN` Bearer header for rate-limit accounting.
    NOT user-scoped — the token is BGG's app-registration token, not a
    per-user credential.
  * `fetch_bgg_as_user(user_id, path, params)` — per-user requests
    (`/collection`, `/plays`, future writes). Loads the user's stored
    SessionID + bgg cookies from `boardgamebuddy_profiles`, transparently
    re-logs in via `bgg_credentials.login_to_bgg()` when the session is
    missing/expired, and sends the cookies on the GET so BGG evaluates the
    request as that user (which unlocks `showprivate=1`).

Both paths share the same 202/429/non-200 mapping below.
"""

import logging
import os
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import HTTPException
from supabase import Client

from db import get_supabase

from .bgg_credentials import (
    BggSession,
    decrypt_password,
    encrypt_password,
    login_to_bgg,
)

logger = logging.getLogger(__name__)

BGG_API_BASE = "https://boardgamegeek.com/xmlapi2"
BGG_USER_AGENT = "vibelab-boardgame-buddy/1.0"
BGG_API_TOKEN = os.getenv("BGG_API_TOKEN")
# Re-login this far ahead of the cookie's actual expiry so a long-running
# sync doesn't tip over mid-request.
_SESSION_REFRESH_LEEWAY = timedelta(minutes=5)


def _default_headers() -> dict[str, str]:
    headers = {"User-Agent": BGG_USER_AGENT}
    if BGG_API_TOKEN:
        headers["Authorization"] = f"Bearer {BGG_API_TOKEN}"
    return headers


def _map_bgg_status(resp: httpx.Response, *, path: str, params: dict) -> None:
    """Translate BGG-specific status codes into HTTPException. 200 returns silently."""
    if resp.status_code == 200:
        return
    if resp.status_code == 401:
        logger.error("BGG 401 — BGG_API_TOKEN missing or invalid")
        raise HTTPException(
            status_code=502,
            detail="BoardGameGeek authentication failed. Ensure BGG_API_TOKEN is set in Railway.",
        )
    if resp.status_code == 202:
        logger.info("BGG 202 (warming up) for %s %s", path, params)
        raise HTTPException(
            status_code=503,
            detail="BoardGameGeek is warming up this result. Retry in a few seconds.",
        )
    if resp.status_code == 429:
        logger.warning("BGG 429 rate limit for %s %s", path, params)
        raise HTTPException(
            status_code=429,
            detail="BoardGameGeek rate-limited us. Wait a few seconds and try again.",
        )
    logger.warning(
        "BGG returned %s for %s %s: %s",
        resp.status_code, path, params, resp.text[:200],
    )
    raise HTTPException(
        status_code=502,
        detail=f"BoardGameGeek returned HTTP {resp.status_code}.",
    )


async def fetch_bgg(path: str, params: dict, *, timeout: float) -> str:
    """GET an XML document from the BGG API with consistent error mapping.

    Anonymous request — used for catalog endpoints (search, /thing). Sends the
    shared bearer token only.
    """
    try:
        async with httpx.AsyncClient(timeout=timeout, headers=_default_headers()) as client:
            resp = await client.get(f"{BGG_API_BASE}{path}", params=params)
    except httpx.HTTPError as exc:
        logger.warning("BGG network error on %s %s: %s", path, params, exc)
        raise HTTPException(
            status_code=503,
            detail="BoardGameGeek is temporarily unreachable. Try again in a moment.",
        )

    _map_bgg_status(resp, path=path, params=params)
    return resp.text


# ── Per-user (cookie) variant ────────────────────────────────────────────────


def _profile_session_columns() -> str:
    return (
        "bgg_username, bgg_password_enc, bgg_session_id, bgg_session_expires_at, "
        "bgg_session_user_cookie, bgg_session_pass_cookie"
    )


def _load_profile_session(sb: Client, user_id: str) -> dict:
    """Read the linked username + stored session cookies + encrypted password.

    Raises 409 ("BGG re-link required") for users with no encrypted password
    (legacy public-only links from before per-user auth was added).
    """
    res = (
        sb.table("boardgamebuddy_profiles")
        .select(_profile_session_columns())
        .eq("id", user_id)
        .execute()
    )
    row = (res.data or [None])[0]
    if not row or not row.get("bgg_username"):
        raise HTTPException(
            status_code=400,
            detail="No BoardGameGeek account linked. Link one first.",
        )
    if not row.get("bgg_password_enc"):
        raise HTTPException(
            status_code=409,
            detail="BGG re-link required: please re-enter your BGG password.",
        )
    return row


def _persist_session(sb: Client, user_id: str, session: BggSession) -> None:
    sb.table("boardgamebuddy_profiles").update({
        "bgg_session_id": session.session_id,
        "bgg_session_expires_at": session.expires_at.isoformat(),
        "bgg_session_user_cookie": session.user_cookie,
        "bgg_session_pass_cookie": session.pass_cookie,
        "bgg_last_login_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", user_id).execute()


def _session_is_fresh(profile_row: dict) -> bool:
    """True if the stored SessionID is non-null and not within the refresh leeway."""
    if not profile_row.get("bgg_session_id"):
        return False
    expires_raw = profile_row.get("bgg_session_expires_at")
    if not expires_raw:
        return False
    try:
        expires_at = datetime.fromisoformat(expires_raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    return expires_at > datetime.now(timezone.utc) + _SESSION_REFRESH_LEEWAY


async def _ensure_session(sb: Client, user_id: str, profile_row: dict) -> dict:
    """Return a profile_row whose session cookies are fresh, refreshing if needed."""
    if _session_is_fresh(profile_row):
        return profile_row
    password = decrypt_password(profile_row["bgg_password_enc"])
    session = await login_to_bgg(profile_row["bgg_username"], password)
    _persist_session(sb, user_id, session)
    return {
        **profile_row,
        "bgg_session_id": session.session_id,
        "bgg_session_expires_at": session.expires_at.isoformat(),
        "bgg_session_user_cookie": session.user_cookie,
        "bgg_session_pass_cookie": session.pass_cookie,
    }


async def fetch_bgg_as_user(
    user_id: str,
    path: str,
    params: dict,
    *,
    timeout: float,
) -> str:
    """GET a BGG xmlapi2 path authenticated AS the linked user.

    Loads the user's stored cookies, refreshing them via `login_to_bgg()` when
    they're missing or near expiry. On a 401/403 from xmlapi2 (server-side
    session expiry that we didn't catch), re-logs in once and retries.
    """
    sb = get_supabase()
    profile_row = _load_profile_session(sb, user_id)
    profile_row = await _ensure_session(sb, user_id, profile_row)

    async def _do_get(row: dict) -> httpx.Response:
        cookies = {
            "SessionID": row["bgg_session_id"],
            "bggusername": row["bgg_session_user_cookie"] or row["bgg_username"],
            "bggpassword": row["bgg_session_pass_cookie"] or "",
        }
        async with httpx.AsyncClient(
            timeout=timeout, headers=_default_headers(), cookies=cookies,
        ) as client:
            return await client.get(f"{BGG_API_BASE}{path}", params=params)

    try:
        resp = await _do_get(profile_row)
    except httpx.HTTPError as exc:
        logger.warning("BGG network error on %s %s: %s", path, params, exc)
        raise HTTPException(
            status_code=503,
            detail="BoardGameGeek is temporarily unreachable. Try again in a moment.",
        )

    if resp.status_code in (401, 403):
        # Server-side session was already invalidated. Force one fresh login
        # and retry. If it 401s again, surface a re-link.
        logger.info("BGG xmlapi2 %s for user=%s; re-logging in", resp.status_code, user_id)
        password = decrypt_password(profile_row["bgg_password_enc"])
        session = await login_to_bgg(profile_row["bgg_username"], password)
        _persist_session(sb, user_id, session)
        retry_row = {
            **profile_row,
            "bgg_session_id": session.session_id,
            "bgg_session_user_cookie": session.user_cookie,
            "bgg_session_pass_cookie": session.pass_cookie,
        }
        try:
            resp = await _do_get(retry_row)
        except httpx.HTTPError as exc:
            logger.warning("BGG retry network error on %s %s: %s", path, params, exc)
            raise HTTPException(
                status_code=503,
                detail="BoardGameGeek is temporarily unreachable. Try again in a moment.",
            )
        if resp.status_code in (401, 403):
            raise HTTPException(
                status_code=409,
                detail="BGG re-link required: BoardGameGeek rejected the stored password.",
            )

    _map_bgg_status(resp, path=path, params=params)
    return resp.text


def clear_user_session(sb: Client, user_id: str) -> None:
    """Wipe linked username + credentials + cookies on unlink."""
    sb.table("boardgamebuddy_profiles").update({
        "bgg_username": None,
        "bgg_password_enc": None,
        "bgg_session_id": None,
        "bgg_session_expires_at": None,
        "bgg_session_user_cookie": None,
        "bgg_session_pass_cookie": None,
        "bgg_last_login_at": None,
    }).eq("id", user_id).execute()


def store_user_credentials(
    sb: Client,
    user_id: str,
    username: str,
    plain_password: str,
    session: BggSession,
) -> None:
    """Persist the linked username + Fernet-encrypted password + initial session."""
    sb.table("boardgamebuddy_profiles").update({
        "bgg_username": username,
        "bgg_password_enc": encrypt_password(plain_password),
        "bgg_session_id": session.session_id,
        "bgg_session_expires_at": session.expires_at.isoformat(),
        "bgg_session_user_cookie": session.user_cookie,
        "bgg_session_pass_cookie": session.pass_cookie,
        "bgg_last_login_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", user_id).execute()


def has_stored_credentials(profile_row: dict) -> bool:
    """True when the profile has a linked username AND an encrypted password."""
    return bool(profile_row.get("bgg_username")) and bool(profile_row.get("bgg_password_enc"))


# Re-export for callers that import from bgg_client to keep their import surface narrow.
__all__ = [
    "BGG_API_BASE",
    "BGG_API_TOKEN",
    "BGG_USER_AGENT",
    "clear_user_session",
    "fetch_bgg",
    "fetch_bgg_as_user",
    "has_stored_credentials",
    "normalize_image_url",
    "parse_bgg_xml",
    "store_user_credentials",
]


def parse_bgg_xml(body: str, *, context: str) -> ET.Element:
    """Parse a BGG XML payload; map parse errors to a 502."""
    try:
        return ET.fromstring(body)
    except ET.ParseError as exc:
        logger.warning(
            "BGG XML parse error (%s): %s\nbody[:300]=%r",
            context, exc, body[:300],
        )
        raise HTTPException(
            status_code=502,
            detail="Could not parse BoardGameGeek response.",
        )


def normalize_image_url(url: str | None) -> str | None:
    """Ensure BGG image URLs have an explicit https: scheme.

    BGG returns protocol-relative URLs (`//cf.geekdo-images.com/...`); the
    Storage uploader and the frontend image proxy both want a full URL.
    """
    if not url:
        return None
    url = url.strip()
    if url.startswith("//"):
        return "https:" + url
    return url
