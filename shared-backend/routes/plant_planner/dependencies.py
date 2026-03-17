"""Auth helpers and FastAPI dependencies for PlantPlanner."""

from typing import Optional

from fastapi import HTTPException, Header

from auth import hash_password, verify_password, create_token, decode_token
from .constants import JWT_SECRET, JWT_ALGORITHM


def _hash_password(password: str) -> str:
    return hash_password(password)


def _verify_password(password: str, password_hash: str) -> bool:
    return verify_password(password, password_hash)


def _create_token(user_id: str, username: str) -> str:
    return create_token(
        {"user_id": user_id, "username": username},
        JWT_SECRET, JWT_ALGORITHM,
    )


def _decode_token(token: str) -> dict:
    return decode_token(token, JWT_SECRET, JWT_ALGORITHM)


async def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    """FastAPI dependency — extracts and validates JWT from Authorization header."""
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header required")
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Authorization header must be: Bearer <token>")
    payload = _decode_token(parts[1])
    return payload
