"""
jwt_auth.py — JWT verification for BoardgameBuddy's API.

Verifies JWTs from EITHER issuer, selected per-token by its `iss` claim:

  * Supabase Auth, against the project's published JWKS, `aud=authenticated`
  * GCP Identity Platform (Firebase Auth), against Google's shared JWKS, with
    `aud` and `iss` both scoped to GCP_PROJECT_ID

Both are live at once on purpose — a hard swap would 401 every signed-in
browser the moment it deployed. See the block above _is_firebase_token.

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
from typing import Optional

import jwt
from jwt import PyJWKClient
from fastapi import HTTPException, Header, Request
from pydantic import BaseModel

from auth import extract_bearer_token

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
_JWKS_URL = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else ""

# PyJWKClient caches the JWK set for `lifespan` seconds and re-fetches it with a
# blocking urllib.request.urlopen. The default 30s timeout is far too long for
# something that runs inside a request: this service is one uvicorn worker
# shared by ten apps, so a slow JWKS response would stall the whole event loop
# for half a minute. 5s is generous for a CDN-served static document, and a
# failure surfaces as a 401 the client retries rather than a hung request.
_JWKS_TIMEOUT_S = 5
_jwks_client = PyJWKClient(_JWKS_URL, timeout=_JWKS_TIMEOUT_S) if _JWKS_URL else None

# --- GCP Identity Platform (Firebase Auth) -----------------------------------
#
# Both issuers are accepted, and that is deliberate rather than transitional
# sloppiness. MIGRATION_PLAN.md 3-ALT.4 says to "point _JWKS_URL at Google's",
# i.e. swap. A swap cannot be deployed safely: the instant it lands, every
# signed-in browser holding a Supabase token starts getting 401s, and the only
# way back is a second deploy. Accepting both means the frontend swap and the
# backend swap do not have to be simultaneous, and a rollback of the frontend
# needs no backend change at all.
#
# Routing by issuer is safe because the issuer is then VERIFIED by the verifier
# it selected. A token claiming Google's issuer is checked against Google's
# keys, Google's `iss` and this project's `aud` — a forged claim just picks the
# verifier that rejects it. What must never happen is selecting a verifier and
# then not enforcing the issuer, which is why `issuer=` is passed below.
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


def _is_firebase_token(token: str) -> bool:
    """Read `iss` WITHOUT verifying, purely to choose a verifier.

    Nothing is trusted from this decode. See the note above: the selected
    verifier re-checks the issuer under a signature.
    """
    try:
        claims = jwt.decode(token, options={"verify_signature": False})
    except jwt.InvalidTokenError:
        return False
    return str(claims.get("iss", "")).startswith(_FB_ISSUER_PREFIX)


class SupabaseUser(BaseModel):
    """Decoded Supabase Auth JWT payload."""
    sub: str          # user UUID
    email: str
    role: str = ""    # e.g. "authenticated"


async def get_current_supabase_user(
    request: Request = None,  # noqa: RUF013 — optional so non-HTTP callers still work
    authorization: Optional[str] = Header(None),
) -> SupabaseUser:
    """FastAPI dependency: extract and verify a Supabase-issued JWT.

    Raises 401 if the token is missing, malformed, or invalid.
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

    # Firebase's audience is the project id and its issuer is project-scoped, so
    # both are required: without `audience` any Google-issued token from any
    # project would verify, since every Firebase project signs with the same
    # shared Google keys.
    if _is_firebase_token(token):
        if not _fb_jwks_client:
            raise HTTPException(status_code=500, detail="GCP_PROJECT_ID not configured")
        jwks_client = _fb_jwks_client
        decode_kwargs = {"audience": GCP_PROJECT_ID, "issuer": _FB_ISSUER}
    else:
        if not _jwks_client:
            raise HTTPException(status_code=500, detail="SUPABASE_URL not configured")
        jwks_client = _jwks_client
        decode_kwargs = {"audience": "authenticated"}

    try:
        # to_thread because get_signing_key_from_jwt does a BLOCKING urllib
        # fetch whenever the cached JWK set has aged past its 300s lifespan.
        # Called inline, that stalls the single event loop this service runs on
        # — every app, every in-flight request — once every five minutes and
        # again on every cold start.
        signing_key = await asyncio.to_thread(jwks_client.get_signing_key_from_jwt, token)
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256", "RS256"],
            **decode_kwargs,
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
        sub=payload.get("sub", ""),
        email=payload.get("email", ""),
        role=payload.get("role", ""),
    )
    if state is not None:
        state.supabase_user = user
    return user
