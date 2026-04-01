"""FastAPI dependencies for BoardgameBuddy."""

from fastapi import Depends
from pydantic import BaseModel

from jwt_auth import SupabaseUser, get_current_supabase_user
from db import get_supabase


class CurrentUser(BaseModel):
    """App-level user context."""
    user_id: str
    display_name: str


async def get_current_user(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> CurrentUser:
    """Resolve Supabase Auth user to a BoardgameBuddy profile.

    Auto-creates the profile row on first login.
    """
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_profiles")
        .select("id, display_name")
        .eq("id", su_user.sub)
        .execute()
    )

    if result.data:
        row = result.data[0]
        return CurrentUser(user_id=row["id"], display_name=row["display_name"])

    # Auto-create profile on first auth
    display_name = su_user.email.split("@")[0]
    sb.table("boardgamebuddy_profiles").insert({
        "id": su_user.sub,
        "display_name": display_name,
    }).execute()

    return CurrentUser(user_id=su_user.sub, display_name=display_name)
