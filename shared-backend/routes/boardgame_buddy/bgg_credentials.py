"""Per-user BoardGameGeek auth: password encryption + cookie-session login.

The shared `BGG_API_TOKEN` (Bearer header in bgg_client.fetch_bgg) is BGG's
app-registration token — it satisfies their rate-limit policy but isn't tied
to any specific user. To read a user's *private* collection fields and to
later act on their behalf, we have to authenticate as that user via cookies
obtained from BGG's web login endpoint.

Flow:
  1. User links BGG → backend POSTs username/password to /login/api/v1.
  2. BGG responds with Set-Cookie: SessionID, bggusername, bggpassword.
  3. We persist the cookies + an encrypted copy of the password on the profile.
  4. fetch_bgg_as_user() loads the cookies. If they're missing/expired, it
     decrypts the password and re-runs login transparently.

The encryption key (BGG_CREDENTIAL_KEY) is a Fernet key (urlsafe base64).
Rotating the key invalidates every stored password — users will be forced to
re-link.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException

logger = logging.getLogger(__name__)

BGG_LOGIN_URL = "https://boardgamegeek.com/login/api/v1"
BGG_USER_AGENT = "vibelab-boardgame-buddy/1.0"
_LOGIN_TIMEOUT = 15.0
# Used only when BGG's response omits Expires=. 14d is conservative — real
# SessionID cookies usually last ~30d.
_DEFAULT_SESSION_LIFETIME = timedelta(days=14)


# ── Encryption ───────────────────────────────────────────────────────────────


def _fernet() -> Fernet:
    """Build a Fernet from BGG_CREDENTIAL_KEY. Raises 500 if not configured."""
    key = os.getenv("BGG_CREDENTIAL_KEY")
    if not key:
        logger.error("BGG_CREDENTIAL_KEY is not set; cannot encrypt BGG passwords")
        raise HTTPException(
            status_code=500,
            detail="Server is missing BGG_CREDENTIAL_KEY; ask the admin to configure it.",
        )
    try:
        return Fernet(key.encode("utf-8"))
    except (ValueError, TypeError) as exc:
        logger.error("BGG_CREDENTIAL_KEY is not a valid Fernet key: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="BGG_CREDENTIAL_KEY is not a valid Fernet key.",
        )


def encrypt_password(plain: str) -> str:
    """Fernet-encrypt a plaintext password into an opaque token (utf-8 string)."""
    return _fernet().encrypt(plain.encode("utf-8")).decode("utf-8")


def decrypt_password(token: str) -> str:
    """Decrypt a Fernet token. Raises 500 if the key has rotated / token is bad."""
    try:
        return _fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        logger.warning("BGG password decrypt failed — likely a rotated BGG_CREDENTIAL_KEY")
        raise HTTPException(
            status_code=409,
            detail="BGG re-link required: stored credentials can no longer be decrypted.",
        )


# ── Login ────────────────────────────────────────────────────────────────────


@dataclass
class BggSession:
    """The bits we need to authenticate subsequent xmlapi2 requests as a user."""
    session_id: str
    expires_at: datetime  # UTC
    user_cookie: str  # bggusername cookie value
    pass_cookie: str  # bggpassword cookie value (BGG-side hash, not plaintext)


def _cookie_expiry(cookie_jar: httpx.Cookies, name: str) -> datetime | None:
    """Pull the Expires attribute off a cookie in an httpx jar.

    httpx exposes cookie metadata via the underlying RequestsCookieJar; the
    cleanest way to grab Expires is to walk the jar's internal storage.
    """
    for cookie in cookie_jar.jar:
        if cookie.name == name and cookie.expires:
            return datetime.fromtimestamp(cookie.expires, tz=timezone.utc)
    return None


def _parse_set_cookie_expiry(set_cookie_headers: list[str], name: str) -> datetime | None:
    """Fallback parser if the cookie jar didn't surface an expiry.

    httpx hands us raw Set-Cookie headers via response.headers.get_list();
    parse the Expires=… attribute manually.
    """
    needle = f"{name}="
    for raw in set_cookie_headers:
        if not raw.startswith(needle):
            continue
        for part in raw.split(";"):
            part = part.strip()
            if part.lower().startswith("expires="):
                try:
                    return parsedate_to_datetime(part.split("=", 1)[1]).astimezone(timezone.utc)
                except (TypeError, ValueError):
                    return None
    return None


async def login_to_bgg(username: str, password: str) -> BggSession:
    """Exchange BGG credentials for a session.

    POSTs to https://boardgamegeek.com/login/api/v1 with the JSON body BGG's
    web frontend uses, captures the Set-Cookie response, and returns a typed
    session. Maps a 401/403 to a 400 the FE can surface to the user.
    """
    body = {"credentials": {"username": username, "password": password}}
    headers = {
        "User-Agent": BGG_USER_AGENT,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=_LOGIN_TIMEOUT, headers=headers) as client:
            resp = await client.post(BGG_LOGIN_URL, json=body)
    except httpx.HTTPError as exc:
        logger.warning("BGG login network error for %r: %s", username, exc)
        raise HTTPException(
            status_code=503,
            detail="BoardGameGeek is temporarily unreachable. Try again in a moment.",
        )

    if resp.status_code in (401, 403):
        raise HTTPException(
            status_code=400,
            detail="BGG login failed — check your username and password.",
        )
    if resp.status_code >= 400:
        logger.warning(
            "BGG login returned %s for %r: %s",
            resp.status_code, username, resp.text[:200],
        )
        raise HTTPException(
            status_code=502,
            detail=f"BoardGameGeek login returned HTTP {resp.status_code}.",
        )

    session_id = resp.cookies.get("SessionID")
    user_cookie = resp.cookies.get("bggusername") or username
    pass_cookie = resp.cookies.get("bggpassword") or ""

    if not session_id:
        # Some BGG responses succeed without setting SessionID when the password
        # is wrong (they 200 with no cookies). Treat as a credential failure.
        raise HTTPException(
            status_code=400,
            detail="BGG login failed — check your username and password.",
        )

    raw_set_cookies = resp.headers.get_list("set-cookie")
    expires_at = (
        _cookie_expiry(resp.cookies, "SessionID")
        or _parse_set_cookie_expiry(raw_set_cookies, "SessionID")
        # Fallback: BGG's typical SessionID lifetime is a few weeks. Assume
        # 14 days so we still refresh proactively if no Expires came back.
        or datetime.now(tz=timezone.utc).replace(microsecond=0)
        + _DEFAULT_SESSION_LIFETIME
    )

    return BggSession(
        session_id=session_id,
        expires_at=expires_at,
        user_cookie=user_cookie,
        pass_cookie=pass_cookie,
    )
