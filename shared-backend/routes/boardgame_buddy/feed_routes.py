"""Feed endpoints — the Strava-style home view.

Thin adapter over services/feed_service.py. The Feed page composes:
  - plays from accepted buddies + self (chronological)
  - hot games this week (first page)
  - suggested buddies (first page)
  - featured-from-collection (first page)

The three rails are embedded in the /feed response by
feed_service.build_feed_page; they have no standalone endpoints.
"""

from typing import Optional

from fastapi import Depends, Query

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import FeedPageResponse
from .services import feed_service


@router.get(
    "/feed",
    response_model=FeedPageResponse,
    status_code=200,
    summary="Strava-style chronological feed",
)
async def get_feed(
    cursor: Optional[str] = Query(
        None,
        description="Composite \"played_at|created_at\" cursor returned by the previous page",
    ),
    limit: int = Query(20, ge=1, le=50, description="Plays per page"),
    user: CurrentUser = Depends(get_current_user),
) -> FeedPageResponse:
    """Return a page of mixed feed cards visible to the current user."""
    return feed_service.build_feed_page(
        get_supabase(),
        user.user_id,
        cursor=cursor,
        limit=limit,
    )
