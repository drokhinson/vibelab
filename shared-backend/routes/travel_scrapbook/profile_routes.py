"""Health, profile bootstrap, and profile edits."""

from fastapi import Depends

import cache
from db import get_supabase
from shared_models import HealthResponse

from . import router
from .constants import CACHE_NS_CATEGORIES, CATEGORIES_TTL_SECONDS
from .dependencies import CurrentUser, get_current_user
from .models import CategoryResponse, ProfileResponse, ProfileUpdateRequest

cache.configure(CACHE_NS_CATEGORIES, max_entries=4)


def load_categories() -> list[CategoryResponse]:
    """Category option set, cached (it changes only via migration)."""
    cached = cache.get(CACHE_NS_CATEGORIES, "all")
    if cached is not None:
        return cached
    sb = get_supabase()
    rows = (
        sb.table("travelscrapbook_categories")
        .select("slug, label, icon, sort_order")
        .order("sort_order")
        .execute()
    )
    categories = [CategoryResponse(**r) for r in (rows.data or [])]
    cache.set(CACHE_NS_CATEGORIES, "all", categories, CATEGORIES_TTL_SECONDS)
    return categories


@router.get(
    "/health",
    response_model=HealthResponse,
    status_code=200,
    summary="Health check",
)
async def health() -> HealthResponse:
    """Liveness probe for the travel-scrapbook routes."""
    return HealthResponse(project="travel-scrapbook", status="ok")


@router.get(
    "/me",
    response_model=ProfileResponse,
    status_code=200,
    summary="Profile bootstrap",
)
async def get_me(user: CurrentUser = Depends(get_current_user)) -> ProfileResponse:
    """Current profile (auto-created on first login) plus the category set."""
    return ProfileResponse(
        user_id=user.user_id,
        display_name=user.display_name,
        username=user.username,
        is_admin=user.is_admin,
        categories=load_categories(),
    )


@router.patch(
    "/me",
    response_model=ProfileResponse,
    status_code=200,
    summary="Update profile",
)
async def update_me(
    body: ProfileUpdateRequest,
    user: CurrentUser = Depends(get_current_user),
) -> ProfileResponse:
    """Update the display name."""
    sb = get_supabase()
    sb.table("travelscrapbook_profiles").update(
        {"display_name": body.display_name}
    ).eq("id", user.user_id).execute()
    return ProfileResponse(
        user_id=user.user_id,
        display_name=body.display_name,
        username=user.username,
        is_admin=user.is_admin,
        categories=load_categories(),
    )
