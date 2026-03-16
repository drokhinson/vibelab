"""Hobby routes: categories, hobbies, user hobby management."""

import re

from fastapi import Depends, HTTPException, Query
from typing import Optional

from db import get_supabase
from . import router
from .dependencies import get_current_user
from .constants import PROFICIENCY_LEVELS
from .models import AddHobbyBody, UpdateHobbyBody, CreateHobbyBody


# ---------------------------------------------------------------------------
# Hobby Catalog (public)
# ---------------------------------------------------------------------------

@router.get("/hobbies/categories")
async def list_categories():
    sb = get_supabase()
    result = sb.table("spotme_hobby_categories").select("*").order("sort_order").execute()
    return result.data or []


@router.get("/hobbies")
async def list_hobbies(category_id: Optional[str] = Query(None)):
    sb = get_supabase()
    query = sb.table("spotme_hobbies").select("*, spotme_hobby_categories(slug, name, icon)")
    if category_id:
        query = query.eq("category_id", category_id)
    result = query.order("name").execute()
    return result.data or []


@router.post("/hobbies")
async def create_hobby(body: CreateHobbyBody, user: dict = Depends(get_current_user)):
    """Create a custom hobby. Returns existing hobby if slug already exists."""
    sb = get_supabase()
    slug = re.sub(r'[^a-z0-9]+', '-', body.name.lower()).strip('-')

    existing = sb.table("spotme_hobbies").select("*").eq("slug", slug).execute()
    if existing.data:
        return existing.data[0]

    # Verify category exists
    cat = sb.table("spotme_hobby_categories").select("id").eq("id", body.category_id).execute()
    if not cat.data:
        raise HTTPException(status_code=400, detail="Invalid category_id")

    result = sb.table("spotme_hobbies").insert({
        "category_id": body.category_id,
        "name": body.name,
        "slug": slug,
    }).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create hobby")
    return result.data[0]


# ---------------------------------------------------------------------------
# User Hobbies (authenticated)
# ---------------------------------------------------------------------------

@router.get("/me/hobbies")
async def list_my_hobbies(user: dict = Depends(get_current_user)):
    sb = get_supabase()
    result = (
        sb.table("spotme_user_hobbies")
        .select("*, spotme_hobbies(id, name, slug, spotme_hobby_categories(slug, name, icon))")
        .eq("user_id", user["user_id"])
        .eq("is_active", True)
        .order("created_at")
        .execute()
    )
    return result.data or []


@router.post("/me/hobbies")
async def add_my_hobby(body: AddHobbyBody, user: dict = Depends(get_current_user)):
    if body.proficiency not in PROFICIENCY_LEVELS:
        raise HTTPException(status_code=400, detail=f"Invalid proficiency. Must be one of: {PROFICIENCY_LEVELS}")
    sb = get_supabase()

    # Check if already added
    existing = (
        sb.table("spotme_user_hobbies")
        .select("id, is_active")
        .eq("user_id", user["user_id"])
        .eq("hobby_id", body.hobby_id)
        .execute()
    )
    if existing.data:
        row = existing.data[0]
        if row["is_active"]:
            raise HTTPException(status_code=409, detail="Hobby already added")
        # Re-activate
        result = sb.table("spotme_user_hobbies").update({
            "is_active": True,
            "proficiency": body.proficiency,
            "notes": body.notes,
        }).eq("id", row["id"]).execute()
        return result.data[0] if result.data else row

    result = sb.table("spotme_user_hobbies").insert({
        "user_id": user["user_id"],
        "hobby_id": body.hobby_id,
        "proficiency": body.proficiency,
        "notes": body.notes,
    }).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to add hobby")
    return result.data[0]


@router.put("/me/hobbies/{user_hobby_id}")
async def update_my_hobby(user_hobby_id: str, body: UpdateHobbyBody, user: dict = Depends(get_current_user)):
    sb = get_supabase()
    updates = {}
    if body.proficiency is not None:
        if body.proficiency not in PROFICIENCY_LEVELS:
            raise HTTPException(status_code=400, detail=f"Invalid proficiency. Must be one of: {PROFICIENCY_LEVELS}")
        updates["proficiency"] = body.proficiency
    if body.notes is not None:
        updates["notes"] = body.notes
    if body.is_active is not None:
        updates["is_active"] = body.is_active
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    result = (
        sb.table("spotme_user_hobbies")
        .update(updates)
        .eq("id", user_hobby_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="User hobby not found")
    return result.data[0]


@router.delete("/me/hobbies/{user_hobby_id}")
async def remove_my_hobby(user_hobby_id: str, user: dict = Depends(get_current_user)):
    sb = get_supabase()
    result = (
        sb.table("spotme_user_hobbies")
        .delete()
        .eq("id", user_hobby_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="User hobby not found")
    return {"status": "removed"}
