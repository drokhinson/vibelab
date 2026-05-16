"""Unified game search endpoint.

The redesign replaces the previous separate /games?search=... + /games/search-bgg
pair with a single ranked /search endpoint that puts collection hits first,
then DB matches; BGG hits are fetched only when the caller passes
include_bgg=true (used when the user taps "Search BoardGameGeek for more").
"""

from fastapi import Depends, Query

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import UnifiedSearchResponse
from .services import search_service


@router.get(
    "/search",
    response_model=UnifiedSearchResponse,
    status_code=200,
    summary="Unified game search (collection → DB → optional BGG)",
)
async def unified_search(
    q: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(20, ge=1, le=50, description="Max hits per source"),
    include_bgg: bool = Query(
        False,
        description="If true, additionally search BoardGameGeek (slower).",
    ),
    user: CurrentUser = Depends(get_current_user),
) -> UnifiedSearchResponse:
    """Single ranked search list. Pass include_bgg=true to fetch BGG too."""
    return await search_service.unified_search(
        get_supabase(),
        user.user_id,
        q,
        limit=limit,
        include_bgg=include_bgg,
    )
