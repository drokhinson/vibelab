"""Mutual buddy graph service.

Owns reads/writes against boardgamebuddy_buddy_edges. The legacy
boardgamebuddy_buddies table is no longer used for friendship — it stays
around only to record free-text ghost players inside a single user's plays.
"""

from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from supabase import Client

from ..constants import MAX_BUDDY_ALIAS_CHARS, BuddyEdgeStatus
from ..models import (
    BuddyEdgeResponse,
    BuddyRequestResponse,
    BuddyRequestsResponse,
    BulkBuddyRequestFailure,
    BulkBuddyRequestResponse,
)
from ._helpers import canonical_edge_pair, edge_response, fetch_profiles_by_ids
from . import buddy_suggestion_service


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


def list_accepted_buddies(sb: Client, viewer_id: str) -> list[BuddyEdgeResponse]:
    """All accepted mutual edges for the viewer."""
    rows = (
        sb.table("boardgamebuddy_buddy_edges")
        .select(
            "id, user_a, user_b, status, requested_by, created_at, accepted_at, "
            "alias_by_a, alias_by_b"
        )
        .eq("status", BuddyEdgeStatus.ACCEPTED.value)
        .or_(f"user_a.eq.{viewer_id},user_b.eq.{viewer_id}")
        .execute()
    )
    edges = rows.data or []
    other_ids = [e["user_b"] if e["user_a"] == viewer_id else e["user_a"] for e in edges]
    profiles = fetch_profiles_by_ids(sb, other_ids)
    out = [edge_response(e, viewer_id, profiles) for e in edges]
    # Sort by what the row READS AS. An alias is the main name on the Buddies
    # row, so ordering by the real display name would file "Tuesday Dave"
    # under D and leave the list looking unsorted to the only person who sees it.
    out.sort(key=lambda b: (b.other_alias or b.other_display_name).lower())
    return out


def list_requests(sb: Client, viewer_id: str) -> BuddyRequestsResponse:
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


def send_request(sb: Client, viewer_id: str, target_user_id: str) -> BuddyRequestResponse:
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

    # Asking to be somebody's buddy contradicts having said "stop suggesting
    # them", so the older signal goes. Once, here, rather than on each of the
    # success branches below: a fresh request, an idempotent repeat and the
    # auto-accept are all the viewer reaching for this person, and on the two
    # branches that raise there is no dismissal left to matter anyway (an edge
    # already excludes them from every suggestion list). It is also what makes
    # a mis-tapped X recoverable — find them in search, add them, row gone.
    buddy_suggestion_service.clear(sb, viewer_id, target_user_id)

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
    sb: Client, viewer_id: str, target_user_ids: list[str]
) -> tuple[BulkBuddyRequestResponse, list[BuddyRequestResponse]]:
    """Send requests to several users at once, reporting per-target outcomes.

    Each target goes through send_request, so every rule that applies to a
    single request applies here — self-request rejection, the auto-accept when
    the target already requested the viewer, and the idempotent no-op when the
    viewer already requested them. A target that raises is recorded in
    `failed` and the batch continues: the onboarding step sends whatever the
    user ticked, and one suggestion going stale between paint and tap must not
    cost them the other nine.

    Duplicates within one payload collapse — send_request is idempotent, but
    de-duplicating first keeps `sent` an honest count of distinct people.

    Returns the response AND the individual send_request results, because the
    two answer different questions. The response is the API contract and says
    only who it worked for; each result additionally carries `direction`, which
    is the difference between "they now have a request waiting" and "this
    auto-accepted the one they had already sent" — and therefore between two
    different notifications. Handed back rather than pushed from in here so
    this stays a service with no opinion about delivery.
    """
    result = BulkBuddyRequestResponse()
    outcomes: list[BuddyRequestResponse] = []
    seen: set[str] = set()
    for target_id in target_user_ids:
        if target_id in seen:
            continue
        seen.add(target_id)
        try:
            outcomes.append(send_request(sb, viewer_id, target_id))
            result.sent.append(target_id)
        except HTTPException as e:
            result.failed.append(
                BulkBuddyRequestFailure(user_id=target_id, detail=str(e.detail))
            )
    return result, outcomes


def _accept_edge(sb: Client, edge: dict[str, Any], viewer_id: str) -> BuddyRequestResponse:
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


_EDGE_COLUMNS = (
    "id, user_a, user_b, status, requested_by, created_at, accepted_at, "
    "alias_by_a, alias_by_b"
)


def _load_edge(
    sb: Client,
    viewer_id: str,
    edge_id: str,
    *,
    not_found: str,
    require_status: BuddyEdgeStatus | None = None,
    wrong_status: str = "Request is not pending",
) -> dict[str, Any]:
    """The edge the viewer is a party to, or 404.

    A non-party gets the same 404 as a missing row: "you are not on this edge"
    and "there is no such edge" have to be indistinguishable, or the id
    becomes an existence oracle for other people's friendships.
    """
    rows = (
        sb.table("boardgamebuddy_buddy_edges")
        .select(_EDGE_COLUMNS)
        .eq("id", edge_id)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail=not_found)
    edge = rows.data[0]
    if viewer_id not in (edge["user_a"], edge["user_b"]):
        raise HTTPException(status_code=404, detail=not_found)
    if require_status is not None and edge["status"] != require_status.value:
        raise HTTPException(status_code=409, detail=wrong_status)
    return edge


def accept_request(sb: Client, viewer_id: str, request_id: str) -> BuddyEdgeResponse:
    """Accept an incoming buddy request. 400 if the viewer sent it."""
    edge = _load_edge(
        sb, viewer_id, request_id,
        not_found="Request not found", require_status=BuddyEdgeStatus.PENDING,
    )
    if edge["requested_by"] == viewer_id:
        raise HTTPException(status_code=400, detail="Cannot accept your own request")

    _accept_edge(sb, edge, viewer_id)
    other_id = edge["user_b"] if edge["user_a"] == viewer_id else edge["user_a"]
    profiles = fetch_profiles_by_ids(sb, [other_id])
    refreshed = (
        sb.table("boardgamebuddy_buddy_edges")
        .select(_EDGE_COLUMNS)
        .eq("id", request_id)
        .execute()
    )
    return edge_response((refreshed.data or [edge])[0], viewer_id, profiles)


def reject_request(sb: Client, viewer_id: str, request_id: str) -> None:
    """Delete a pending request the viewer is a party to."""
    _load_edge(
        sb, viewer_id, request_id,
        not_found="Request not found", require_status=BuddyEdgeStatus.PENDING,
    )
    sb.table("boardgamebuddy_buddy_edges").delete().eq("id", request_id).execute()


def cancel_request(sb: Client, viewer_id: str, request_id: str) -> None:
    """Withdraw a pending request the viewer sent.

    The mirror of reject_request: same edge, opposite party. Only the sender
    can cancel — the recipient's way out is Decline, which is a different
    signal to the sender and shouldn't be reachable through this route.
    """
    edge = _load_edge(
        sb, viewer_id, request_id,
        not_found="Request not found", require_status=BuddyEdgeStatus.PENDING,
    )
    if edge["requested_by"] != viewer_id:
        raise HTTPException(
            status_code=403, detail="Only the sender can cancel a request"
        )
    sb.table("boardgamebuddy_buddy_edges").delete().eq("id", request_id).execute()


def unfriend(sb: Client, viewer_id: str, edge_id: str) -> None:
    """Delete an accepted edge. Either party can do this."""
    _load_edge(sb, viewer_id, edge_id, not_found="Buddy edge not found")
    sb.table("boardgamebuddy_buddy_edges").delete().eq("id", edge_id).execute()


def set_alias(
    sb: Client, viewer_id: str, edge_id: str, alias: str | None
) -> BuddyEdgeResponse:
    """Set or clear the viewer's private alias for the buddy on this edge.

    Writes alias_by_a or alias_by_b depending on which side of the canonical row
    the viewer is on; the other column is never touched, so the two parties'
    aliases are independent and neither can read the other's.
    """
    edge = _load_edge(
        sb, viewer_id, edge_id,
        not_found="Buddy not found", require_status=BuddyEdgeStatus.ACCEPTED,
        wrong_status="You can only rename an accepted buddy",
    )

    trimmed = (alias or "").strip()
    if len(trimmed) > MAX_BUDDY_ALIAS_CHARS:
        raise HTTPException(status_code=400, detail="That alias is too long")
    column = "alias_by_a" if edge["user_a"] == viewer_id else "alias_by_b"
    # Whitespace-only clears. The row stores NULL rather than "" so "has an
    # alias" is one test everywhere instead of two.
    value = trimmed or None

    updated = (
        sb.table("boardgamebuddy_buddy_edges")
        .update({column: value})
        .eq("id", edge_id)
        .execute()
    )
    other_id = edge["user_b"] if edge["user_a"] == viewer_id else edge["user_a"]
    profiles = fetch_profiles_by_ids(sb, [other_id])
    # Fall back to the row we already read with the new value patched in: the
    # write succeeded either way, and a client that got no echo would paint the
    # old name over a change that landed.
    row = (updated.data or [{**edge, column: value}])[0]
    return edge_response(row, viewer_id, profiles)


def relation_to(sb: Client, viewer_id: str, other_id: str) -> dict[str, Any]:
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
