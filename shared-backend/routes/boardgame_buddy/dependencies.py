"""FastAPI dependencies for BoardgameBuddy."""

import re
from typing import Optional

from fastapi import Depends, HTTPException
from pydantic import BaseModel

from api_logger import set_request_user
from jwt_auth import SupabaseUser, get_current_supabase_user
from db import get_supabase

APP_NAME = "boardgame-buddy"

_USERNAME_RE = re.compile(r"[^a-z0-9_]")


def _derive_username(sb, email: Optional[str], user_id: str) -> str:
    """Pick an unused username handle for a new profile.

    Mirrors migration 017's backfill: lower-case the email local-part,
    strip everything that's not [a-z0-9_], pad if too short, then probe
    for collisions by appending an incrementing numeric suffix. Empty/
    bogus input falls back to ``user_<8-char uuid prefix>``.
    """
    base = ""
    if email:
        local = email.split("@", 1)[0].lower()
        base = _USERNAME_RE.sub("", local)
    if not base:
        base = f"user_{user_id.replace('-', '')[:8]}"
    if len(base) < 3:
        base = base.ljust(3, "0")
    if len(base) > 30:
        base = base[:30]

    candidate = base
    n = 2
    while True:
        existing = (
            sb.table("boardgamebuddy_profiles")
            .select("id")
            .eq("username", candidate)
            .limit(1)
            .execute()
        )
        if not existing.data:
            return candidate
        suffix = str(n)
        candidate = base[: 30 - len(suffix)] + suffix
        n += 1


class CurrentUser(BaseModel):
    """App-level user context."""
    user_id: str
    display_name: str
    username: str
    is_admin: bool = False


async def get_current_user(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> CurrentUser:
    """Resolve Supabase Auth user to a BoardgameBuddy profile.

    Auto-creates the profile row on first login.
    """
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_profiles")
        .select("id, display_name, username, is_admin")
        .eq("id", su_user.sub)
        .execute()
    )

    if result.data:
        row = result.data[0]
        user = CurrentUser(
            user_id=row["id"],
            display_name=row["display_name"],
            username=row["username"],
            is_admin=bool(row.get("is_admin", False)),
        )
    else:
        # Auto-create profile on first auth. display_name starts at the
        # email local-part (matches old behaviour); username is the
        # stable handle, picked once and never reassigned.
        display_name = su_user.email.split("@")[0] if su_user.email else "user"
        username = _derive_username(sb, su_user.email, su_user.sub)
        sb.table("boardgamebuddy_profiles").insert({
            "id": su_user.sub,
            "display_name": display_name,
            "username": username,
        }).execute()
        user = CurrentUser(
            user_id=su_user.sub,
            display_name=display_name,
            username=username,
            is_admin=False,
        )

    await set_request_user(
        user_id=user.user_id,
        user_label=user.display_name or su_user.email,
        app=APP_NAME,
    )
    return user


async def get_current_admin(
    user: CurrentUser = Depends(get_current_user),
) -> CurrentUser:
    """Same as get_current_user, but 403s if the profile isn't an admin."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return user


async def maybe_supabase_user(authorization: Optional[str]) -> Optional[SupabaseUser]:
    """Decode the bearer token if present; return None when missing or invalid.

    For anon-friendly endpoints that surface a richer per-user view to signed-in
    callers without forcing auth.
    """
    if not authorization:
        return None
    try:
        return await get_current_supabase_user(authorization=authorization)
    except HTTPException:
        return None
