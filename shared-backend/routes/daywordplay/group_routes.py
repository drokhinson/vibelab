"""
routes/daywordplay/group_routes.py
Groups: create, join by code, list, leaderboard, leave.
"""
import random
import string
from fastapi import Depends, HTTPException, Query

from db import get_supabase

from . import router
from .models import CreateGroupBody, JoinGroupBody, ReviewJoinRequestBody
from .dependencies import get_current_user


def _generate_code(sb) -> str:
    """Generate a unique 4-character alphanumeric code (uppercase)."""
    chars = string.ascii_uppercase + string.digits
    for _ in range(20):
        code = "".join(random.choices(chars, k=4))
        existing = sb.table("daywordplay_groups").select("id").eq("code", code).execute()
        if not existing.data:
            return code
    raise HTTPException(status_code=500, detail="Could not generate unique group code.")


@router.get("/groups")
async def list_groups(
    q: str = Query(default="", description="Search query"),
    current_user: dict = Depends(get_current_user),
):
    """List all groups, optionally filtered by name search."""
    sb = get_supabase()
    query = sb.table("daywordplay_groups").select("id, name, code, created_at")
    if q.strip():
        query = query.ilike("name", f"%{q.strip()}%")
    result = query.order("name").limit(50).execute()

    groups = result.data or []

    # Annotate with member count, membership status, and pending request status
    if groups:
        group_ids = [g["id"] for g in groups]
        members_result = sb.table("daywordplay_group_members").select("group_id, user_id").in_("group_id", group_ids).execute()
        members_data = members_result.data or []

        counts = {}
        user_groups = set()
        for m in members_data:
            counts[m["group_id"]] = counts.get(m["group_id"], 0) + 1
            if m["user_id"] == current_user["user_id"]:
                user_groups.add(m["group_id"])

        # Check for pending join requests from current user
        pending_requests = (
            sb.table("daywordplay_join_requests")
            .select("group_id")
            .eq("user_id", current_user["user_id"])
            .eq("status", "pending")
            .in_("group_id", group_ids)
            .execute()
        )
        pending_group_ids = {r["group_id"] for r in (pending_requests.data or [])}

        for g in groups:
            g["member_count"] = counts.get(g["id"], 0)
            g["is_member"] = g["id"] in user_groups
            g["has_pending_request"] = g["id"] in pending_group_ids

    return {"groups": groups}


@router.post("/groups")
async def create_group(body: CreateGroupBody, current_user: dict = Depends(get_current_user)):
    """Create a new group. Creator is automatically joined."""
    name = body.name.strip()
    if len(name) < 2:
        raise HTTPException(status_code=400, detail="Group name must be at least 2 characters.")

    sb = get_supabase()
    code = _generate_code(sb)

    group_result = sb.table("daywordplay_groups").insert({
        "name": name,
        "code": code,
        "created_by": current_user["user_id"],
    }).execute()
    group = group_result.data[0]

    # Auto-join creator
    sb.table("daywordplay_group_members").insert({
        "group_id": group["id"],
        "user_id": current_user["user_id"],
    }).execute()

    return {"group": group}


@router.post("/groups/join")
async def join_group(body: JoinGroupBody, current_user: dict = Depends(get_current_user)):
    """Join a group by its 4-character code."""
    code = body.code.strip().upper()
    if len(code) != 4:
        raise HTTPException(status_code=400, detail="Code must be exactly 4 characters.")

    sb = get_supabase()
    group_result = sb.table("daywordplay_groups").select("id, name, code").eq("code", code).execute()
    if not group_result.data:
        raise HTTPException(status_code=404, detail="No group found with that code.")

    group = group_result.data[0]

    # Check already a member
    existing = sb.table("daywordplay_group_members").select("id").eq("group_id", group["id"]).eq("user_id", current_user["user_id"]).execute()
    if existing.data:
        raise HTTPException(status_code=409, detail="Already a member of this group.")

    sb.table("daywordplay_group_members").insert({
        "group_id": group["id"],
        "user_id": current_user["user_id"],
    }).execute()

    return {"group": group}


@router.get("/groups/mine")
async def my_groups(current_user: dict = Depends(get_current_user)):
    """List groups the current user belongs to."""
    sb = get_supabase()
    membership = sb.table("daywordplay_group_members").select("group_id").eq("user_id", current_user["user_id"]).execute()
    group_ids = [m["group_id"] for m in (membership.data or [])]
    if not group_ids:
        return {"groups": []}

    groups_result = sb.table("daywordplay_groups").select("id, name, code, created_at").in_("id", group_ids).execute()
    return {"groups": groups_result.data or []}


@router.get("/groups/{group_id}")
async def get_group(group_id: str, current_user: dict = Depends(get_current_user)):
    """Get group details and member list."""
    sb = get_supabase()
    group_result = sb.table("daywordplay_groups").select("id, name, code, created_at, created_by").eq("id", group_id).execute()
    if not group_result.data:
        raise HTTPException(status_code=404, detail="Group not found.")

    group = group_result.data[0]

    # Verify current user is a member
    membership = sb.table("daywordplay_group_members").select("id").eq("group_id", group_id).eq("user_id", current_user["user_id"]).execute()
    if not membership.data:
        raise HTTPException(status_code=403, detail="You are not a member of this group.")

    # Get members with display names
    members_result = sb.table("daywordplay_group_members").select(
        "user_id, joined_at, daywordplay_users(username, display_name)"
    ).eq("group_id", group_id).execute()

    members = []
    for m in (members_result.data or []):
        user_info = m.get("daywordplay_users") or {}
        members.append({
            "user_id": m["user_id"],
            "username": user_info.get("username", ""),
            "display_name": user_info.get("display_name", ""),
            "joined_at": m["joined_at"],
        })

    group["members"] = members
    group["is_creator"] = group["created_by"] == current_user["user_id"]
    return {"group": group}


@router.get("/groups/{group_id}/leaderboard")
async def get_leaderboard(group_id: str, current_user: dict = Depends(get_current_user)):
    """All-time vote leaderboard for a group."""
    sb = get_supabase()

    # Verify membership
    membership = sb.table("daywordplay_group_members").select("id").eq("group_id", group_id).eq("user_id", current_user["user_id"]).execute()
    if not membership.data:
        raise HTTPException(status_code=403, detail="You are not a member of this group.")

    # Get all sentences for this group
    sentences = sb.table("daywordplay_sentences").select("id, user_id").eq("group_id", group_id).execute()
    sentence_ids = [s["id"] for s in (sentences.data or [])]
    sentence_user_map = {s["id"]: s["user_id"] for s in (sentences.data or [])}

    # Count votes per sentence
    vote_counts: dict[str, int] = {}
    if sentence_ids:
        votes = sb.table("daywordplay_votes").select("sentence_id").in_("sentence_id", sentence_ids).execute()
        for v in (votes.data or []):
            sid = v["sentence_id"]
            vote_counts[sid] = vote_counts.get(sid, 0) + 1

    # Aggregate by user
    user_vote_totals: dict[str, int] = {}
    user_sentence_counts: dict[str, int] = {}
    for sid, uid in sentence_user_map.items():
        user_vote_totals[uid] = user_vote_totals.get(uid, 0) + vote_counts.get(sid, 0)
        user_sentence_counts[uid] = user_sentence_counts.get(uid, 0) + 1

    # Get member info
    members_result = sb.table("daywordplay_group_members").select(
        "user_id, daywordplay_users(username, display_name)"
    ).eq("group_id", group_id).execute()

    leaderboard = []
    for m in (members_result.data or []):
        uid = m["user_id"]
        user_info = m.get("daywordplay_users") or {}
        leaderboard.append({
            "user_id": uid,
            "username": user_info.get("username", ""),
            "display_name": user_info.get("display_name", ""),
            "total_votes": user_vote_totals.get(uid, 0),
            "sentences_submitted": user_sentence_counts.get(uid, 0),
        })

    leaderboard.sort(key=lambda x: x["total_votes"], reverse=True)
    for i, entry in enumerate(leaderboard):
        entry["rank"] = i + 1

    group_result = sb.table("daywordplay_groups").select("name, code").eq("id", group_id).execute()
    group_info = group_result.data[0] if group_result.data else {}

    return {"group_name": group_info.get("name"), "group_code": group_info.get("code"), "leaderboard": leaderboard}


@router.delete("/groups/{group_id}/leave")
async def leave_group(group_id: str, current_user: dict = Depends(get_current_user)):
    """Leave a group."""
    sb = get_supabase()
    result = sb.table("daywordplay_group_members").delete().eq("group_id", group_id).eq("user_id", current_user["user_id"]).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="You are not a member of this group.")
    return {"left": True}


# ── Join requests ─────────────────────────────────────────────────────────────


@router.post("/groups/{group_id}/request-join")
async def request_join(group_id: str, current_user: dict = Depends(get_current_user)):
    """Request to join a group (requires approval from a member)."""
    sb = get_supabase()

    # Check group exists
    group_result = sb.table("daywordplay_groups").select("id, name").eq("id", group_id).execute()
    if not group_result.data:
        raise HTTPException(status_code=404, detail="Group not found.")

    # Check already a member
    existing = sb.table("daywordplay_group_members").select("id").eq("group_id", group_id).eq("user_id", current_user["user_id"]).execute()
    if existing.data:
        raise HTTPException(status_code=409, detail="You are already a member of this group.")

    # Check for existing pending request
    pending = (
        sb.table("daywordplay_join_requests")
        .select("id, status")
        .eq("group_id", group_id)
        .eq("user_id", current_user["user_id"])
        .execute()
    )
    if pending.data:
        row = pending.data[0]
        if row["status"] == "pending":
            raise HTTPException(status_code=409, detail="You already have a pending request for this group.")
        if row["status"] == "denied":
            # Allow re-requesting after denial — update existing row
            sb.table("daywordplay_join_requests").update({
                "status": "pending",
                "reviewed_by": None,
                "updated_at": "now()",
            }).eq("id", row["id"]).execute()
            return {"request": {"group_id": group_id, "status": "pending"}}

    sb.table("daywordplay_join_requests").insert({
        "group_id": group_id,
        "user_id": current_user["user_id"],
    }).execute()

    return {"request": {"group_id": group_id, "status": "pending"}}


@router.get("/groups/{group_id}/join-requests")
async def list_join_requests(group_id: str, current_user: dict = Depends(get_current_user)):
    """List pending join requests for a group (must be a member)."""
    sb = get_supabase()

    # Verify membership
    membership = sb.table("daywordplay_group_members").select("id").eq("group_id", group_id).eq("user_id", current_user["user_id"]).execute()
    if not membership.data:
        raise HTTPException(status_code=403, detail="You are not a member of this group.")

    requests = (
        sb.table("daywordplay_join_requests")
        .select("id, user_id, status, created_at, daywordplay_users(username, display_name)")
        .eq("group_id", group_id)
        .eq("status", "pending")
        .order("created_at")
        .execute()
    )

    results = []
    for r in (requests.data or []):
        user_info = r.get("daywordplay_users") or {}
        results.append({
            "id": r["id"],
            "user_id": r["user_id"],
            "username": user_info.get("username", ""),
            "display_name": user_info.get("display_name", ""),
            "created_at": r["created_at"],
        })

    return {"requests": results}


@router.post("/groups/{group_id}/join-requests/{request_id}")
async def review_join_request(
    group_id: str,
    request_id: str,
    body: ReviewJoinRequestBody,
    current_user: dict = Depends(get_current_user),
):
    """Approve or deny a join request (must be a group member)."""
    sb = get_supabase()

    if body.action not in ("approve", "deny"):
        raise HTTPException(status_code=400, detail="Action must be 'approve' or 'deny'.")

    # Verify reviewer is a member
    membership = sb.table("daywordplay_group_members").select("id").eq("group_id", group_id).eq("user_id", current_user["user_id"]).execute()
    if not membership.data:
        raise HTTPException(status_code=403, detail="You are not a member of this group.")

    # Get the request
    req_result = (
        sb.table("daywordplay_join_requests")
        .select("id, user_id, status")
        .eq("id", request_id)
        .eq("group_id", group_id)
        .execute()
    )
    if not req_result.data:
        raise HTTPException(status_code=404, detail="Join request not found.")
    req = req_result.data[0]
    if req["status"] != "pending":
        raise HTTPException(status_code=409, detail="This request has already been reviewed.")

    new_status = "approved" if body.action == "approve" else "denied"

    sb.table("daywordplay_join_requests").update({
        "status": new_status,
        "reviewed_by": current_user["user_id"],
        "updated_at": "now()",
    }).eq("id", request_id).execute()

    # If approved, add user to group
    if new_status == "approved":
        sb.table("daywordplay_group_members").insert({
            "group_id": group_id,
            "user_id": req["user_id"],
        }).execute()

    return {"status": new_status}


@router.get("/groups/my-requests")
async def my_join_requests(current_user: dict = Depends(get_current_user)):
    """List the current user's pending join requests."""
    sb = get_supabase()

    requests = (
        sb.table("daywordplay_join_requests")
        .select("id, group_id, status, created_at, daywordplay_groups(name)")
        .eq("user_id", current_user["user_id"])
        .eq("status", "pending")
        .order("created_at", desc=True)
        .execute()
    )

    results = []
    for r in (requests.data or []):
        group_info = r.get("daywordplay_groups") or {}
        results.append({
            "id": r["id"],
            "group_id": r["group_id"],
            "group_name": group_info.get("name", ""),
            "status": r["status"],
            "created_at": r["created_at"],
        })

    return {"requests": results}
