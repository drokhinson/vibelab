"""FastAPI dependencies for Travel Scrapbook."""

import re
from typing import Optional

from fastapi import Depends
from pydantic import BaseModel

from api_logger import set_request_user
from db import get_supabase
from jwt_auth import SupabaseUser, get_current_supabase_user

from .constants import APP_NAME

_USERNAME_RE = re.compile(r"[^a-z0-9_]")


def _derive_username(sb, email: Optional[str], user_id: str) -> str:
    """Pick an unused username handle for a new profile.

    Lower-case the email local-part, strip everything that's not [a-z0-9_],
    pad if too short, then probe for collisions by appending an incrementing
    numeric suffix. Empty/bogus input falls back to ``user_<8-char uuid>``.
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
            sb.table("travelscrapbook_profiles")
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
    """Resolve Supabase Auth user to a Travel Scrapbook profile.

    Auto-creates the profile row on first login.
    """
    sb = get_supabase()
    result = (
        sb.table("travelscrapbook_profiles")
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
        display_name = su_user.email.split("@")[0] if su_user.email else "traveler"
        username = _derive_username(sb, su_user.email, su_user.sub)
        sb.table("travelscrapbook_profiles").insert({
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
