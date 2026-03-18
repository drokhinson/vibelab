"""Auth helpers and FastAPI dependencies for SpotMe."""

from typing import Optional

from fastapi import HTTPException, Header

from auth import hash_password, verify_password, create_token, decode_token, extract_bearer_token
from .constants import JWT_SECRET, JWT_ALGORITHM


def create_app_token(user_id: str, username: str) -> str:
    """Create a JWT with SpotMe-specific payload."""
    return create_token(
        {"user_id": user_id, "username": username},
        JWT_SECRET, JWT_ALGORITHM,
    )


def decode_app_token(token: str) -> dict:
    """Decode a SpotMe JWT."""
    return decode_token(token, JWT_SECRET, JWT_ALGORITHM)


async def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    """FastAPI dependency — extracts and validates JWT from Authorization header."""
    token = extract_bearer_token(authorization)
    return decode_app_token(token)
