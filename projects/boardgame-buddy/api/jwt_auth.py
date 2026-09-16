"""
jwt_auth.py — JWT verification for BoardgameBuddy's API.

One issuer: GCP Identity Platform (Firebase Auth), verified against Google's
shared JWKS with `aud` and `iss` both scoped to GCP_PROJECT_ID. Both are
required, not belt-and-braces: every Firebase project signs with the same
Google keys, so without `audience` any Google-issued token from any project
would verify.

THE SUPABASE AUTH VERIFIER IS GONE, and with it the migration's rollback path.
It accepted both issuers so the frontend and backend swaps did not have to be
simultaneous; that stopped being a safety net once post-cutover accounts
existed only in Identity Platform, because rolling back would have orphaned
them. Re-adding it is not a rollback any more — it is a second verifier
surface for an issuer that mints nothing.

The names `SupabaseUser` and `get_current_supabase_user` outlived the provider
they were named for. They are unchanged here on purpose: renaming them is a
mechanical sweep across forty route modules, and doing it in this commit would
bury the one diff worth reading closely.

Usage in route dependencies:
    from jwt_auth import get_current_supabase_user, SupabaseUser

    async def get_current_user(
        su_user: SupabaseUser = Depends(get_current_supabase_user),
    ) -> MyAppUser:
        # Look up / create app-specific profile using su_user.sub
        ...
"""

import asyncio
import os
import re
from typing import Optional

import jwt
from jwt import PyJWKClient
from fastapi import HTTPException, Header, Request
from pydantic import BaseModel

from auth import extract_bearer_token

# PyJWKClient caches the JWK set for `lifespan` seconds and re-fetches it with a
# blocking urllib.request.urlopen. The default 30s timeout is far too long for
# something that runs inside a request, so a slow JWKS response cannot stall
# the event loop for half a minute. 5s is generous for a CDN-served static
# document, and a failure surfaces as a 503 the client retries rather than a
# hung request.
_JWKS_TIMEOUT_S = 5

# --- GCP Identity Platform (Firebase Auth) -----------------------------------
GCP_PROJECT_ID = os.environ.get("GCP_PROJECT_ID", "").strip()
_FB_JWKS_URL = (
    "https://www.googleapis.com/service_accounts/v1/jwk/"
    "securetoken@system.gserviceaccount.com"
)
_FB_ISSUER_PREFIX = "https://securetoken.google.com/"
_FB_ISSUER = f"{_FB_ISSUER_PREFIX}{GCP_PROJECT_ID}" if GCP_PROJECT_ID else ""
_fb_jwks_client = (
    PyJWKClient(_FB_JWKS_URL, timeout=_JWKS_TIMEOUT_S) if GCP_PROJECT_ID else None
)


class SupabaseUser(BaseModel):
    """Decoded Supabase Auth JWT payload."""
    sub: str          # user UUID
    email: str
    role: str = ""    # e.g. "authenticated"


# ── The app's user id, which is not always the token's subject ───────────────
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)


def _app_uid(payload: dict) -> str:
    """The UUID this account is known by in the database.

    `sub` cannot be trusted to be one. The 23 accounts migrated from Supabase
    kept their original UUIDs as their Identity Platform uid, but a brand-new
    account gets a Firebase-generated 28-character uid — and every user-id
    column and RPC parameter in this schema is typed `uuid`. Handing one of
    those straight through produced `invalid input syntax for type uuid` on
    every authenticated endpoint, surfacing as a 500 rather than anything that
    named the cause.

    So the blocking function in `projects/boardgame-buddy/functions/` resolves
    it at sign-in and puts the answer in the `app_uid` claim: the uid itself
    when it is already a UUID, otherwise a deterministic uuid5 of it. This
    reads that claim.

    THE `sub` FALLBACK IS TRANSITIONAL AND DELIBERATELY NARROW. A token minted
    before that function was deployed carries no `app_uid`, and every one of
    those belongs to a migrated account whose `sub` IS a UUID — so accepting a
    UUID-shaped `sub` keeps existing sessions alive across the rollout instead
    of signing everybody out for up to an hour. It cannot rescue a new account,
    because a Firebase uid does not match the pattern.

    DO NOT remove the fallback on the "ID tokens last an hour" reasoning that
    first justified it — that reasoning is wrong, and it was nearly acted on.
    `beforeUserSignedIn` runs at SIGN-IN, not on refresh, so it is the SESSION
    that has to turn over, not the token: an account that last signed in before
    the function was deployed and has been refreshing ever since has no
    persisted `app_uid`, and its refreshed ID tokens carry none either. Its
    `sub` is a UUID, so this fallback is the only thing serving it.

    The real condition is that every account has signed in at least once since
    the function was deployed — which happens on its own, since each sign-in
    persists the claim. Until then, removing this signs those accounts out with
    a 401 they cannot clear by retrying.

    Anything else is a 401, not a 500. An unusable identity is a bad
    credential, not a server fault, and saying so sends the client to its
    sign-in path rather than its retry ladder.
    """
    claimed = str(payload.get("app_uid") or "").strip()
    if _UUID_RE.match(claimed):
        return claimed.lower()
    sub = str(payload.get("sub") or "").strip()
    if _UUID_RE.match(sub):
        return sub.lower()
    raise HTTPException(
        status_code=401,
        detail="Token carries no usable app identity",
    )


async def get_current_supabase_user(
    request: Request = None,  # noqa: RUF013 — optional so non-HTTP callers still work
    authorization: Optional[str] = Header(None),
) -> SupabaseUser:
    """FastAPI dependency: extract and verify an Identity Platform ID token.

    Raises 401 if the token is missing, malformed, expired, or issued by
    anything other than this project — which now includes every Supabase Auth
    token, since that verifier is gone.
    """
    # main.py's api-logger middleware verifies the same token on the way in, to
    # attach the user to the api_logs contextvar. Without this, every
    # authenticated request to a boardgame-buddy / plant-planner / … route paid
    # for two full verifications of one token — and, on a cold worker, two
    # chances to hit the blocking JWKS fetch below. The middleware stashes its
    # result here; this is the same request and the same header, so it is the
    # same answer.
    #
    # Written with an explicit `is not None` rather than an `and` chain: an
    # EMPTY starlette State is falsy (it wraps a dict), so
    # `getattr(request, "state", None) and getattr(...)` short-circuits and
    # hands back the State object itself on the very first request of a worker.
    state = getattr(request, "state", None)
    if state is not None:
        cached = getattr(state, "supabase_user", None)
        if cached is not None:
            return cached

    token = extract_bearer_token(authorization)

    # 500 rather than 401, and deliberately: an unset GCP_PROJECT_ID is an
    # operator error, not a bad credential, and answering 401 would send every
    # signed-in user to the login screen over a missing variable.
    if not _fb_jwks_client:
        raise HTTPException(status_code=500, detail="GCP_PROJECT_ID not configured")

    try:
        # to_thread because get_signing_key_from_jwt does a BLOCKING urllib
        # fetch whenever the cached JWK set has aged past its 300s lifespan.
        # Called inline, that stalls the single event loop this service runs on
        # — every app, every in-flight request — once every five minutes and
        # again on every cold start.
        signing_key = await asyncio.to_thread(
            _fb_jwks_client.get_signing_key_from_jwt, token
        )
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=GCP_PROJECT_ID,
            issuer=_FB_ISSUER,
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    except jwt.PyJWKClientError as e:
        # A JWKS fetch that failed or timed out is not a bad token. Saying 401
        # would send a signed-in user to the login screen over a blip; 503 is
        # what the frontend's retry ladder is built for.
        raise HTTPException(status_code=503, detail="Auth keys unavailable") from e

    user = SupabaseUser(
        sub=_app_uid(payload),
        email=payload.get("email", ""),
        role=payload.get("role", ""),
    )
    if state is not None:
        state.supabase_user = user
    return user
