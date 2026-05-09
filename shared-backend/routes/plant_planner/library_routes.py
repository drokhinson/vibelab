"""Plant Library — top-level "My Plants" management.

The library is the user's persistent record of plants they care about across
all their planters: current ownership, wishlist items they don't have yet,
and plants they used to grow. Auto-populated from the existing planter
flows (see `_upsert_wishlist_rows` and `_promote_to_current` below) so the
UI never blocks on an explicit "add to library" action.

Planter membership is computed live from `plantplanner_garden_plants` —
NEVER stored on the user_plants row.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import Depends, HTTPException, Query

from db import get_supabase
from . import router
from .constants import UserPlantStatus
from .dependencies import CurrentUser, get_current_user
from .models import (
    CreateUserPlantBody,
    GardenStub,
    UpdateUserPlantBody,
    UserPlantResponse,
)

logger = logging.getLogger(__name__)


# ── Auto-population helpers (imported by garden_routes) ─────────────────────

async def upsert_wishlist_rows(user_id: str, plant_cache_ids: List[str]) -> None:
    """Insert wishlist rows for any new plant_cache_id; never overwrites status.

    Called when a planter's shortlist gains entries (PUT /gardens/{id} with
    shortlist_plant_cache_ids). Uses Supabase's `ignore_duplicates=True` to
    skip any rows already present — even if their stored status is already
    'current' or 'former', they're left untouched.
    """
    if not plant_cache_ids:
        return
    sb = get_supabase()
    rows = [
        {
            "user_id": user_id,
            "plant_cache_id": pid,
            "status": UserPlantStatus.WISHLIST.value,
            "quantity": 0,
        }
        for pid in plant_cache_ids
        if pid
    ]
    if not rows:
        return
    try:
        sb.table("plantplanner_user_plants").upsert(
            rows,
            on_conflict="user_id,plant_cache_id",
            ignore_duplicates=True,
        ).execute()
    except Exception as exc:
        # Non-fatal — the planter save itself should still succeed.
        logger.warning("Wishlist auto-upsert failed for user %s: %s", user_id, exc)


async def promote_to_current(user_id: str, plant_cache_id_counts: Dict[str, int]) -> None:
    """For each species placed in any of the user's planters, ensure a 'current'
    row exists with quantity ≥ the count of placements.

    Promote-only: never demotes 'current' to 'wishlist' or 'former'. If a row
    exists with status='current', updates quantity to GREATEST(existing, count).
    If a row exists with status='wishlist', promotes it to 'current' with
    quantity = count. Status='former' rows are left alone (the user
    explicitly demoted them).
    """
    if not plant_cache_id_counts:
        return
    sb = get_supabase()
    cache_ids = list(plant_cache_id_counts.keys())

    existing = (
        sb.table("plantplanner_user_plants")
        .select("id, plant_cache_id, status, quantity")
        .eq("user_id", user_id)
        .in_("plant_cache_id", cache_ids)
        .execute()
        .data
        or []
    )
    by_cache: Dict[str, Dict[str, Any]] = {row["plant_cache_id"]: row for row in existing}

    to_insert: List[Dict[str, Any]] = []
    for cache_id, count in plant_cache_id_counts.items():
        if not cache_id:
            continue
        row = by_cache.get(cache_id)
        if row is None:
            to_insert.append({
                "user_id": user_id,
                "plant_cache_id": cache_id,
                "status": UserPlantStatus.CURRENT.value,
                "quantity": count,
            })
            continue
        if row["status"] == UserPlantStatus.FORMER.value:
            continue  # respect explicit demotion
        new_qty = max(int(row.get("quantity") or 0), count)
        if row["status"] == UserPlantStatus.CURRENT.value and new_qty == row.get("quantity"):
            continue  # nothing to do
        try:
            sb.table("plantplanner_user_plants").update({
                "status": UserPlantStatus.CURRENT.value,
                "quantity": new_qty,
                "updated_at": "now()",
            }).eq("id", row["id"]).execute()
        except Exception as exc:
            logger.warning("Promote-to-current update failed for row %s: %s", row.get("id"), exc)

    if to_insert:
        try:
            sb.table("plantplanner_user_plants").insert(to_insert).execute()
        except Exception as exc:
            logger.warning("Promote-to-current insert failed for user %s: %s", user_id, exc)


# ── Internal hydration helpers ──────────────────────────────────────────────

def _row_to_user_plant_response(
    row: Dict[str, Any],
    plant: Optional[Dict[str, Any]],
    gardens: List[GardenStub],
) -> UserPlantResponse:
    return UserPlantResponse(
        id=row["id"],
        user_id=row["user_id"],
        plant_cache_id=row["plant_cache_id"],
        status=UserPlantStatus(row["status"]),
        quantity=int(row.get("quantity") or 0),
        notes=row.get("notes"),
        acquired_at=row.get("acquired_at"),
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
        plant=plant,
        gardens=gardens,
    )


async def _hydrate_user_plants(
    user_id: str,
    rows: List[Dict[str, Any]],
    include_gardens: bool,
) -> List[UserPlantResponse]:
    """Single-shot hydration: one query for cache plants, one for garden memberships."""
    if not rows:
        return []
    sb = get_supabase()
    cache_ids = [r["plant_cache_id"] for r in rows]

    plant_resp = (
        sb.table("plantplanner_plant_cache")
        .select("*")
        .in_("id", cache_ids)
        .execute()
    )
    plants_by_id: Dict[str, Dict[str, Any]] = {p["id"]: p for p in (plant_resp.data or [])}

    gardens_by_cache: Dict[str, List[GardenStub]] = {}
    if include_gardens:
        # One indexed lookup against (plant_cache_id) joining the user's gardens.
        # The supabase-py builder's `.select` with FK expansion handles the join.
        gp_resp = (
            sb.table("plantplanner_garden_plants")
            .select("plant_cache_id, plantplanner_gardens(id, name, user_id)")
            .in_("plant_cache_id", cache_ids)
            .execute()
        )
        for gp in (gp_resp.data or []):
            garden = gp.get("plantplanner_gardens") or {}
            if not garden or garden.get("user_id") != user_id:
                continue  # only this user's gardens
            cache_id = gp["plant_cache_id"]
            stub = GardenStub(id=garden["id"], name=garden["name"])
            bucket = gardens_by_cache.setdefault(cache_id, [])
            if not any(g.id == stub.id for g in bucket):
                bucket.append(stub)

    return [
        _row_to_user_plant_response(
            row,
            plants_by_id.get(row["plant_cache_id"]),
            gardens_by_cache.get(row["plant_cache_id"], []),
        )
        for row in rows
    ]


# ── Routes ──────────────────────────────────────────────────────────────────

@router.get(
    "/user_plants",
    response_model=List[UserPlantResponse],
    status_code=200,
    summary="List the current user's plant library",
)
async def list_user_plants(
    status: Optional[UserPlantStatus] = Query(None, description="Filter by status"),
    include_gardens: bool = Query(True, description="Embed planter membership"),
    user: CurrentUser = Depends(get_current_user),
) -> List[UserPlantResponse]:
    """Return the user's library entries, optionally filtered by status."""
    sb = get_supabase()
    q = (
        sb.table("plantplanner_user_plants")
        .select("*")
        .eq("user_id", user.user_id)
    )
    if status is not None:
        q = q.eq("status", status.value)
    rows = q.order("updated_at", desc=True).execute().data or []
    return await _hydrate_user_plants(user.user_id, rows, include_gardens)


@router.post(
    "/user_plants",
    response_model=UserPlantResponse,
    status_code=200,
    summary="Add a plant to the user's library (idempotent on (user_id, plant_cache_id))",
)
async def create_user_plant(
    body: CreateUserPlantBody,
    user: CurrentUser = Depends(get_current_user),
) -> UserPlantResponse:
    """Create a library row, or return the existing one. Status of an existing
    row is preserved — use PUT to change it."""
    sb = get_supabase()
    existing = (
        sb.table("plantplanner_user_plants")
        .select("*")
        .eq("user_id", user.user_id)
        .eq("plant_cache_id", body.plant_cache_id)
        .execute()
    )
    if existing.data:
        rows = existing.data
    else:
        insert_row = {
            "user_id": user.user_id,
            "plant_cache_id": body.plant_cache_id,
            "status": body.status.value,
            "quantity": body.quantity,
            "notes": body.notes,
            "acquired_at": body.acquired_at,
        }
        result = sb.table("plantplanner_user_plants").insert(insert_row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create user_plant")
        rows = result.data

    hydrated = await _hydrate_user_plants(user.user_id, rows, include_gardens=True)
    return hydrated[0]


@router.put(
    "/user_plants/{user_plant_id}",
    response_model=UserPlantResponse,
    status_code=200,
    summary="Edit a library row (status, quantity, notes, acquired_at)",
)
async def update_user_plant(
    user_plant_id: str,
    body: UpdateUserPlantBody,
    user: CurrentUser = Depends(get_current_user),
) -> UserPlantResponse:
    """Update any subset of editable fields on the user's own library row."""
    sb = get_supabase()
    existing = (
        sb.table("plantplanner_user_plants")
        .select("id")
        .eq("id", user_plant_id)
        .eq("user_id", user.user_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Library entry not found")

    payload: Dict[str, Any] = {}
    if body.status is not None:
        payload["status"] = body.status.value
    if body.quantity is not None:
        if body.quantity < 0:
            raise HTTPException(status_code=422, detail="quantity must be >= 0")
        payload["quantity"] = body.quantity
    if body.notes is not None:
        payload["notes"] = body.notes
    if body.acquired_at is not None:
        payload["acquired_at"] = body.acquired_at or None
    if not payload:
        raise HTTPException(status_code=400, detail="No fields to update")
    payload["updated_at"] = "now()"

    result = (
        sb.table("plantplanner_user_plants")
        .update(payload)
        .eq("id", user_plant_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=500, detail="Update failed")

    hydrated = await _hydrate_user_plants(user.user_id, result.data, include_gardens=True)
    return hydrated[0]


@router.delete(
    "/user_plants/{user_plant_id}",
    status_code=200,
    summary="Remove a row from the library",
)
async def delete_user_plant(
    user_plant_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> Dict[str, str]:
    """Hard-delete the row. Does not affect placements in any planter."""
    sb = get_supabase()
    existing = (
        sb.table("plantplanner_user_plants")
        .select("id")
        .eq("id", user_plant_id)
        .eq("user_id", user.user_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Library entry not found")
    sb.table("plantplanner_user_plants").delete().eq("id", user_plant_id).execute()
    return {"status": "deleted"}
