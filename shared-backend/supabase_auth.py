"""
supabase_auth.py — Shared Supabase Auth helpers for the vibelab backend.
Verifies Supabase-issued JWTs and provides a FastAPI dependency
that replaces per-app custom JWT validation.
"""

import os
from typing import Optional

import jwt
from fastapi import HTTPException, Header


SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "dev-jwt-secret")


async def get_supabase_user(authorization: Optional[str] = Header(None)) -> dict:
    """FastAPI dependency — decode Supabase Auth JWT from Authorization header.

    Returns dict with: user_id (sub), email, user_metadata.
    """
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header required")
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Invalid authorization format")

    try:
        payload = jwt.decode(
            parts[1],
            SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    return {
        "user_id": payload["sub"],
        "email": payload.get("email"),
        "user_metadata": payload.get("user_metadata", {}),
    }
