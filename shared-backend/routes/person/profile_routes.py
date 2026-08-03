"""Profile routes for the personal page: public read + admin-gated update.

The profile is a singleton row (person_profile.id = 1) powering the header block
on landing/about.html. Photo editing is out of scope for now — photo_path is
returned on reads but not accepted on writes (reserved for future bucket storage).
"""

from datetime import datetime, timezone
from typing import Optional

from fastapi import Header, HTTPException

from auth import require_admin
from db import get_supabase

from . import router
from .models import ProfileResponse, UpdateProfileBody

# The profile is a single pinned row.
_PROFILE_ID = 1
_PROFILE_COLS = "name, role, bio, photo_path"


@router.get(
    "/profile",
    response_model=ProfileResponse,
    status_code=200,
    summary="Get the about-page profile",
)
async def get_profile() -> dict:
    """Public: the single profile block (name, role, bio, photo)."""
    sb = get_supabase()
    result = (
        sb.table("person_profile")
        .select(_PROFILE_COLS)
        .eq("id", _PROFILE_ID)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    return result.data[0]


@router.put(
    "/admin/profile",
    response_model=ProfileResponse,
    status_code=200,
    summary="Update the about-page profile",
)
async def update_profile(
    body: UpdateProfileBody,
    authorization: Optional[str] = Header(None),
) -> dict:
    """Admin: update the profile block. Only non-null fields are changed."""
    require_admin(authorization)
    sb = get_supabase()

    update_data: dict = {}
    for field in ["name", "role", "bio"]:
        val = getattr(body, field)
        if val is not None:
            update_data[field] = val

    if update_data:
        update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
        result = (
            sb.table("person_profile")
            .update(update_data)
            .eq("id", _PROFILE_ID)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to update profile")

    updated = (
        sb.table("person_profile")
        .select(_PROFILE_COLS)
        .eq("id", _PROFILE_ID)
        .execute()
    )
    if not updated.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    return updated.data[0]
