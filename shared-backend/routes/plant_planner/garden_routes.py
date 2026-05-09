"""Garden CRUD routes."""

from fastapi import Depends, HTTPException

from db import get_supabase
from . import router
from .dependencies import CurrentUser, get_current_user
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
        .select(
            "*, plantplanner_plants(*, plantplanner_renders(*)), "
            "plantplanner_plant_cache(*)"
        )
        .eq("garden_id", garden_id)
        .execute()
    )

    # Flatten render data onto the nested seed-plant object (legacy placements)
    for row in plants.data:
        plant = row.get("plantplanner_plants")
        if plant:
            render = plant.pop("plantplanner_renders", None)
            if render:
                plant["render_params"] = render.get("params")
                plant["render_colors"] = render.get("colors")

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
        .select("id")
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
        .select("id, grid_width, grid_height")
        .eq("id", garden_id)
        .eq("user_id", user.user_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Garden not found")

    grid_width = existing.data[0]["grid_width"]
    grid_height = existing.data[0]["grid_height"]

    for p in body.plants:
        if not (0 <= p.pos_x <= grid_width):
            raise HTTPException(status_code=422, detail=f"Placement out of bounds: pos_x={p.pos_x} not in [0, {grid_width}]")
        if not (0 <= p.pos_y <= grid_height):
            raise HTTPException(status_code=422, detail=f"Placement out of bounds: pos_y={p.pos_y} not in [0, {grid_height}]")
        if p.radius_feet <= 0:
            raise HTTPException(status_code=422, detail=f"Invalid radius_feet: {p.radius_feet}")
        if bool(p.plant_id) == bool(p.plant_cache_id):
            raise HTTPException(
                status_code=422,
                detail="Each placement must set exactly one of plant_id or plant_cache_id",
            )

    # Delete all existing placements, then insert new ones
    sb.table("plantplanner_garden_plants").delete().eq("garden_id", garden_id).execute()

    if body.plants:
        rows = [
            {
                "garden_id": garden_id,
                "plant_id": p.plant_id,
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

    return {"status": "saved", "count": len(body.plants)}
