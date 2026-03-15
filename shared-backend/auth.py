"""
auth.py — Shared authentication helpers for the vibelab backend.
Generic bcrypt + JWT utilities. Each app imports these instead of reimplementing.
"""

import bcrypt
import jwt
from fastapi import HTTPException
from typing import Optional


def hash_password(password: str) -> str:
    """Hash a plaintext password with bcrypt."""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    """Check a plaintext password against a bcrypt hash."""
    return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))


def create_token(payload: dict, secret: str, algorithm: str = "HS256") -> str:
    """Create a JWT from an arbitrary payload dict."""
    return jwt.encode(payload, secret, algorithm=algorithm)


def decode_token(token: str, secret: str, algorithm: str = "HS256") -> dict:
    """Decode and validate a JWT. Raises 401 on invalid/expired token."""
    try:
        return jwt.decode(token, secret, algorithms=[algorithm])
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def extract_bearer_token(authorization: Optional[str]) -> str:
    """Parse 'Bearer <token>' from an Authorization header. Raises 401 if missing/malformed."""
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header required")
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Authorization header must be: Bearer <token>")
    return parts[1]
