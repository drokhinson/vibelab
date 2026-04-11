"""Auth helpers and FastAPI dependencies for WealthMate."""

from typing import Optional

from fastapi import HTTPException, Header

from db import get_supabase
from supabase_auth import get_supabase_user


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
    """FastAPI dependency — decode Supabase JWT and look up couple membership."""
    auth_user = await get_supabase_user(authorization)
    user_id = auth_user["user_id"]

    # Look up couple membership
    couple_id = _get_couple_id_for_user(user_id)

    # Auto-create household if missing
    if not couple_id:
        sb = get_supabase()
        couple_result = sb.table("wealthmate_couples").insert({}).execute()
        if couple_result.data:
            couple_id = couple_result.data[0]["id"]
            sb.table("wealthmate_couple_members").insert({
                "couple_id": couple_id,
                "user_id": user_id,
                "role": "owner",
            }).execute()

    # Look up username from profile
    sb = get_supabase()
    profile = sb.table("wealthmate_profiles").select("username").eq("id", user_id).execute()
    username = profile.data[0]["username"] if profile.data else ""

    return {
        "user_id": user_id,
        "username": username,
        "couple_id": couple_id,
        "email": auth_user.get("email"),
    }


def _require_couple(user: dict) -> str:
    """Return couple_id or raise 400 if user is not in a couple."""
    couple_id = user.get("couple_id")
    if not couple_id:
        raise HTTPException(status_code=400, detail="You are not part of a couple yet")
    return couple_id
