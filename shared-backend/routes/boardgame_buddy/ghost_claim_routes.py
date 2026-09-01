"""Ghost account claim endpoints — "is this you?".

Deliberately a separate module from buddy_routes.py rather than eight more
routes on the end of it: that file is already at the ~300-line ceiling, and a
claim is its own object with its own lifecycle. The route SHAPE mirrors the
buddy request flow (list split incoming/outgoing, create, accept/reject/cancel)
because it is the same conversation with different nouns.

Route ORDER matters here: /ghost-claims/suggestions, /lookup and /dismiss are
declared before anything matching /ghost-claims/{claim_id}, or FastAPI would
match "suggestions" as a claim id.
"""

from fastapi import Depends, Path, Query

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import (
    GhostClaimAcceptResponse,
    GhostClaimCreate,
    GhostClaimDetail,
    GhostClaimDismiss,
    GhostClaimResponse,
    GhostClaimsResponse,
    GhostClaimSuggestionsResponse,
    MessageResponse,
)
from .services import ghost_claim_service


@router.get(
    "/ghost-claims/suggestions",
    response_model=GhostClaimSuggestionsResponse,
    status_code=200,
    summary="Buddies' ghost players whose names look like yours",
)
async def list_ghost_claim_suggestions(
    limit: int = Query(10, ge=1, le=50, description="Max suggestions to return"),
    user: CurrentUser = Depends(get_current_user),
) -> GhostClaimSuggestionsResponse:
    """The "Is this you?" list. Empty is the normal case, not an error."""
    return ghost_claim_service.fetch_suggestions(get_supabase(), user.user_id, limit)


@router.get(
    "/ghost-claims/lookup",
    response_model=GhostClaimDetail,
    status_code=200,
    summary="Look up one ghost on one play, for the claim sheet",
)
async def lookup_ghost_claim(
    play_id: str = Query(..., description="Play the ghost row appears on"),
    display_name: str = Query(..., min_length=1, description="The ghost's name"),
    user: CurrentUser = Depends(get_current_user),
) -> GhostClaimDetail:
    """Backs the sheet opened by tapping a ghost row.

    403 when the viewer cannot see the play (same rule as the feed), 410 when
    the ghost is no longer on it. Anything else that would block the claim
    comes back as can_claim=false plus a blocked_reason, so the sheet can say
    why rather than offering a button that fails.
    """
    return ghost_claim_service.fetch_detail(
        get_supabase(), user.user_id, play_id, display_name
    )


@router.get(
    "/ghost-claims",
    response_model=GhostClaimsResponse,
    status_code=200,
    summary="Pending ghost claims, split incoming / outgoing",
)
async def list_ghost_claims(
    user: CurrentUser = Depends(get_current_user),
) -> GhostClaimsResponse:
    """Incoming = people asking to claim YOUR ghosts. Outgoing = your asks."""
    return ghost_claim_service.list_claims(get_supabase(), user.user_id)


@router.post(
    "/ghost-claims",
    response_model=GhostClaimResponse,
    status_code=201,
    summary="Ask a buddy to link one of their ghost players to your account",
)
async def create_ghost_claim(
    body: GhostClaimCreate,
    user: CurrentUser = Depends(get_current_user),
) -> GhostClaimResponse:
    """Send a claim.

    Idempotent while one is pending. 400 for your own roster, 403 if you can't
    see the plays, 409 if you already appear on one of them (merging would seat
    you twice in one game), 409 after a second decline, 410 if the ghost is
    gone.
    """
    return ghost_claim_service.create_claim(
        get_supabase(), user.user_id, body.owner_user_id, body.display_name
    )


@router.post(
    "/ghost-claims/dismiss",
    response_model=MessageResponse,
    status_code=200,
    summary='"Not me" — stop suggesting a ghost',
)
async def dismiss_ghost_claim(
    body: GhostClaimDismiss,
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Suppress a suggestion. The ghost's owner is never told."""
    ghost_claim_service.dismiss_suggestion(
        get_supabase(), user.user_id, body.owner_user_id, body.display_name
    )
    return MessageResponse(message="Suggestion dismissed")


@router.post(
    "/ghost-claims/{claim_id}/accept",
    response_model=GhostClaimAcceptResponse,
    status_code=200,
    summary="Accept a claim and merge the ghost into the claimant's account",
)
async def accept_ghost_claim(
    claim_id: str = Path(..., description="Claim UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> GhostClaimAcceptResponse:
    """Approve. This rewrites the ghost's rows on YOUR plays to the claimant,
    and returns how many moved."""
    return ghost_claim_service.accept_claim(get_supabase(), user.user_id, claim_id)


@router.post(
    "/ghost-claims/{claim_id}/reject",
    response_model=MessageResponse,
    status_code=200,
    summary="Decline a claim on one of your ghosts",
)
async def reject_ghost_claim(
    claim_id: str = Path(..., description="Claim UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Decline. The claimant may ask once more; a second decline is final."""
    ghost_claim_service.reject_claim(get_supabase(), user.user_id, claim_id)
    return MessageResponse(message="Claim declined")


@router.post(
    "/ghost-claims/{claim_id}/cancel",
    response_model=MessageResponse,
    status_code=200,
    summary="Withdraw a claim you sent",
)
async def cancel_ghost_claim(
    claim_id: str = Path(..., description="Claim UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Withdraw your own ask. Unlike a decline this leaves no trace and costs
    no strike against the two-ask limit."""
    ghost_claim_service.cancel_claim(get_supabase(), user.user_id, claim_id)
    return MessageResponse(message="Claim withdrawn")
