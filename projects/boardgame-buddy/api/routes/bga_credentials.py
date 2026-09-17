"""Per-user Board Game Arena auth: password encryption + cookie-session login.

The sibling of `bgg_credentials.py`, and deliberately close to it — same Fernet
shape, same "store the password so a dead cookie can be replaced silently"
bargain, same three-state auth readout. Read that file first; only the
differences are argued here.

Flow:
  1. User links BGA in the import wizard → backend GETs the login page for its
     CSRF token, then POSTs the credentials.
  2. BGA responds with session cookies.
  3. We persist the cookies + an encrypted copy of the password on the profile.
  4. fetch_bga_as_user() loads the cookies. If they're missing or expired, it
     decrypts the password and re-runs login transparently.

FOUR DIFFERENCES FROM THE BGG VERSION, none cosmetic:

  * ITS OWN KEY. `BGA_CREDENTIAL_KEY`, not `BGG_CREDENTIAL_KEY`. Rotating one
    must not orphan the other's stored passwords and force an unrelated
    re-link.
  * ONE COOKIE BLOB. BGG got three named columns because its cookie names were
    known in advance. BGA's are not documented, so the whole jar goes into
    `bga_session_cookies` JSONB. Three named columns would bake in a guess.
  * STATUS CODES DECIDE NOTHING. BGA answers a rejected password with HTTP 200
    and an error in the body, so classification happens in
    `bga_endpoints.login_result()` and this module only maps the outcome.
  * TWO-FACTOR IS ITS OWN ANSWER. An importer cannot supply a second factor.
    Saying "check your password" to somebody with 2FA on sends them round a
    loop with no exit, so it gets its own message.

The encryption key is a Fernet key (urlsafe base64). Rotating it invalidates
every stored password — users will be forced to re-link.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException

from api_logger import log_external_call

from . import bga_endpoints as bga

logger = logging.getLogger(__name__)

_LOGIN_TIMEOUT = 20.0
# BGA does not publish a session lifetime and its cookies often carry no
# Expires at all. Two weeks is conservative: the cost of being wrong low is one
# transparent re-login, and the cost of being wrong high is a request that
# fails as "signed out" and has to retry anyway.
_DEFAULT_SESSION_LIFETIME = timedelta(days=14)


# ── Encryption ───────────────────────────────────────────────────────────────


def _fernet() -> Fernet:
    """Build a Fernet from BGA_CREDENTIAL_KEY. Raises 500 if not configured."""
    key = os.getenv("BGA_CREDENTIAL_KEY")
    if not key:
        logger.error("BGA_CREDENTIAL_KEY is not set; cannot encrypt BGA passwords")
        raise HTTPException(
            status_code=500,
            detail="Server is missing BGA_CREDENTIAL_KEY; ask the admin to configure it.",
        )
    try:
        return Fernet(key.encode("utf-8"))
    except (ValueError, TypeError) as exc:
        logger.error("BGA_CREDENTIAL_KEY is not a valid Fernet key: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="BGA_CREDENTIAL_KEY is not a valid Fernet key.",
        )


def encrypt_password(plain: str) -> str:
    """Fernet-encrypt a plaintext password into an opaque token (utf-8 string)."""
    return _fernet().encrypt(plain.encode("utf-8")).decode("utf-8")


def decrypt_password(token: str) -> str:
    """Decrypt a Fernet token. Raises 409 if the key has rotated / token is bad."""
    try:
        return _fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        logger.warning("BGA password decrypt failed — likely a rotated BGA_CREDENTIAL_KEY")
        raise HTTPException(
            status_code=409,
            detail="Board Game Arena re-link required: stored credentials can no longer be decrypted.",
        )


# ── Login ────────────────────────────────────────────────────────────────────


@dataclass
class BgaSession:
    """The bits we need to authenticate subsequent BGA requests as a user."""

    cookies: dict[str, str]
    expires_at: datetime  # UTC
    player_id: str | None


def _cookie_expiry(jar: httpx.Cookies) -> datetime | None:
    """The soonest real expiry in the jar, if any cookie carries one.

    The SOONEST rather than the latest: the jar dies when its first
    load-bearing cookie does, and refreshing early costs one login where
    refreshing late costs a failed import.
    """
    stamps = [
        datetime.fromtimestamp(c.expires, tz=timezone.utc)
        for c in jar.jar
        if c.expires
    ]
    return min(stamps) if stamps else None


# Cookies BGA sets that carry no session authority. Excluded so a jar of pure
# analytics never reads as a successful login.
_IGNORED_COOKIES = frozenset({"_ga", "_gid", "_gat", "__cf_bm", "cf_clearance"})


def _session_cookies(resp: httpx.Response) -> dict[str, str]:
    """Every cookie worth keeping, as a plain dict for the JSONB column."""
    return {
        name: value
        for name, value in resp.cookies.items()
        if name not in _IGNORED_COOKIES and value
    }


def _dry_run_session() -> BgaSession:
    """The session a dry run hands back, from the `login` fixture.

    Raises rather than inventing one when no fixture is configured: a silent
    fake session would make the next call fail somewhere far less obvious.
    """
    body = bga.fixture("login")
    if body is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "BGA_DRY_RUN is on but no login fixture was found. Set "
                "BGA_FIXTURE_DIR to a directory holding login.json, or set "
                "BGA_DRY_RUN=false to talk to Board Game Arena."
            ),
        )
    cookies = {"PHPSESSID": "dry-run"}
    result = bga.login_result(200, body, cookies)
    if result.outcome is not bga.BgaLoginOutcome.OK:
        raise HTTPException(
            status_code=400,
            detail="Board Game Arena didn't accept that username and password.",
        )
    logger.info("BGA dry run: login served from fixture, nothing sent")
    return BgaSession(
        cookies=cookies,
        expires_at=datetime.now(tz=timezone.utc).replace(microsecond=0)
        + _DEFAULT_SESSION_LIFETIME,
        player_id=result.player_id,
    )


async def login_to_bga(username: str, password: str) -> BgaSession:
    """Exchange BGA credentials for a session.

    GETs the login page for its CSRF token, POSTs the form BGA's own login
    submits, and classifies the answer through `bga_endpoints.login_result`
    rather than by status code — see this module's docstring.
    """
    if bga.dry_run_enabled():
        return _dry_run_session()

    headers = bga.default_headers()

    try:
        async with httpx.AsyncClient(
            timeout=_LOGIN_TIMEOUT, headers=headers, follow_redirects=True
        ) as client:
            page = await client.get(bga.url(bga.LOGIN_PAGE_PATH))
            token = bga.parse_request_token(page.text)

            form = bga.login_form(username, password, token)
            async with log_external_call(
                app="boardgame-buddy",
                api_name="bga-login",
                method="POST",
                url=bga.url(bga.LOGIN_PATH),
                # Passed as params, NOT as a pre-encoded body string: redaction
                # only reaches structured params, and a body string would carry
                # the password into api_logs verbatim.
                params=form,
                redact_params=("password", "request_token"),
            ) as record:
                resp = await client.post(bga.url(bga.LOGIN_PATH), data=form)
                record.attach_response(resp)
    except httpx.HTTPError as exc:
        logger.warning("BGA login network error for %r: %s", username, exc)
        raise HTTPException(
            status_code=503,
            detail="Board Game Arena is temporarily unreachable. Try again in a moment.",
        )

    cookies = _session_cookies(resp)
    result = bga.login_result(resp.status_code, resp.text, cookies)

    if result.outcome is bga.BgaLoginOutcome.BAD_CREDENTIALS:
        raise HTTPException(
            status_code=400,
            detail="Board Game Arena didn't accept that username and password.",
        )
    if result.outcome is bga.BgaLoginOutcome.NEEDS_2FA:
        raise HTTPException(
            status_code=400,
            detail=(
                "This Board Game Arena account has two-factor sign-in turned on, "
                "which the importer can't answer."
            ),
        )
    if result.outcome is bga.BgaLoginOutcome.THROTTLED:
        raise HTTPException(
            status_code=429,
            detail="Board Game Arena is rate-limiting us right now. Wait a few minutes and try again.",
        )
    if result.outcome is not bga.BgaLoginOutcome.OK:
        # Status and URL only. BGA's error pages can carry the account's own
        # email or handle, and api_logs is not the place for either.
        logger.warning("BGA login returned an unrecognised answer: HTTP %s", resp.status_code)
        raise HTTPException(
            status_code=502,
            detail=f"Board Game Arena's sign-in returned HTTP {resp.status_code}.",
        )

    expires_at = _cookie_expiry(resp.cookies) or (
        datetime.now(tz=timezone.utc).replace(microsecond=0) + _DEFAULT_SESSION_LIFETIME
    )

    return BgaSession(cookies=cookies, expires_at=expires_at, player_id=result.player_id)
