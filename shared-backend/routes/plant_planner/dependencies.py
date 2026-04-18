"""FastAPI dependencies for PlantPlanner."""

from fastapi import Depends, HTTPException
from pydantic import BaseModel

from db import get_supabase
from jwt_auth import SupabaseUser, get_current_supabase_user


class CurrentUser(BaseModel):
    """App-level user context resolved from a Supabase Auth JWT."""
    user_id: str
    display_name: str


async def get_current_user(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> CurrentUser:
    """Resolve a Supabase Auth user to a PlantPlanner profile.

    Raises 404 if the profile row is missing — the frontend then redirects
    to the profile-setup view to collect a display name.
    """
    sb = get_supabase()
    result = (
        sb.table("plantplanner_profiles")
        .select("id, display_name")
        .eq("id", su_user.sub)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not set up")
    row = result.data[0]
    return CurrentUser(user_id=row["id"], display_name=row["display_name"])
