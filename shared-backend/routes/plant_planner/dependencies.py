"""FastAPI dependencies for PlantPlanner — Supabase Auth-backed user resolution."""

from typing import Optional

from fastapi import Depends, Header, HTTPException
from pydantic import BaseModel

from api_logger import set_request_user
from db import get_supabase
from jwt_auth import SupabaseUser, get_current_supabase_user

APP_NAME = "plant-planner"


class CurrentUser(BaseModel):
    """App-level user context for PlantPlanner."""
    user_id: str
    display_name: str
    is_admin: bool = False


async def get_current_user(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> CurrentUser:
    """Resolve a Supabase Auth user to a PlantPlanner profile (auto-creates on first login)."""
    sb = get_supabase()
    result = (
        sb.table("plantplanner_profiles")
        .select("id, display_name, is_admin")
        .eq("id", su_user.sub)
        .execute()
    )

    if result.data:
        row = result.data[0]
        user = CurrentUser(
            user_id=row["id"],
            display_name=row["display_name"],
            is_admin=bool(row.get("is_admin", False)),
        )
    else:
        display_name = (su_user.email or "").split("@")[0] or "Gardener"
        sb.table("plantplanner_profiles").insert({
            "id": su_user.sub,
            "display_name": display_name,
        }).execute()
        user = CurrentUser(user_id=su_user.sub, display_name=display_name, is_admin=False)

    await set_request_user(
        user_id=user.user_id,
        user_label=user.display_name or su_user.email,
        app=APP_NAME,
    )
    return user


async def maybe_current_user(
    authorization: Optional[str] = Header(None),
) -> Optional[CurrentUser]:
    """Resolve the current user if a valid Supabase token is present, else None."""
    if not authorization:
        return None
    try:
        su_user = await get_current_supabase_user(authorization=authorization)
    except HTTPException:
        return None
    try:
        return await get_current_user(su_user=su_user)
    except HTTPException:
        return None
