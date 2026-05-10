"""Pantry routes — per-user negative ingredient list (sauceboss_user_pantry_missing)."""

import logging

from fastapi import Depends, HTTPException

from db import get_supabase
from . import router
from .dependencies import CurrentUser, get_current_user
from .models import PantryEntry, PantryResponse, SetPantryMissingRequest

logger = logging.getLogger("sauceboss")


@router.get(
    "/pantry",
    response_model=PantryResponse,
    status_code=200,
    summary="Pantry overview — every ingredient in the user's saucebook + missing flags",
)
async def get_pantry(
    user: CurrentUser = Depends(get_current_user),
) -> PantryResponse:
    """Return every distinct ingredient across the user's saucebook with a missing flag."""
    sb = get_supabase()
    try:
        result = sb.rpc("get_sauceboss_pantry_for_user", {"p_user_id": user.user_id}).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    payload = result.data or {"ingredients": [], "saucebookSauceIds": []}
    return PantryResponse(
        ingredients=[_pantry_entry(row) for row in payload.get("ingredients", [])],
        saucebookSauceIds=payload.get("saucebookSauceIds", []),
    )


def _pantry_entry(row: dict) -> PantryEntry:
    """Construct a PantryEntry that carries both ingredientId and foodId.

    Migration 014 makes the underlying RPC emit both fields, but newer RPC
    revisions or third-party callers might omit one — fall back to the
    other so the release-compat alias is always populated.
    """
    ingredient_id = row.get("ingredientId") or row.get("foodId") or ""
    return PantryEntry(
        ingredientId=ingredient_id,
        foodId=ingredient_id,
        name=row.get("name", ""),
        missing=bool(row.get("missing", False)),
    )


@router.put(
    "/pantry",
    response_model=PantryResponse,
    status_code=200,
    summary="Replace the user's pantry-missing set in one call",
)
async def set_pantry_missing(
    body: SetPantryMissingRequest,
    user: CurrentUser = Depends(get_current_user),
) -> PantryResponse:
    """Replace the user's missing set; returns the refreshed pantry overview."""
    sb = get_supabase()
    try:
        result = sb.rpc(
            "set_sauceboss_pantry_missing",
            {"p_user_id": user.user_id, "p_ingredient_ids": body.resolve_ids()},
        ).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    payload = result.data or {"ingredients": [], "saucebookSauceIds": []}
    return PantryResponse(
        ingredients=[_pantry_entry(row) for row in payload.get("ingredients", [])],
        saucebookSauceIds=payload.get("saucebookSauceIds", []),
    )
