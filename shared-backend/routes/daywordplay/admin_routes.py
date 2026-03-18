"""
routes/daywordplay/admin_routes.py
Admin-only endpoints: add words, list groups, delete groups.
All routes secured via require_admin() from shared auth.py.
"""
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
