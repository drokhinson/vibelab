"""Add a buddy by QR code — token minting, verification, and the graph write.

The whole feature lives here rather than half in buddy_service because the
mutual-add below is only safe in the presence of a verified token: keeping the
two in one file means the guarantee and the thing it guards cannot drift apart.

Tokens are stateless by design: the token IS the grant, so there is no table, no
cleanup job, and no write on the display path. See constants.BGB_QR_SECRET for
the domain-separation and revocation reasoning.

Why a signed token at all, when the QR could just carry a user id: ids are
public — every /u/{userId} profile URL contains one — so an id proves nothing
about consent. A token that exists only because its owner had the QR sheet open
seconds ago is exactly the signal a raw id cannot provide, and it is what makes
"scan to become buddies instantly" safe to offer.
"""

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException

from auth import create_token, decode_token

from ..constants import (
    BGB_QR_SECRET,
    QR_TOKEN_ALGORITHM,
    QR_TOKEN_TTL_SECONDS,
    BuddyEdgeStatus,
)
from ..models import BuddyEdgeResponse, BuddyQrPeekResponse
from ._helpers import canonical_edge_pair, edge_response, fetch_profiles_by_ids


def mint_qr_token(viewer_id: str) -> tuple[str, datetime]:
    """Sign a short-lived token naming the viewer as the code's owner."""
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=QR_TOKEN_TTL_SECONDS)
    token = create_token(
        {"u": viewer_id, "exp": int(expires_at.timestamp())},
        BGB_QR_SECRET,
        QR_TOKEN_ALGORITHM,
    )
    return token, expires_at


def issuer_from_qr_token(token: str) -> str:
    """Verify a scanned token and return the user id that minted it.

    Re-raised as 410, never 401. A 401 from this endpoint would be swallowed by
    web/domain/api.js's expired-access-token path (refresh the Supabase session,
    retry once), burning a refresh round trip and then surfacing a JWT error the
    user cannot act on. 410 also matches how _helpers.RPC_ERROR_STATUS already
    reports an expired play session. Expired and forged are deliberately
    indistinguishable to the caller.
    """
    try:
        payload = decode_token(token, BGB_QR_SECRET, QR_TOKEN_ALGORITHM)
    except HTTPException:
        raise HTTPException(
            status_code=410,
            detail="This code has expired — ask them to show it again.",
        )
    issuer_id = payload.get("u")
    if not issuer_id:
        raise HTTPException(status_code=410, detail="This code isn't valid.")
    return issuer_id


def peek_qr_issuer(sb, viewer_id: str, other_id: str) -> BuddyQrPeekResponse:
    """Name the person behind a scanned code, and say where the viewer stands.

    The read half of add_buddy_mutually below, and it exists because that
    function used to be the only thing a scan could do: the token was verified
    and the edge written in one round trip, so there was no way to learn WHO a
    code belonged to without becoming their buddy. The scan screen now asks
    first, which needs an answer that writes nothing.

    Same token, same verification, no side effects — so calling this is not a
    weaker version of consent, it is the same grant used to identify rather
    than to act. `relation` is what lets the caller show "Already buddies"
    instead of offering a button that would no-op.
    """
    if other_id == viewer_id:
        raise HTTPException(status_code=400, detail="That's your own code")

    profiles = fetch_profiles_by_ids(sb, [other_id])
    profile = profiles.get(other_id)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    user_a, user_b = canonical_edge_pair(viewer_id, other_id)
    existing = (
        sb.table("boardgamebuddy_buddy_edges")
        .select("status, requested_by")
        .eq("user_a", user_a)
        .eq("user_b", user_b)
        .execute()
    )
    relation = "none"
    if existing.data:
        row = existing.data[0]
        status = row.get("status")
        if status == BuddyEdgeStatus.ACCEPTED.value:
            relation = "buddies"
        elif status == BuddyEdgeStatus.BLOCKED.value:
            relation = "blocked"
        elif status == BuddyEdgeStatus.PENDING.value:
            # Direction matters to the caller: a request THEY sent us is about
            # to be auto-accepted by the scan, which is a different sentence
            # from one we are still waiting on.
            relation = "outgoing" if row.get("requested_by") == viewer_id else "incoming"

    return BuddyQrPeekResponse(
        user_id=other_id,
        display_name=profile.get("display_name") or "Unknown",
        username=profile.get("username"),
        avatar=profile.get("avatar"),
        relation=relation,
    )


def add_buddy_mutually(sb, viewer_id: str, other_id: str) -> tuple[BuddyEdgeResponse, bool]:
    """Create — or promote — an ACCEPTED edge with no consent step.

    The only legitimate caller is the QR redeem route, which has already
    verified an unexpired token the other user minted seconds ago. Do NOT reach
    for this from a path that only knows a user id: ids are public (see
    /u/{userId}), and this function is what turns knowing one into a friendship.

    Returns (edge, created) — created is False when the pair were already
    buddies, so a re-scan reads as a clean success rather than a 409.
    """
    if other_id == viewer_id:
        raise HTTPException(status_code=400, detail="That's your own code")

    target = (
        sb.table("boardgamebuddy_profiles")
        .select("id")
        .eq("id", other_id)
        .execute()
    )
    if not target.data:
        raise HTTPException(status_code=404, detail="User not found")

    user_a, user_b = canonical_edge_pair(viewer_id, other_id)
    now = datetime.now(timezone.utc).isoformat()
    profiles = fetch_profiles_by_ids(sb, [other_id])

    existing = (
        sb.table("boardgamebuddy_buddy_edges")
        .select(
            "id, user_a, user_b, status, requested_by, created_at, accepted_at, "
            "alias_by_a, alias_by_b"
        )
        .eq("user_a", user_a)
        .eq("user_b", user_b)
        .execute()
    )
    if existing.data:
        return _resolve_existing(sb, existing.data[0], viewer_id, profiles, now)

    try:
        inserted = (
            sb.table("boardgamebuddy_buddy_edges")
            .insert({
                "user_a": user_a,
                "user_b": user_b,
                "status": BuddyEdgeStatus.ACCEPTED.value,
                "requested_by": viewer_id,
                "accepted_at": now,
                # The scanner is the one who acted, so the notification goes to
                # the person whose code was scanned — the only one who has yet
                # to learn anything. requested_by is the scanner too on this
                # path (nobody asked), which is exactly why bgb_notifications
                # reads accepted_by and not requested_by.
                "accepted_by": viewer_id,
            })
            .execute()
        )
    except Exception:
        # idx_bgb_buddy_edges_pair is UNIQUE on (user_a, user_b), so anything
        # that wrote this pair between the SELECT above and this INSERT lands
        # here. Usually that is the other person scanning simultaneously — but
        # it can equally be an ordinary buddy request or a block, so the raced
        # row goes through the SAME status handling as a pre-existing one.
        # Reporting it as "already buddies" would tell a blocked user they were
        # added, and would leave a pending edge unpromoted.
        raced = (
            sb.table("boardgamebuddy_buddy_edges")
            .select(
                "id, user_a, user_b, status, requested_by, created_at, accepted_at, "
                "alias_by_a, alias_by_b"
            )
            .eq("user_a", user_a)
            .eq("user_b", user_b)
            .execute()
        )
        if not raced.data:
            # The insert failed for some other reason entirely — surface it.
            raise
        return _resolve_existing(sb, raced.data[0], viewer_id, profiles, now)

    return edge_response(inserted.data[0], viewer_id, profiles), True


def _resolve_existing(
    sb,
    edge: dict[str, Any],
    viewer_id: str,
    profiles: dict[str, dict],
    now: str,
) -> tuple[BuddyEdgeResponse, bool]:
    """Apply the scan to an edge that already exists. Returns (edge, created)."""
    if edge["status"] == BuddyEdgeStatus.BLOCKED.value:
        raise HTTPException(status_code=403, detail="Blocked")
    if edge["status"] == BuddyEdgeStatus.ACCEPTED.value:
        return edge_response(edge, viewer_id, profiles), False
    # Pending, either direction — the scan is the acceptance. This is what makes
    # "add instantly" work even when one side had already sent a request.
    updated = (
        sb.table("boardgamebuddy_buddy_edges")
        .update({
            "status": BuddyEdgeStatus.ACCEPTED.value,
            "accepted_at": now,
            "accepted_by": viewer_id,   # the scan IS the acceptance
        })
        .eq("id", edge["id"])
        .execute()
    )
    return edge_response((updated.data or [edge])[0], viewer_id, profiles), True
