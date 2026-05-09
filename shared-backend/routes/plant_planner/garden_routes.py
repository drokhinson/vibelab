"""Garden CRUD routes."""

from collections import Counter

from fastapi import Depends, HTTPException

from db import get_supabase
from . import router
from .dependencies import CurrentUser, get_current_user
from .garden_units import floor_dims_feet
from .library_routes import promote_to_current, upsert_wishlist_rows
from .models import CreateGardenBody, UpdateGardenBody, SavePlantsBody


@router.get("/gardens")
async def list_gardens(user: CurrentUser = Depends(get_current_user)):
    sb = get_supabase()
    result = (
        sb.table("plantplanner_gardens")
        .select("*")
        .eq("user_id", user.user_id)
        .order("updated_at", desc=True)
        .execute()
    )
    return result.data


@router.post("/gardens")
async def create_garden(body: CreateGardenBody, user: CurrentUser = Depends(get_current_user)):
    sb = get_supabase()
    insert_row = {
        "user_id": user.user_id,
        "name": body.name,
        "grid_width": body.grid_width,
        "grid_height": body.grid_height,
        "garden_type": body.garden_type,
        "shade_level": body.shade_level,
        "planting_season": body.planting_season,
        "water_plan": body.water_plan,
    }
    if body.usda_zone is not None:
        insert_row["usda_zone"] = body.usda_zone
    if body.location_label is not None:
        insert_row["location_label"] = body.location_label
    if body.dim_height is not None:
        insert_row["dim_height"] = body.dim_height
    result = (
        sb.table("plantplanner_gardens")
        .insert(insert_row)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create garden")
    return result.data[0]


@router.get("/gardens/{garden_id}")
async def get_garden(garden_id: str, user: CurrentUser = Depends(get_current_user)):
    sb = get_supabase()
    garden = (
        sb.table("plantplanner_gardens")
        .select("*")
        .eq("id", garden_id)
        .eq("user_id", user.user_id)
        .execute()
    )
    if not garden.data:
        raise HTTPException(status_code=404, detail="Garden not found")

    plants = (
        sb.table("plantplanner_garden_plants")
        .select("*, plantplanner_plant_cache(*)")
        .eq("garden_id", garden_id)
        .execute()
    )

    # Hydrate the shortlist into full cache rows so the builder sidebar can render
    # without an extra round-trip.
    shortlist_ids = garden.data[0].get("shortlist_plant_cache_ids") or []
    shortlist_rows: list[dict] = []
    if shortlist_ids:
        shortlist_resp = (
            sb.table("plantplanner_plant_cache")
            .select("*")
            .in_("id", shortlist_ids)
            .execute()
        )
        shortlist_rows = shortlist_resp.data or []

    return {
        **garden.data[0],
        "plants": plants.data,
        "shortlist": shortlist_rows,
    }


@router.put("/gardens/{garden_id}")
async def update_garden(garden_id: str, body: UpdateGardenBody, user: CurrentUser = Depends(get_current_user)):
    sb = get_supabase()
    existing = (
        sb.table("plantplanner_gardens")
        .select("id, shortlist_plant_cache_ids")
        .eq("id", garden_id)
        .eq("user_id", user.user_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Garden not found")

    updates = {k: v for k, v in body.dict().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates["updated_at"] = "now()"
    result = (
        sb.table("plantplanner_gardens")
        .update(updates)
        .eq("id", garden_id)
        .execute()
    )

    # Auto-create wishlist rows in My Plants for any new shortlist entries.
    new_shortlist = body.shortlist_plant_cache_ids
    if new_shortlist is not None:
        prev_set = set(existing.data[0].get("shortlist_plant_cache_ids") or [])
        added = [pid for pid in new_shortlist if pid and pid not in prev_set]
        if added:
            await upsert_wishlist_rows(user.user_id, added)

    return result.data[0]


@router.delete("/gardens/{garden_id}")
async def delete_garden(garden_id: str, user: CurrentUser = Depends(get_current_user)):
    sb = get_supabase()
    existing = (
        sb.table("plantplanner_gardens")
        .select("id")
        .eq("id", garden_id)
        .eq("user_id", user.user_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Garden not found")

    sb.table("plantplanner_gardens").delete().eq("id", garden_id).execute()
    return {"status": "deleted"}


@router.put("/gardens/{garden_id}/plants")
async def save_garden_plants(garden_id: str, body: SavePlantsBody, user: CurrentUser = Depends(get_current_user)):
    sb = get_supabase()
    existing = (
        sb.table("plantplanner_gardens")
        .select("id, grid_width, grid_height, garden_type")
        .eq("id", garden_id)
        .eq("user_id", user.user_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Garden not found")

    garden_type = existing.data[0].get("garden_type")
    # Placements (pos_x / pos_y / radius_feet) are always in feet. floor_dims_feet
    # handles each shape: pots collapse to a 2r × 2r bounding square (since pot
    # grid_width = radius); everything else is rectangular grid_width × grid_height.
    width_ft, height_ft = floor_dims_feet(
        existing.data[0]["grid_width"],
        existing.data[0]["grid_height"],
        garden_type,
    )

    for p in body.plants:
        if not (0 <= p.pos_x <= width_ft):
            raise HTTPException(status_code=422, detail=f"Placement out of bounds: pos_x={p.pos_x} not in [0, {width_ft}] ft")
        if not (0 <= p.pos_y <= height_ft):
            raise HTTPException(status_code=422, detail=f"Placement out of bounds: pos_y={p.pos_y} not in [0, {height_ft}] ft")
        if p.radius_feet <= 0:
            raise HTTPException(status_code=422, detail=f"Invalid radius_feet: {p.radius_feet}")

    # Delete all existing placements, then insert new ones
    sb.table("plantplanner_garden_plants").delete().eq("garden_id", garden_id).execute()

    if body.plants:
        rows = [
            {
                "garden_id": garden_id,
                "plant_cache_id": p.plant_cache_id,
                "pos_x": p.pos_x,
                "pos_y": p.pos_y,
                "radius_feet": p.radius_feet,
            }
            for p in body.plants
        ]
        sb.table("plantplanner_garden_plants").insert(rows).execute()

    # Update timestamp
    sb.table("plantplanner_gardens").update({"updated_at": "now()"}).eq("id", garden_id).execute()

    # Promote each placed species to 'current' in My Plants. Count placements
    # across ALL the user's gardens (not just this one) so quantity reflects
    # total ownership. Cheap: one query, group in Python.
    if body.plants:
        user_gardens = (
            sb.table("plantplanner_gardens")
            .select("id")
            .eq("user_id", user.user_id)
            .execute()
            .data
            or []
        )
        garden_ids = [g["id"] for g in user_gardens]
        if garden_ids:
            all_placements = (
                sb.table("plantplanner_garden_plants")
                .select("plant_cache_id")
                .in_("garden_id", garden_ids)
                .execute()
                .data
                or []
            )
            counts = Counter(
                row["plant_cache_id"] for row in all_placements if row.get("plant_cache_id")
            )
            placed_ids = {p.plant_cache_id for p in body.plants}
            relevant = {pid: counts[pid] for pid in placed_ids if pid in counts}
            if relevant:
                await promote_to_current(user.user_id, relevant)

    return {"status": "saved", "count": len(body.plants)}
