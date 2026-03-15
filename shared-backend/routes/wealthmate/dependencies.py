"""Auth helpers and FastAPI dependencies for WealthMate."""

from typing import Optional

from fastapi import HTTPException, Header

from db import get_supabase
from auth import hash_password, verify_password, create_token, decode_token
from .constants import JWT_SECRET, JWT_ALGORITHM


def _hash_password(password: str) -> str:
    return hash_password(password)


def _verify_password(password: str, password_hash: str) -> bool:
    return verify_password(password, password_hash)


def _create_token(user_id: str, username: str, couple_id: Optional[str] = None) -> str:
    return create_token(
        {"user_id": user_id, "username": username, "couple_id": couple_id},
        JWT_SECRET, JWT_ALGORITHM,
    )


def _decode_token(token: str) -> dict:
    return decode_token(token, JWT_SECRET, JWT_ALGORITHM)


def _get_couple_id_for_user(user_id: str) -> Optional[str]:
    """Look up the couple_id for a user, or return None."""
    sb = get_supabase()
    result = (
        sb.table("wealthmate_couple_members")
        .select("couple_id")
        .eq("user_id", user_id)
        .execute()
    )
    if result.data:
        return result.data[0]["couple_id"]
    return None


async def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    """FastAPI dependency — extracts and validates JWT from Authorization header."""
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header required")
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Authorization header must be: Bearer <token>")
    payload = _decode_token(parts[1])
    # Refresh couple_id in case it changed since token was issued
    couple_id = _get_couple_id_for_user(payload["user_id"])
    # Auto-create household if missing (handles users registered before solo-first change)
    if not couple_id:
        sb = get_supabase()
        couple_result = sb.table("wealthmate_couples").insert({}).execute()
        if couple_result.data:
            couple_id = couple_result.data[0]["id"]
            sb.table("wealthmate_couple_members").insert({
                "couple_id": couple_id,
                "user_id": payload["user_id"],
                "role": "owner",
            }).execute()
    payload["couple_id"] = couple_id
    return payload


def _require_couple(user: dict) -> str:
    """Return couple_id or raise 400 if user is not in a couple."""
    couple_id = user.get("couple_id")
    if not couple_id:
        raise HTTPException(status_code=400, detail="You are not part of a couple yet")
    return couple_id
