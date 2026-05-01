"""FastAPI dependencies for SauceBoss — Supabase Auth-backed user resolution."""

from typing import Optional

from fastapi import Depends, Header, HTTPException
from pydantic import BaseModel

from db import get_supabase
from jwt_auth import SupabaseUser, get_current_supabase_user


class CurrentUser(BaseModel):
    """App-level user context for SauceBoss."""
    user_id: str
    display_name: str
    is_admin: bool = False


async def get_current_user(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> CurrentUser:
    """Resolve a Supabase Auth user to a SauceBoss profile (auto-creates on first login)."""
    sb = get_supabase()
    result = (
        sb.table("sauceboss_profiles")
        .select("id, display_name, is_admin")
        .eq("id", su_user.sub)
        .execute()
    )

    if result.data:
        row = result.data[0]
        return CurrentUser(
            user_id=row["id"],
            display_name=row["display_name"],
            is_admin=bool(row.get("is_admin", False)),
        )

    display_name = (su_user.email or "").split("@")[0] or "Saucier"
    sb.table("sauceboss_profiles").insert({
        "id": su_user.sub,
        "display_name": display_name,
    }).execute()

    return CurrentUser(user_id=su_user.sub, display_name=display_name, is_admin=False)


async def get_current_admin(
    user: CurrentUser = Depends(get_current_user),
) -> CurrentUser:
    """Resolve current user; 403 if the profile is not an admin."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return user


async def maybe_current_user(
    authorization: Optional[str] = Header(None),
) -> Optional[CurrentUser]:
    """Resolve the current user if a valid Supabase token is present, else None.

    Used for anon-friendly endpoints that surface a richer per-user view
    when the caller is signed in.
    """
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
