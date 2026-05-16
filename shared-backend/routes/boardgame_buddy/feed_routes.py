"""Feed endpoints — the Strava-style home view + its component cards.

Thin adapter over services/feed_service.py. The Feed page composes:
  - plays from accepted buddies + self (chronological)
  - hot games this week (first page)
  - suggested buddies (first page)
  - featured-from-collection (first page)
"""

from datetime import datetime
from typing import Optional

from fastapi import Depends, Query

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import (
    FeaturedFromCollectionResponse,
    FeedPageResponse,
    HotGamesResponse,
    SuggestedBuddiesResponse,
)
from .services import feed_service


@router.get(
    "/feed",
    response_model=FeedPageResponse,
    status_code=200,
    summary="Strava-style chronological feed",
)
async def get_feed(
    cursor: Optional[datetime] = Query(
        None,
        description="created_at of the last play on the previous page (omit on first call)",
    ),
    limit: int = Query(20, ge=1, le=50, description="Plays per page"),
    user: CurrentUser = Depends(get_current_user),
) -> FeedPageResponse:
    """Return a page of mixed feed cards visible to the current user."""
    return feed_service.build_feed_page(
        get_supabase(),
        user.user_id,
        before=cursor,
        limit=limit,
    )


@router.get(
    "/hot-games",
    response_model=HotGamesResponse,
    status_code=200,
    summary="Hot games in the last N days",
)
async def get_hot_games(
    window_days: int = Query(7, ge=1, le=90, description="Lookback window"),
    limit: int = Query(10, ge=1, le=50, description="Max entries"),
    user: CurrentUser = Depends(get_current_user),
) -> HotGamesResponse:
    """Most-played games across all users in the recent past."""
    return feed_service.fetch_hot_games(get_supabase(), window_days=window_days, limit=limit)


@router.get(
    "/suggestions/buddies",
    response_model=SuggestedBuddiesResponse,
    status_code=200,
    summary="Suggested buddies (friends-of-friends)",
)
async def get_suggested_buddies(
    limit: int = Query(10, ge=1, le=30, description="Max suggestions"),
    user: CurrentUser = Depends(get_current_user),
) -> SuggestedBuddiesResponse:
    """Users who share at least one accepted buddy with the caller."""
    return feed_service.fetch_suggested_buddies(get_supabase(), user.user_id, limit=limit)


@router.get(
    "/suggestions/featured-from-collection",
    response_model=FeaturedFromCollectionResponse,
    status_code=200,
    summary="Dormant games from the user's own collection",
)
async def get_featured_from_collection(
    days_since: int = Query(60, ge=1, le=365),
    limit: int = Query(5, ge=1, le=20),
    user: CurrentUser = Depends(get_current_user),
) -> FeaturedFromCollectionResponse:
    """Owned games the user hasn't played in `days_since` days."""
    return feed_service.fetch_featured_from_collection(
        get_supabase(),
        user.user_id,
        days_since=days_since,
        limit=limit,
    )
