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

from fastapi import HTTPException

from auth import create_token, decode_token

from ..constants import (
    BGB_QR_SECRET,
    QR_TOKEN_ALGORITHM,
    QR_TOKEN_TTL_SECONDS,
    BuddyEdgeStatus,
)
from ..models import BuddyEdgeResponse
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
        .select("id, user_a, user_b, status, requested_by, created_at, accepted_at")
        .eq("user_a", user_a)
        .eq("user_b", user_b)
        .execute()
    )
    if existing.data:
        edge = existing.data[0]
        if edge["status"] == BuddyEdgeStatus.BLOCKED.value:
            raise HTTPException(status_code=403, detail="Blocked")
        if edge["status"] == BuddyEdgeStatus.ACCEPTED.value:
            return edge_response(edge, viewer_id, profiles), False
        # Pending, either direction — the scan is the acceptance. This is what
        # makes "add instantly" work even when one side already sent a request.
        updated = (
            sb.table("boardgamebuddy_buddy_edges")
            .update({"status": BuddyEdgeStatus.ACCEPTED.value, "accepted_at": now})
            .eq("id", edge["id"])
            .execute()
        )
        return edge_response((updated.data or [edge])[0], viewer_id, profiles), True

    try:
        inserted = (
            sb.table("boardgamebuddy_buddy_edges")
            .insert({
                "user_a": user_a,
                "user_b": user_b,
                "status": BuddyEdgeStatus.ACCEPTED.value,
                "requested_by": viewer_id,
                "accepted_at": now,
            })
            .execute()
        )
    except Exception:
        # idx_bgb_buddy_edges_pair is UNIQUE on (user_a, user_b), so two people
        # scanning each other's codes at the same moment race here. Whoever
        # loses re-reads the row the winner wrote — the outcome is identical.
        raced = (
            sb.table("boardgamebuddy_buddy_edges")
            .select("id, user_a, user_b, status, requested_by, created_at, accepted_at")
            .eq("user_a", user_a)
            .eq("user_b", user_b)
            .execute()
        )
        if not raced.data:
            raise
        return edge_response(raced.data[0], viewer_id, profiles), False

    return edge_response(inserted.data[0], viewer_id, profiles), True
