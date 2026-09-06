""""Buddies you may know" — reading the suggestion lists, and removing from them.

Split out of buddy_routes.py for the same reason ghost_claim_routes.py was:
that file is at the ~300-line ceiling, and a suggestion has its own small
lifecycle (rank → offer → add or dismiss) that reads better in one place than
as three more routes on the end of the buddy graph's CRUD.

Imported BEFORE buddy_routes in __init__.py. No route here actually collides
with one there today — `/buddies/suggested/{user_id}` has three segments and
`/buddies/{edge_id}` has two — but FastAPI resolves by declaration order, and
the literal-before-parameter rule is cheaper to keep than to rediscover.
"""

from fastapi import Depends, Path, Query

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import (
    MessageResponse,
    OnboardingSuggestionsResponse,
    SuggestedBuddiesResponse,
)
from .services import buddy_suggestion_service, feed_service


@router.get(
    "/buddies/suggested",
    response_model=SuggestedBuddiesResponse,
    status_code=200,
    summary="Suggest people the current user may know",
)
async def list_suggested_buddies(
    limit: int = Query(12, ge=1, le=50, description="Maximum suggestions to return"),
    user: CurrentUser = Depends(get_current_user),
) -> SuggestedBuddiesResponse:
    """Same ranked candidates the feed's "Buddies you may know" rail renders.

    Shared as a standalone endpoint so the Buddies page can show the rail
    without pulling a whole feed page."""
    return feed_service.fetch_suggested_buddies(
        get_supabase(), user.user_id, limit=limit
    )


@router.get(
    "/buddies/suggested/onboarding",
    response_model=OnboardingSuggestionsResponse,
    status_code=200,
    summary="Suggest buddies for a brand-new account",
)
async def list_onboarding_buddy_suggestions(
    limit: int = Query(12, ge=1, le=50, description="Maximum suggestions to return"),
    user: CurrentUser = Depends(get_current_user),
) -> OnboardingSuggestionsResponse:
    """Candidates for the onboarding "Add buddies" step, shown once the
    first-time profile modal is saved.

    Not the same list as /buddies/suggested: that one only returns people the
    viewer shares a play or a buddy with, which is the empty set for the
    account that has just been created. This falls back to recently active
    users once those run out, and tags each candidate with which tier it came
    from so the client can label it honestly.

    Carries `network` as well: the buddies of each candidate it returns, so
    the onboarding deck can promote them into the grid the moment the user
    ticks that candidate, without a round trip (migration 072)."""
    return feed_service.fetch_onboarding_buddy_suggestions(
        get_supabase(), user.user_id, limit=limit
    )


@router.delete(
    "/buddies/suggested/{user_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Stop suggesting someone",
)
async def dismiss_buddy_suggestion(
    user_id: str = Path(..., description="The suggested user to stop seeing"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Remove one person from every list this app volunteers.

    Backed by migration `014_buddy_suggestion_dismissals`. Named in full
    because the collapsed per-app counter restarted at 001, so a bare number
    can also name an archived migration — several comments in this package say
    "migration 013" and mean `archive/013_drop_buddy_id`.

    Per-viewer and silent — the person dismissed is never told, is not blocked,
    and can still be found through `/profiles/search`, which is what makes a
    mis-tap recoverable. Sending them a request later clears the dismissal.

    Idempotent: dismissing somebody twice is the same row, so the retry behind
    a dropped response does not 409 at a screen whose tile is already gone.
    400 for yourself · 404 if the account is gone.
    """
    buddy_suggestion_service.dismiss(get_supabase(), user.user_id, user_id)
    return MessageResponse(message="Suggestion removed")
