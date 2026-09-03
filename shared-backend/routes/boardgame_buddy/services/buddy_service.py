"""Mutual buddy graph service.

Owns reads/writes against boardgamebuddy_buddy_edges. The legacy
boardgamebuddy_buddies table is no longer used for friendship — it stays
around only to record free-text ghost players inside a single user's plays.
"""

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException

from ..constants import BuddyEdgeStatus
from ..models import (
    BuddyEdgeResponse,
    BuddyRequestResponse,
    BuddyRequestsResponse,
    BulkBuddyRequestFailure,
    BulkBuddyRequestResponse,
)
from ._helpers import canonical_edge_pair, edge_response, fetch_profiles_by_ids


def _request_response(
    edge: dict[str, Any],
    viewer_id: str,
    profiles: dict[str, dict],
) -> BuddyRequestResponse:
    other_id = edge["user_b"] if edge["user_a"] == viewer_id else edge["user_a"]
    other = profiles.get(other_id) or {}
    direction = "outgoing" if edge["requested_by"] == viewer_id else "incoming"
    return BuddyRequestResponse(
        id=edge["id"],
        direction=direction,
        other_user_id=other_id,
        other_display_name=other.get("display_name") or "Unknown",
        other_avatar=other.get("avatar"),
        created_at=edge["created_at"],
    )


def list_accepted_buddies(sb, viewer_id: str) -> list[BuddyEdgeResponse]:
    """All accepted mutual edges for the viewer."""
    rows = (
        sb.table("boardgamebuddy_buddy_edges")
        .select("id, user_a, user_b, status, requested_by, created_at, accepted_at")
        .eq("status", BuddyEdgeStatus.ACCEPTED.value)
        .or_(f"user_a.eq.{viewer_id},user_b.eq.{viewer_id}")
        .execute()
    )
    edges = rows.data or []
    other_ids = [e["user_b"] if e["user_a"] == viewer_id else e["user_a"] for e in edges]
    profiles = fetch_profiles_by_ids(sb, other_ids)
    out = [edge_response(e, viewer_id, profiles) for e in edges]
    out.sort(key=lambda b: b.other_display_name.lower())
    return out


def list_requests(sb, viewer_id: str) -> BuddyRequestsResponse:
    """Pending buddy requests (both directions) for the viewer."""
    rows = (
        sb.table("boardgamebuddy_buddy_edges")
        .select("id, user_a, user_b, status, requested_by, created_at, accepted_at")
        .eq("status", BuddyEdgeStatus.PENDING.value)
        .or_(f"user_a.eq.{viewer_id},user_b.eq.{viewer_id}")
        .execute()
    )
    edges = rows.data or []
    other_ids = [e["user_b"] if e["user_a"] == viewer_id else e["user_a"] for e in edges]
    profiles = fetch_profiles_by_ids(sb, other_ids)
    incoming: list[BuddyRequestResponse] = []
    outgoing: list[BuddyRequestResponse] = []
    for edge in edges:
        req = _request_response(edge, viewer_id, profiles)
        (outgoing if req.direction == "outgoing" else incoming).append(req)
    return BuddyRequestsResponse(incoming=incoming, outgoing=outgoing)


def send_request(sb, viewer_id: str, target_user_id: str) -> BuddyRequestResponse:
    """Send a buddy request to another user. Idempotent for outgoing pending."""
    if target_user_id == viewer_id:
        raise HTTPException(status_code=400, detail="Cannot add yourself")

    target = (
        sb.table("boardgamebuddy_profiles")
        .select("id, display_name, avatar")
        .eq("id", target_user_id)
        .execute()
    )
    if not target.data:
        raise HTTPException(status_code=404, detail="User not found")

    user_a, user_b = canonical_edge_pair(viewer_id, target_user_id)
    existing = (
        sb.table("boardgamebuddy_buddy_edges")
        .select("id, user_a, user_b, status, requested_by, created_at, accepted_at")
        .eq("user_a", user_a)
        .eq("user_b", user_b)
        .execute()
    )
    if existing.data:
        edge = existing.data[0]
        if edge["status"] == BuddyEdgeStatus.ACCEPTED.value:
            raise HTTPException(status_code=409, detail="Already buddies")
        if edge["status"] == BuddyEdgeStatus.BLOCKED.value:
            raise HTTPException(status_code=403, detail="Blocked")
        # Pending — if the OTHER user previously requested, accept it.
        if edge["requested_by"] != viewer_id:
            return _accept_edge(sb, edge, viewer_id)
        # Already requested by us — idempotent return.
        profiles = fetch_profiles_by_ids(sb, [target_user_id])
        return _request_response(edge, viewer_id, profiles)

    inserted = (
        sb.table("boardgamebuddy_buddy_edges")
        .insert({
            "user_a": user_a,
            "user_b": user_b,
            "status": BuddyEdgeStatus.PENDING.value,
            "requested_by": viewer_id,
        })
        .execute()
    )
    edge = inserted.data[0]
    profiles = fetch_profiles_by_ids(sb, [target_user_id])
    return _request_response(edge, viewer_id, profiles)


def send_requests_bulk(
    sb, viewer_id: str, target_user_ids: list[str]
) -> BulkBuddyRequestResponse:
    """Send requests to several users at once, reporting per-target outcomes.

    Each target goes through send_request, so every rule that applies to a
    single request applies here — self-request rejection, the auto-accept when
    the target already requested the viewer, and the idempotent no-op when the
    viewer already requested them. A target that raises is recorded in
    `failed` and the batch continues: the onboarding step sends whatever the
    user ticked, and one suggestion going stale between paint and tap must not
    cost them the other nine.

    Duplicates within one payload collapse — send_request is idempotent, but
    de-duplicating first keeps `sent` an honest count of distinct people."""
    result = BulkBuddyRequestResponse()
    seen: set[str] = set()
    for target_id in target_user_ids:
        if target_id in seen:
            continue
        seen.add(target_id)
        try:
            send_request(sb, viewer_id, target_id)
            result.sent.append(target_id)
        except HTTPException as e:
            result.failed.append(
                BulkBuddyRequestFailure(user_id=target_id, detail=str(e.detail))
            )
    return result


def _accept_edge(sb, edge: dict[str, Any], viewer_id: str) -> BuddyRequestResponse:
    """Promote a pending edge to accepted. Returns the request shape so the
    caller can decide whether to re-fetch the accepted list."""
    now = datetime.now(timezone.utc).isoformat()
    updated = (
        sb.table("boardgamebuddy_buddy_edges")
        .update({
            "status": BuddyEdgeStatus.ACCEPTED.value,
            "accepted_at": now,
            # Who said yes. Not derivable from requested_by — see the column's
            # note in migration 009 — and it is what tells the REQUESTER their
            # request landed, on the notifications feed, without telling the
            # acceptor about their own tap.
            "accepted_by": viewer_id,
        })
        .eq("id", edge["id"])
        .execute()
    )
    new_edge = (updated.data or [edge])[0]
    other_id = new_edge["user_b"] if new_edge["user_a"] == viewer_id else new_edge["user_a"]
    profiles = fetch_profiles_by_ids(sb, [other_id])
    return _request_response(new_edge, viewer_id, profiles)


def accept_request(sb, viewer_id: str, request_id: str) -> BuddyEdgeResponse:
    """Accept an incoming buddy request. 403 if the viewer isn't the recipient."""
    rows = (
        sb.table("boardgamebuddy_buddy_edges")
        .select("id, user_a, user_b, status, requested_by, created_at, accepted_at")
        .eq("id", request_id)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail="Request not found")
    edge = rows.data[0]
    if viewer_id not in (edge["user_a"], edge["user_b"]):
        raise HTTPException(status_code=404, detail="Request not found")
    if edge["requested_by"] == viewer_id:
        raise HTTPException(status_code=400, detail="Cannot accept your own request")
    if edge["status"] != BuddyEdgeStatus.PENDING.value:
        raise HTTPException(status_code=409, detail="Request is not pending")

    _accept_edge(sb, edge, viewer_id)
    other_id = edge["user_b"] if edge["user_a"] == viewer_id else edge["user_a"]
    profiles = fetch_profiles_by_ids(sb, [other_id])
    refreshed = (
        sb.table("boardgamebuddy_buddy_edges")
        .select("id, user_a, user_b, status, requested_by, created_at, accepted_at")
        .eq("id", request_id)
        .execute()
    )
    return edge_response((refreshed.data or [edge])[0], viewer_id, profiles)


def reject_request(sb, viewer_id: str, request_id: str) -> None:
    """Delete a pending request. 403 if the viewer isn't the recipient."""
    rows = (
        sb.table("boardgamebuddy_buddy_edges")
        .select("id, user_a, user_b, status, requested_by")
        .eq("id", request_id)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail="Request not found")
    edge = rows.data[0]
    if viewer_id not in (edge["user_a"], edge["user_b"]):
        raise HTTPException(status_code=404, detail="Request not found")
    if edge["status"] != BuddyEdgeStatus.PENDING.value:
        raise HTTPException(status_code=409, detail="Request is not pending")
    sb.table("boardgamebuddy_buddy_edges").delete().eq("id", request_id).execute()


def cancel_request(sb, viewer_id: str, request_id: str) -> None:
    """Withdraw a pending request the viewer sent.

    The mirror of reject_request: same edge, opposite party. Only the sender
    can cancel — the recipient's way out is Decline, which is a different
    signal to the sender and shouldn't be reachable through this route.
    """
    rows = (
        sb.table("boardgamebuddy_buddy_edges")
        .select("id, user_a, user_b, status, requested_by")
        .eq("id", request_id)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail="Request not found")
    edge = rows.data[0]
    if viewer_id not in (edge["user_a"], edge["user_b"]):
        raise HTTPException(status_code=404, detail="Request not found")
    if edge["status"] != BuddyEdgeStatus.PENDING.value:
        raise HTTPException(status_code=409, detail="Request is not pending")
    if edge["requested_by"] != viewer_id:
        raise HTTPException(
            status_code=403, detail="Only the sender can cancel a request"
        )
    sb.table("boardgamebuddy_buddy_edges").delete().eq("id", request_id).execute()


def unfriend(sb, viewer_id: str, edge_id: str) -> None:
    """Delete an accepted edge. Either party can do this."""
    rows = (
        sb.table("boardgamebuddy_buddy_edges")
        .select("id, user_a, user_b")
        .eq("id", edge_id)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail="Buddy edge not found")
    edge = rows.data[0]
    if viewer_id not in (edge["user_a"], edge["user_b"]):
        raise HTTPException(status_code=404, detail="Buddy edge not found")
    sb.table("boardgamebuddy_buddy_edges").delete().eq("id", edge_id).execute()




def relation_to(sb, viewer_id: str, other_id: str) -> dict[str, Any]:
    """Return relationship metadata for a public profile view.

    Output keys: is_buddy (bool), has_pending_request (bool),
    pending_request_direction ('incoming' | 'outgoing' | None),
    pending_request_id (edge UUID | None).

    pending_request_id is what lets the profile's relation button cancel an
    outgoing request (or accept an incoming one) in place — without it the FE
    has to pull the whole /buddies/requests list just to find the edge id.
    """
    none_rel = {
        "is_buddy": False,
        "has_pending_request": False,
        "pending_request_direction": None,
        "pending_request_id": None,
    }
    if viewer_id == other_id:
        return dict(none_rel)
    user_a, user_b = canonical_edge_pair(viewer_id, other_id)
    rows = (
        sb.table("boardgamebuddy_buddy_edges")
        .select("id, status, requested_by")
        .eq("user_a", user_a)
        .eq("user_b", user_b)
        .execute()
    )
    if not rows.data:
        return dict(none_rel)
    edge = rows.data[0]
    if edge["status"] == BuddyEdgeStatus.ACCEPTED.value:
        return {**none_rel, "is_buddy": True}
    if edge["status"] == BuddyEdgeStatus.PENDING.value:
        direction = "outgoing" if edge["requested_by"] == viewer_id else "incoming"
        return {
            "is_buddy": False,
            "has_pending_request": True,
            "pending_request_direction": direction,
            "pending_request_id": edge["id"],
        }
    return dict(none_rel)
