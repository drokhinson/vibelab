"""
routes/daywordplay/admin_routes.py
Admin-only endpoints: add words, list groups, delete groups.
All routes secured via require_admin() from shared auth.py.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import Header, HTTPException, Path

from auth import require_admin
from db import get_supabase

from . import router
from .models import AddWordBody


@router.post(
    "/admin/words",
    status_code=201,
    summary="Add a new word to the word bank",
)
async def admin_add_word(
    body: AddWordBody,
    authorization: Optional[str] = Header(None),
) -> dict:
    """Add a word to daywordplay_words. Admin only."""
    require_admin(authorization)
    sb = get_supabase()

    word = body.word.strip().lower()
    if not word:
        raise HTTPException(status_code=400, detail="Word cannot be empty.")

    existing = sb.table("daywordplay_words").select("id").eq("word", word).execute()
    if existing.data:
        raise HTTPException(status_code=409, detail="Word already exists.")

    result = sb.table("daywordplay_words").insert({
        "word": word,
        "part_of_speech": body.part_of_speech.strip(),
        "definition": body.definition.strip(),
        "pronunciation": body.pronunciation.strip() if body.pronunciation else None,
        "etymology": body.etymology.strip() if body.etymology else None,
    }).execute()

    return {"word": result.data[0]}


@router.get(
    "/admin/groups",
    status_code=200,
    summary="List all groups with member counts",
)
async def admin_list_groups(
    authorization: Optional[str] = Header(None),
) -> dict:
    """List all daywordplay groups with member counts. Admin only."""
    require_admin(authorization)
    sb = get_supabase()

    groups = sb.table("daywordplay_groups").select(
        "id, name, code, created_at"
    ).order("created_at", desc=True).execute()

    group_list = groups.data or []
    if group_list:
        group_ids = [g["id"] for g in group_list]
        members_result = sb.table("daywordplay_group_members").select(
            "group_id"
        ).in_("group_id", group_ids).execute()

        counts: dict[str, int] = {}
        for m in (members_result.data or []):
            gid = m["group_id"]
            counts[gid] = counts.get(gid, 0) + 1

        for g in group_list:
            g["member_count"] = counts.get(g["id"], 0)

    return {"groups": group_list}


@router.delete(
    "/admin/groups/{group_id}",
    status_code=200,
    summary="Delete a group and all its data",
)
async def admin_delete_group(
    group_id: str = Path(..., description="Group ID to delete"),
    authorization: Optional[str] = Header(None),
) -> dict:
    """Delete a group and cascade-remove its members, sentences, and votes. Admin only."""
    require_admin(authorization)
    sb = get_supabase()

    group_check = sb.table("daywordplay_groups").select("id, name").eq("id", group_id).execute()
    if not group_check.data:
        raise HTTPException(status_code=404, detail="Group not found.")

    group_name = group_check.data[0]["name"]

    # Collect sentence IDs to cascade-delete votes
    sentences = sb.table("daywordplay_sentences").select("id").eq("group_id", group_id).execute()
    sentence_ids = [s["id"] for s in (sentences.data or [])]

    if sentence_ids:
        sb.table("daywordplay_votes").delete().in_("sentence_id", sentence_ids).execute()

    sb.table("daywordplay_sentences").delete().eq("group_id", group_id).execute()
    sb.table("daywordplay_daily_words").delete().eq("group_id", group_id).execute()
    sb.table("daywordplay_group_members").delete().eq("group_id", group_id).execute()
    sb.table("daywordplay_groups").delete().eq("id", group_id).execute()

    return {"deleted": True, "group_id": group_id, "group_name": group_name}


@router.get(
    "/admin/proposed-words",
    status_code=200,
    summary="List pending word proposals",
)
async def admin_list_proposed_words(
    authorization: Optional[str] = Header(None),
) -> dict:
    """List all pending community word proposals ordered newest first. Admin only."""
    require_admin(authorization)
    sb = get_supabase()

    proposals_result = sb.table("daywordplay_proposed_words").select(
        "id, word, part_of_speech, definition, pronunciation, etymology, status, created_at, "
        "daywordplay_users(username, display_name)"
    ).eq("status", "pending").order("created_at", desc=True).execute()

    proposals = []
    for p in (proposals_result.data or []):
        user_info = p.pop("daywordplay_users", None) or {}
        proposals.append({
            **p,
            "proposer_username": user_info.get("username", ""),
            "proposer_display_name": user_info.get("display_name", ""),
        })

    return {"proposals": proposals}


@router.post(
    "/admin/proposed-words/{proposal_id}/approve",
    status_code=200,
    summary="Approve a word proposal and add it to the dictionary",
)
async def admin_approve_proposal(
    proposal_id: str = Path(..., description="Proposal ID to approve"),
    authorization: Optional[str] = Header(None),
) -> dict:
    """Approve a word proposal: copy it to daywordplay_words and mark approved. Admin only."""
    require_admin(authorization)
    sb = get_supabase()

    proposal_result = sb.table("daywordplay_proposed_words").select(
        "id, word, part_of_speech, definition, pronunciation, etymology, status"
    ).eq("id", proposal_id).execute()

    if not proposal_result.data:
        raise HTTPException(status_code=404, detail="Proposal not found.")

    proposal = proposal_result.data[0]
    if proposal["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"Proposal is already {proposal['status']}.")

    # Race condition guard: re-check the active dictionary
    existing = sb.table("daywordplay_words").select("id").eq("word", proposal["word"]).execute()
    if existing.data:
        raise HTTPException(status_code=409, detail=f'"{proposal["word"]}" already exists in the dictionary.')

    # Add to active word bank
    sb.table("daywordplay_words").insert({
        "word": proposal["word"],
        "part_of_speech": proposal["part_of_speech"],
        "definition": proposal["definition"],
        "pronunciation": proposal["pronunciation"],
        "etymology": proposal["etymology"],
    }).execute()

    # Mark proposal approved
    sb.table("daywordplay_proposed_words").update({
        "status": "approved",
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", proposal_id).execute()

    return {"approved": True, "word": proposal["word"]}


@router.post(
    "/admin/proposed-words/{proposal_id}/reject",
    status_code=200,
    summary="Reject a word proposal",
)
async def admin_reject_proposal(
    proposal_id: str = Path(..., description="Proposal ID to reject"),
    authorization: Optional[str] = Header(None),
) -> dict:
    """Reject a word proposal. Admin only."""
    require_admin(authorization)
    sb = get_supabase()

    proposal_result = sb.table("daywordplay_proposed_words").select("id, word, status").eq("id", proposal_id).execute()
    if not proposal_result.data:
        raise HTTPException(status_code=404, detail="Proposal not found.")

    proposal = proposal_result.data[0]
    if proposal["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"Proposal is already {proposal['status']}.")

    sb.table("daywordplay_proposed_words").update({
        "status": "rejected",
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", proposal_id).execute()

    return {"rejected": True, "word": proposal["word"]}
