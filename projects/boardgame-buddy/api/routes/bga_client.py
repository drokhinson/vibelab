"""Identity and transport for Board Game Arena requests made as a linked user.

The sibling of `bgg_client.py`'s user-scoped half, minus everything that is
xmlapi2-specific (no bearer token, no XML, no warm-up retry). Read that file's
`_run_as_user` first — the identity-vs-protocol split, and the hard-won lesson
that a SECOND rejection after a proven-good password is not a credential
problem, are both copied from it deliberately.

THREE THINGS THAT ARE NOT COPIED FROM IT, and must not be "made consistent":

  1. **An honest User-Agent.** `bgg_client._web_headers` spoofs Chrome to get
     past Cloudflare screening ordinary traffic. BGA's terms name automated
     access itself, so a bot screen that turns us away is a control working as
     designed — and defeating it is a different act from reading your own data.
     If BGA blocks `vibelab-boardgame-buddy/1.0`, that is information the user
     needs, not a bug to route around.

  2. **A process-wide throttle behind a single-flight lock.** BGG throttles
     inside each sweep (`await asyncio.sleep(...)` in its loop), which lets two
     users' sweeps interleave at full speed. That is not enough here: BGG
     rate-limits, BGA bans. One BGA request at a time per worker, with a
     minimum gap since the last one — and `CLAUDE.md` guarantees one uvicorn
     worker, so a process-level lock is the whole fleet. Two concurrent imports
     each go slower, which is the correct trade.

  3. **Dry run defaults ON.** Nothing reaches boardgamearena.com until somebody
     sets `BGA_DRY_RUN=false` on purpose. See `bga_endpoints.dry_run_enabled`.

Docs/BGA_IMPORT.md records why all three exist, so they survive a tidy-up pass.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import HTTPException
from supabase import Client

import cache
from api_logger import log_external_call
from db import get_supabase

from . import bga_endpoints as bga
from .bga_credentials import BgaSession, decrypt_password, encrypt_password, login_to_bga

logger = logging.getLogger(__name__)

# Refresh this far before the stored expiry rather than at it — a cookie that
# dies mid-sweep costs a re-login AND a retried request.
_SESSION_REFRESH_LEEWAY = timedelta(minutes=5)

_PROFILE_COLUMNS = (
    "bga_username, bga_player_id, bga_password_enc, bga_session_cookies, "
    "bga_session_expires_at, bga_last_login_at, bga_last_import_at"
)

# A finished BGA table never changes, which makes it the one genuinely
# cacheable thing here: it is what makes re-running the wizard after a failed
# import nearly free, and what stops the account paying twice for one read.
_TABLE_NS = "bga.tableinfo"
_TABLE_TTL = 24 * 60 * 60.0
cache.configure(_TABLE_NS, max_entries=5000)


def throttle_seconds() -> float:
    """Minimum gap between BGA requests. Read per call so tests can move it."""
    import os

    try:
        return max(0.0, float(os.getenv("BGA_THROTTLE_SECONDS", "2.0")))
    except ValueError:
        return 2.0


# Module-level, so it is shared by every request this worker serves. See §2 of
# the module docstring for why this is a lock and not a per-sweep sleep.
_gate = asyncio.Lock()
_last_call_at = 0.0


class BgaRefusedError(HTTPException):
    """BGA said no to a request a freshly-minted session could not fix.

    THE POINT OF THIS CLASS IS WHAT IT IS NOT. `_run_as_user` answers a
    rejection by logging in again and retrying once, and `login_to_bga` only
    returns when BGA grants a session — a wrong password is a 400 raised in
    there and never reaches here. So by the time the retry is ALSO refused, the
    stored password has just been proven correct, and telling the user to
    re-link credentials that were never the problem is the bug
    `bgg_client.BggRefusedError` exists to remember.

    For BGA the likeliest cause is the one this feature was always going to
    meet: the account, or this client, has been refused automated access.
    """

    def __init__(self, detail: str) -> None:
        super().__init__(status_code=502, detail=detail)


# ── Profile session ──────────────────────────────────────────────────────────


def _load_profile_session(sb: Client, user_id: str) -> dict:
    """The user's BGA link row, or an actionable error."""
    res = (
        sb.table("boardgamebuddy_profiles")
        .select(_PROFILE_COLUMNS)
        .eq("id", user_id)
        .limit(1)
        .execute()
    )
    row = (res.data or [None])[0]
    if not row or not row.get("bga_username"):
        raise HTTPException(
            status_code=400,
            detail="No Board Game Arena account is linked yet.",
        )
    if not row.get("bga_password_enc"):
        # A username with nothing decryptable behind it. Not a 500 — the user
        # can fix this, and the wizard's account step renders exactly this.
        raise HTTPException(
            status_code=409,
            detail="Board Game Arena re-link required: sign in again to keep importing.",
        )
    return row


def _session_cookies(row: dict) -> dict[str, str]:
    """The stored cookie jar, as httpx wants it."""
    cookies = row.get("bga_session_cookies")
    if not isinstance(cookies, dict):
        return {}
    return {str(k): str(v) for k, v in cookies.items() if v}


def _session_is_fresh(row: dict) -> bool:
    """True when the stored session is worth trying."""
    if not _session_cookies(row):
        return False
    raw = row.get("bga_session_expires_at")
    if not raw:
        return False
    try:
        expires = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return False
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    return expires - _SESSION_REFRESH_LEEWAY > datetime.now(tz=timezone.utc)


def _persist_session(sb: Client, user_id: str, session: BgaSession) -> None:
    """Write a freshly minted session back onto the profile."""
    patch: dict = {
        "bga_session_cookies": session.cookies,
        "bga_session_expires_at": session.expires_at.isoformat(),
        "bga_last_login_at": datetime.now(timezone.utc).isoformat(),
    }
    if session.player_id:
        patch["bga_player_id"] = session.player_id
    sb.table("boardgamebuddy_profiles").update(patch).eq("id", user_id).execute()


async def _ensure_session(sb: Client, user_id: str, row: dict) -> dict:
    """Return a row whose cookies are worth sending, re-logging in if needed."""
    if _session_is_fresh(row):
        return row
    password = decrypt_password(row["bga_password_enc"])
    session = await login_to_bga(row["bga_username"], password)
    await asyncio.to_thread(_persist_session, sb, user_id, session)
    return {
        **row,
        "bga_session_cookies": session.cookies,
        "bga_session_expires_at": session.expires_at.isoformat(),
        "bga_player_id": session.player_id or row.get("bga_player_id"),
    }


def store_user_credentials(
    sb: Client, user_id: str, username: str, plain_password: str, session: BgaSession
) -> None:
    """Persist the linked handle + Fernet-encrypted password + first session."""
    sb.table("boardgamebuddy_profiles").update(
        {
            "bga_username": username,
            "bga_player_id": session.player_id,
            "bga_password_enc": encrypt_password(plain_password),
            "bga_session_cookies": session.cookies,
            "bga_session_expires_at": session.expires_at.isoformat(),
            "bga_last_login_at": datetime.now(timezone.utc).isoformat(),
        }
    ).eq("id", user_id).execute()


def clear_user_session(sb: Client, user_id: str) -> None:
    """Unlink: forget the handle, the password and the session in one write.

    Every column, not just the password. A half-cleared link reads as
    RELINK_REQUIRED, which offers the user a re-link they did not ask for
    instead of the unlinked state they did.
    """
    sb.table("boardgamebuddy_profiles").update(
        {
            "bga_username": None,
            "bga_player_id": None,
            "bga_password_enc": None,
            "bga_session_cookies": None,
            "bga_session_expires_at": None,
            "bga_last_login_at": None,
        }
    ).eq("id", user_id).execute()


def linked_bga_username(sb: Client, user_id: str) -> str:
    """The handle this account linked, or "" when there isn't one."""
    res = (
        sb.table("boardgamebuddy_profiles")
        .select("bga_username")
        .eq("id", user_id)
        .limit(1)
        .execute()
    )
    return ((res.data or [{}])[0] or {}).get("bga_username") or ""


# ── Transport ────────────────────────────────────────────────────────────────


async def _wait_turn() -> None:
    """Hold until this worker is allowed to make another BGA request."""
    global _last_call_at
    gap = throttle_seconds()
    since = time.monotonic() - _last_call_at
    if since < gap:
        await asyncio.sleep(gap - since)
    _last_call_at = time.monotonic()


async def _get(path: str, params: dict, cookies: dict[str, str], timeout: float) -> httpx.Response:
    """One throttled, logged GET. The only place an outbound BGA call happens."""
    full_url = bga.url(path)
    async with _gate:
        await _wait_turn()
        async with httpx.AsyncClient(
            timeout=timeout, headers=bga.default_headers(), cookies=cookies
        ) as client:
            async with log_external_call(
                app="boardgame-buddy", api_name="bga", method="GET", url=full_url, params=params
            ) as record:
                resp = await client.get(full_url, params=params)
                record.attach_response(resp)
                return resp


async def _run_as_user(user_id: str, *, path: str, params: dict, timeout: float) -> str:
    """GET a BGA path as the linked user, refreshing the session as needed.

    Owns IDENTITY only: loading the stored session, refreshing it before it
    expires, and re-logging in once when BGA answers as though we were signed
    out. The caller owns what the body means.

    `looks_signed_out` rather than a status check, because BGA answers a dead
    session with a 200 carrying its login page. Reading that as data is how an
    importer silently returns "you have no plays".
    """
    sb = get_supabase()
    row = await asyncio.to_thread(_load_profile_session, sb, user_id)
    row = await _ensure_session(sb, user_id, row)

    try:
        resp = await _get(path, params, _session_cookies(row), timeout)
    except httpx.HTTPError as exc:
        logger.warning("BGA network error on GET %s: %s", path, exc)
        raise HTTPException(
            status_code=503,
            detail="Board Game Arena is temporarily unreachable. Try again in a moment.",
        )

    if resp.status_code == 429:
        raise HTTPException(
            status_code=429,
            detail="Board Game Arena is rate-limiting us right now. Try again in a few minutes.",
        )
    if not bga.looks_signed_out(resp.status_code, resp.text):
        return resp.text

    logger.info("BGA answered GET %s as signed out for user=%s; re-logging in", path, user_id)
    password = decrypt_password(row["bga_password_enc"])
    session = await login_to_bga(row["bga_username"], password)
    await asyncio.to_thread(_persist_session, sb, user_id, session)

    try:
        resp = await _get(path, params, session.cookies, timeout)
    except httpx.HTTPError as exc:
        logger.warning("BGA retry network error on GET %s: %s", path, exc)
        raise HTTPException(
            status_code=503,
            detail="Board Game Arena is temporarily unreachable. Try again in a moment.",
        )

    if resp.status_code == 429:
        raise HTTPException(
            status_code=429,
            detail="Board Game Arena is rate-limiting us right now. Try again in a few minutes.",
        )
    if bga.looks_signed_out(resp.status_code, resp.text):
        # NOT a credential problem — see BgaRefusedError. login_to_bga returns
        # only when BGA grants a session, so the password just worked and the
        # request was refused anyway.
        raise BgaRefusedError(
            "Board Game Arena refused this even though your account signed in "
            "successfully. That usually means automated access has been blocked "
            "for this account or this app."
        )
    return resp.text


async def fetch_history_page(user_id: str, player_id: str, page: int) -> str:
    """One page of the user's finished-table history, newest first."""
    if bga.dry_run_enabled():
        body = bga.fixture("gamestats")
        if body is None:
            raise HTTPException(
                status_code=503,
                detail=(
                    "BGA_DRY_RUN is on but no gamestats fixture was found. Set "
                    "BGA_FIXTURE_DIR, or set BGA_DRY_RUN=false."
                ),
            )
        logger.info("BGA dry run: history page %s served from fixture", page)
        # One page only — a fixture that repeated forever would loop the sweep
        # until it hit its cap.
        return body if page == 1 else '{"tables": [], "has_more": false}'

    return await _run_as_user(
        user_id,
        path=bga.GAMESTATS_PATH,
        params=bga.gamestats_params(player_id, page=page),
        timeout=30.0,
    )


async def fetch_table_info(user_id: str, table_id: int) -> str:
    """One finished table's detail, cached because a finished table is immutable."""
    cached = cache.get(_TABLE_NS, str(table_id))
    if cached is not None:
        return cached

    if bga.dry_run_enabled():
        body = bga.fixture("tableinfo")
        if body is None:
            raise HTTPException(
                status_code=503,
                detail=(
                    "BGA_DRY_RUN is on but no tableinfo fixture was found. Set "
                    "BGA_FIXTURE_DIR, or set BGA_DRY_RUN=false."
                ),
            )
        return body

    body = await _run_as_user(
        user_id,
        path=bga.TABLEINFO_PATH,
        params=bga.tableinfo_params(table_id),
        timeout=30.0,
    )
    cache.set(_TABLE_NS, str(table_id), body, ttl_seconds=_TABLE_TTL)
    return body
