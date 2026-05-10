"""Saucebook (per-user library) and Browse (read-only paginated listing) routes."""

import logging
from typing import Optional

from fastapi import Depends, HTTPException, Path, Query

from db import get_supabase
from . import router
from .dependencies import CurrentUser, get_current_user, maybe_current_user
from .models import (
    AuthorSummary,
    BrowseResponse,
    MessageResponse,
    SaucebookResponse,
)

logger = logging.getLogger("sauceboss")


@router.get(
    "/saucebook",
    response_model=SaucebookResponse,
    status_code=200,
    summary="List the current user's saucebook (slim Browse-shaped envelopes)",
)
async def list_saucebook(
    user: CurrentUser = Depends(get_current_user),
) -> SaucebookResponse:
    """The caller's saved sauces, slim envelopes (Browse shape + addedAt +
    ingredientNames). Steps + full ingredients fetched via /sauces on tap."""
    sb = get_supabase()
    try:
        result = sb.rpc("get_sauceboss_saucebook", {"p_user_id": user.user_id}).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return SaucebookResponse(sauces=result.data or [])


@router.post(
    "/saucebook/{sauce_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Add a sauce to the current user's saucebook (idempotent)",
)
async def add_to_saucebook(
    sauce_id: str = Path(..., description="Sauce id to add."),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Insert (user_id, sauce_id). Idempotent: re-adding is a no-op."""
    sb = get_supabase()
    exists = sb.table("sauceboss_sauce").select("id").eq("id", sauce_id).execute()
    if not exists.data:
        raise HTTPException(404, "Sauce not found")
    try:
        sb.table("sauceboss_user_saucebook").upsert(
            {"user_id": user.user_id, "sauce_id": sauce_id},
            on_conflict="user_id,sauce_id",
        ).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return MessageResponse(message="Added to saucebook")


@router.delete(
    "/saucebook/{sauce_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Remove a sauce from the current user's saucebook",
)
async def remove_from_saucebook(
    sauce_id: str = Path(..., description="Sauce id to remove."),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Delete (user_id, sauce_id). No error if the row does not exist."""
    sb = get_supabase()
    try:
        sb.table("sauceboss_user_saucebook").delete().eq("user_id", user.user_id).eq("sauce_id", sauce_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return MessageResponse(message="Removed from saucebook")


@router.get(
    "/browse",
    response_model=BrowseResponse,
    status_code=200,
    summary="Paginated, filterable, sortable read of all sauces (Browse tab)",
)
async def browse_sauces(
    q: str = Query("", description="Substring match on name (case-insensitive)."),
    cuisine: list[str] = Query(default_factory=list, description="Cuisines to include (multi)."),
    type: list[str] = Query(default_factory=list, alias="type", description="Sauce types to include (multi)."),
    author: Optional[str] = Query(None, description="Author profile id (UUID) to filter to."),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: Optional[CurrentUser] = Depends(maybe_current_user),
) -> BrowseResponse:
    """Browse the global sauce list. Anonymous-friendly; sorted latest-first.

    Returns lightweight rows (no steps / ingredients) so a 20-row page is
    cheap; the per-sauce detail view fetches the full envelope. Each row
    carries `inSaucebook` for the current caller (always false for anon).
    """
    sb = get_supabase()
    params = {
        "p_user_id":  user.user_id if user else None,
        "p_q":        q,
        "p_cuisines": cuisine or None,
        "p_types":    type or None,
        "p_author":   author,
        "p_limit":    limit,
        "p_offset":   offset,
    }
    try:
        result = sb.rpc("get_sauceboss_browse", params).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    payload = result.data or {"total": 0, "items": []}
    return BrowseResponse(total=payload.get("total", 0), items=payload.get("items", []))


@router.get(
    "/authors",
    response_model=list[AuthorSummary],
    status_code=200,
    summary="Author autocomplete for the Browse author filter",
)
async def list_authors(
    q: str = Query("", description="Substring match on display_name (case-insensitive)."),
    _: Optional[CurrentUser] = Depends(maybe_current_user),
) -> list[dict]:
    """Returns up to 20 authored profiles matching `q`, with their sauce count."""
    sb = get_supabase()
    try:
        result = sb.rpc("get_sauceboss_browse_authors", {"p_q": q}).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return result.data or []
