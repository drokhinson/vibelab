"""
jwt_auth.py — Shared Supabase Auth JWT verification for the vibelab backend.

Verifies JWTs issued by Supabase Auth using the project's published JWKS
(asymmetric signing keys). This is the pilot pattern — all future apps
should use this instead of custom JWT auth.

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

    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header required")

    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Authorization must be: Bearer <token>")

    token = parts[1]

    if not _jwks_client:
        raise HTTPException(status_code=500, detail="SUPABASE_URL not configured")

    try:
        # to_thread because get_signing_key_from_jwt does a BLOCKING urllib
        # fetch whenever the cached JWK set has aged past its 300s lifespan.
        # Called inline, that stalls the single event loop this service runs on
        # — every app, every in-flight request — once every five minutes and
        # again on every cold start.
        signing_key = await asyncio.to_thread(_jwks_client.get_signing_key_from_jwt, token)
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256", "RS256"],
            audience="authenticated",
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
