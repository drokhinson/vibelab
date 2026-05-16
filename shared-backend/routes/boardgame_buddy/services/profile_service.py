"""Public profile reads.

Profiles are fully public — anyone signed in can pull anyone else's profile +
stats + collection. Privacy is by-product-decision (per the redesign plan),
not enforced here.
"""

from fastapi import HTTPException

from ..models import PublicProfileResponse
from . import buddy_service


def fetch_public_profile(sb, viewer_id: str, target_id: str) -> PublicProfileResponse:
    rows = (
        sb.table("boardgamebuddy_profiles")
        .select("id, display_name, avatar_url, created_at")
        .eq("id", target_id)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    p = rows.data[0]
    rel = buddy_service.relation_to(sb, viewer_id, target_id)
    return PublicProfileResponse(
        id=p["id"],
        display_name=p["display_name"],
        avatar_url=p.get("avatar_url"),
        created_at=p["created_at"],
        is_buddy=bool(rel["is_buddy"]),
        has_pending_request=bool(rel["has_pending_request"]),
        pending_request_direction=rel["pending_request_direction"],
    )
