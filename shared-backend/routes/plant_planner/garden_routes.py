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
    result = (
        sb.table("plantplanner_gardens")
        .insert({
            "user_id": user.user_id,
            "name": body.name,
            "grid_width": body.grid_width,
            "grid_height": body.grid_height,
            "garden_type": body.garden_type,
            "shade_level": body.shade_level,
            "planting_season": body.planting_season,
        })
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
        .select("*, plantplanner_plants(*, plantplanner_renders(*))")
        .eq("garden_id", garden_id)
        .execute()
    )

    # Flatten render data onto the nested plant object
    for row in plants.data:
        plant = row.get("plantplanner_plants")
        if plant:
            render = plant.pop("plantplanner_renders", None)
            if render:
                plant["render_params"] = render.get("params")
                plant["render_colors"] = render.get("colors")

    return {
        **garden.data[0],
        "plants": plants.data,
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
        .select("id")
        .eq("id", garden_id)
        .eq("user_id", user.user_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Garden not found")

    # Delete all existing placements, then insert new ones
    sb.table("plantplanner_garden_plants").delete().eq("garden_id", garden_id).execute()

    if body.plants:
        rows = [
            {
                "garden_id": garden_id,
                "plant_id": p.plant_id,
                "grid_x": p.grid_x,
                "grid_y": p.grid_y,
            }
            for p in body.plants
        ]
        sb.table("plantplanner_garden_plants").insert(rows).execute()

    # Update timestamp
    sb.table("plantplanner_gardens").update({"updated_at": "now()"}).eq("id", garden_id).execute()

    return {"status": "saved", "count": len(body.plants)}
