"""Ghost account claims — the claimant-initiated half of ghost linking.

played_with_service.link_ghost runs owner → ghost: the person who logged the
plays decides that "davo" is really Julia's account. This module runs the other
way. The claimant asks, the owner approves, and approving performs that same
merge (bgb_link_ghost_rows, migration 070, shared by both paths so they can
never move different sets of rows).

Since migration 014 a claim also records WHO ASKED separately from who it is
for, so "that ghost is my buddy Dave" is expressible. The requester and the
claimant must be accepted buddies; the owner still decides.

Everything is an RPC. That is not gold-plating: a ghost has no id, so every
operation is keyed by (owner, normalized name) and has to re-derive which
play_players rows that means — plus, for anything the claimant initiates,
whether they can even see those plays and whether merging would seat them twice
in one game. Splitting that across a PostgREST read and a Python decision opens
a window between the check and the write. Migration 070's header has the full
argument.

Cancel used to be the one exception — a plain ownership-checked delete. It
stopped being one in 014: two parties can now call a claim off, and it means
two different things depending on which (see cancel_claim below), so the rule
moved into bgb_cancel_ghost_claim beside accept and reject. Response shaping is
now the only thing this module decides.
"""

from fastapi import HTTPException

from ..models import (
    GhostClaimAcceptResponse,
    GhostClaimDetail,
    GhostClaimResponse,
    GhostClaimsResponse,
    GhostClaimSuggestion,
    GhostClaimSuggestionsResponse,
)
from ._helpers import raise_for_rpc_error


def fetch_suggestions(
    sb,
    viewer_id: str,
    limit: int = 10,
) -> GhostClaimSuggestionsResponse:
    """The Buddies screen's "Is this you?" list.

    Scans the viewer's ACCEPTED BUDDIES' rosters only. A proactive suggestion
    is the app volunteering someone else's nickname, so it stays conservative;
    fetch_detail below is deliberately wider, because there the user tapped a
    row they can already see.
    """
    rows = (
        sb.rpc(
            "bgb_ghost_claim_suggestions",
            {"p_viewer": viewer_id, "p_limit": limit},
        )
        .execute()
        .data
        or []
    )
    return GhostClaimSuggestionsResponse(
        suggestions=[GhostClaimSuggestion.model_validate(r) for r in rows]
    )


def fetch_detail(
    sb,
    viewer_id: str,
    play_id: str,
    display_name: str,
) -> GhostClaimDetail:
    """One ghost on one play, for the claim sheet.

    Keyed by the play rather than the owner because that is what a tapped
    scoreboard row has, and because the play is what the visibility check needs.
    """
    if not display_name.strip():
        raise HTTPException(status_code=400, detail="display_name is required")
    data = (
        sb.rpc(
            "bgb_ghost_claim_detail",
            {
                "p_viewer": viewer_id,
                "p_play_id": play_id,
                "p_display_name": display_name.strip(),
            },
        )
        .execute()
        .data
        or {}
    )
    raise_for_rpc_error(data, "ghost claim detail")
    return GhostClaimDetail.model_validate(data)


def list_claims(sb, viewer_id: str) -> GhostClaimsResponse:
    """Every side of the viewer's pending claims, mirroring /buddies/requests.

    Three lists since migration 014, and no claim is in more than one:
    `outgoing` is keyed on requested_by (asks the viewer MADE — which is where
    the withdraw button belongs), `for_me` on being the claimant of an ask
    somebody else made.
    """
    data = sb.rpc("bgb_ghost_claims", {"p_viewer": viewer_id}).execute().data or {}
    return GhostClaimsResponse(
        incoming=[
            GhostClaimResponse.model_validate(x) for x in (data.get("incoming") or [])
        ],
        outgoing=[
            GhostClaimResponse.model_validate(x) for x in (data.get("outgoing") or [])
        ],
        for_me=[
            GhostClaimResponse.model_validate(x) for x in (data.get("for_me") or [])
        ],
    )


def create_claim(
    sb,
    viewer_id: str,
    owner_user_id: str,
    display_name: str,
    claimant_user_id: str | None = None,
    play_id: str | None = None,
) -> GhostClaimResponse:
    """Send a claim, for the viewer or for one of their buddies.

    Idempotent while one is already pending. `claimant_user_id` None means "for
    myself", which is the whole of the pre-014 behaviour; passing it makes this
    a proxy claim, and the RPC then requires an accepted buddy edge and a
    play_id belonging to the owner.
    """
    if not display_name.strip():
        raise HTTPException(status_code=400, detail="display_name is required")
    data = (
        sb.rpc(
            "bgb_create_ghost_claim",
            {
                "p_requester": viewer_id,
                "p_owner": owner_user_id,
                "p_display_name": display_name.strip(),
                "p_claimant": claimant_user_id,
                "p_play_id": play_id,
            },
        )
        .execute()
        .data
        or {}
    )
    raise_for_rpc_error(data, "ghost claim create")
    return GhostClaimResponse.model_validate(data)


def accept_claim(sb, viewer_id: str, claim_id: str) -> GhostClaimAcceptResponse:
    """Approve a claim and merge the ghost's rows into the claimant's account.

    One transaction inside the RPC, which is what lets it re-check the
    double-seat collision at accept time — state moves between request and
    accept, and there is no unique constraint on (play_id, player_user_id) to
    catch it afterwards.
    """
    data = (
        sb.rpc(
            "bgb_accept_ghost_claim",
            {"p_owner": viewer_id, "p_claim_id": claim_id},
        )
        .execute()
        .data
        or {}
    )
    raise_for_rpc_error(data, "ghost claim accept")
    return GhostClaimAcceptResponse(
        claim=GhostClaimResponse.model_validate(data.get("claim") or {}),
        rows_merged=int(data.get("updated") or 0),
    )


def reject_claim(sb, viewer_id: str, claim_id: str) -> None:
    """Decline a claim, and record the strike.

    An RPC rather than a PostgREST update because reject_count has to be
    incremented from its current value, which PostgREST cannot express.
    """
    data = (
        sb.rpc(
            "bgb_reject_ghost_claim",
            {"p_owner": viewer_id, "p_claim_id": claim_id},
        )
        .execute()
        .data
        or {}
    )
    raise_for_rpc_error(data, "ghost claim reject")


def cancel_claim(sb, viewer_id: str, claim_id: str) -> str:
    """Call off a pending claim, from either end of it.

    Returns the RPC's `kind` so the route can say the right thing:

      "withdrawn"  the ASKER took their own request back. A DELETE, which is
                   the whole asymmetry with reject_claim — withdrawing your own
                   ask is not a decline and must not burn a strike against the
                   two-ask limit.
      "declined"   the person the claim was FOR said it isn't them. Marked
                   'dismissed' rather than deleted, because a delete would let
                   the same buddy re-raise it a second later, and "that isn't
                   me" has to stick. They stay free to change their mind: a
                   self-claim reopens their own dismissed row.

    An RPC since migration 014. It was a plain ownership-checked delete while
    only one person could ever cancel; two actors with two outcomes and a
    check-then-write window is not something to keep in Python.

    404 rather than 403 for a stranger's claim, matching
    buddy_service.reject_request: do not confirm the claim exists.
    """
    data = (
        sb.rpc(
            "bgb_cancel_ghost_claim",
            {"p_viewer": viewer_id, "p_claim_id": claim_id},
        )
        .execute()
        .data
        or {}
    )
    raise_for_rpc_error(data, "ghost claim cancel")
    return str(data.get("kind") or "withdrawn")


def dismiss_suggestion(
    sb,
    viewer_id: str,
    owner_user_id: str,
    display_name: str,
) -> None:
    """"Not me" — stop suggesting this ghost.

    Writes the same row a real claim would, so a later change of mind flips it
    back to pending instead of opening a second row. The owner is never told.
    """
    if not display_name.strip():
        raise HTTPException(status_code=400, detail="display_name is required")
    data = (
        sb.rpc(
            "bgb_dismiss_ghost_claim",
            {
                "p_claimant": viewer_id,
                "p_owner": owner_user_id,
                "p_display_name": display_name.strip(),
            },
        )
        .execute()
        .data
        or {}
    )
    raise_for_rpc_error(data, "ghost claim dismiss")
