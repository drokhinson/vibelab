"""Profile routes: update profile, location, traveling status, discoverability."""

from fastapi import Depends, HTTPException

from db import get_supabase
from . import router
from .dependencies import get_current_user
from .models import ProfileUpdateBody, LocationUpdateBody, TravelingUpdateBody, DiscoverableBody


@router.put("/profile")
async def update_profile(body: ProfileUpdateBody, user: dict = Depends(get_current_user)):
    sb = get_supabase()
    updates = {}
    if body.display_name is not None:
        updates["display_name"] = body.display_name
    if body.bio is not None:
        updates["bio"] = body.bio
    if body.avatar_url is not None:
        updates["avatar_url"] = body.avatar_url
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    result = sb.table("spotme_users").update(updates).eq("id", user["user_id"]).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found")
    return result.data[0]


@router.put("/profile/location")
async def update_location(body: LocationUpdateBody, user: dict = Depends(get_current_user)):
    sb = get_supabase()
    updates = {
        "home_lat": body.home_lat,
        "home_lng": body.home_lng,
        "home_label": body.home_label,
    }
    result = sb.table("spotme_users").update(updates).eq("id", user["user_id"]).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found")
    return result.data[0]


@router.put("/profile/traveling")
async def update_traveling(body: TravelingUpdateBody, user: dict = Depends(get_current_user)):
    sb = get_supabase()
    updates = {
        "traveling_to_lat": body.traveling_to_lat,
        "traveling_to_lng": body.traveling_to_lng,
        "traveling_to_label": body.traveling_to_label,
        "traveling_from": body.traveling_from,
        "traveling_until": body.traveling_until,
    }
    result = sb.table("spotme_users").update(updates).eq("id", user["user_id"]).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found")
    return result.data[0]


@router.delete("/profile/traveling")
async def clear_traveling(user: dict = Depends(get_current_user)):
    sb = get_supabase()
    updates = {
        "traveling_to_lat": None,
        "traveling_to_lng": None,
        "traveling_to_label": None,
        "traveling_from": None,
        "traveling_until": None,
    }
    result = sb.table("spotme_users").update(updates).eq("id", user["user_id"]).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found")
    return {"status": "cleared"}


@router.put("/profile/discoverable")
async def update_discoverable(body: DiscoverableBody, user: dict = Depends(get_current_user)):
    sb = get_supabase()
    result = sb.table("spotme_users").update({
        "is_discoverable": body.is_discoverable,
    }).eq("id", user["user_id"]).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found")
    return {"is_discoverable": body.is_discoverable}
