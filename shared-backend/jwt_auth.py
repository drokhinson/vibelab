"""
jwt_auth.py — Shared Supabase Auth JWT verification for the vibelab backend.

Verifies JWTs issued by Supabase Auth. This is the pilot pattern —
all future apps should use this instead of custom JWT auth.

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
from fastapi import HTTPException, Header
from pydantic import BaseModel

SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "")


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

    if not SUPABASE_JWT_SECRET:
        raise HTTPException(status_code=500, detail="SUPABASE_JWT_SECRET not configured")

    try:
        payload = jwt.decode(
            token,
            SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
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
