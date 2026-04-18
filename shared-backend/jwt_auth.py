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

import os
from typing import Optional

import jwt
from jwt import PyJWKClient
from fastapi import HTTPException, Header
from pydantic import BaseModel

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
_JWKS_URL = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else ""
_jwks_client = PyJWKClient(_JWKS_URL) if _JWKS_URL else None


class SupabaseUser(BaseModel):
    """Decoded Supabase Auth JWT payload."""
    sub: str          # user UUID
    email: str
    role: str = ""    # e.g. "authenticated"


async def get_current_supabase_user(
    authorization: Optional[str] = Header(None),
) -> SupabaseUser:
    """FastAPI dependency: extract and verify a Supabase-issued JWT.

    Raises 401 if the token is missing, malformed, or invalid.
    """
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header required")

    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Authorization must be: Bearer <token>")

    token = parts[1]

    if not _jwks_client:
        raise HTTPException(status_code=500, detail="SUPABASE_URL not configured")

    try:
        signing_key = _jwks_client.get_signing_key_from_jwt(token).key
        payload = jwt.decode(
            token,
            signing_key,
            algorithms=["ES256", "RS256"],
            audience="authenticated",
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    return SupabaseUser(
        sub=payload.get("sub", ""),
        email=payload.get("email", ""),
        role=payload.get("role", ""),
    )
