"""Scrap-level reads, edits, deletion, the visited list, and vibes.

Creation happens via POST /capture (source_routes) — one URL can fan out into
several scraps. Trip-plan management (adding scraps to trips, staging review)
lives in plan_routes.py.
"""

from typing import Any

from fastapi import Depends, HTTPException, Path

from db import get_supabase

from . import router
from .access import get_accessible_scrap
from .constants import GeocodeConfidence
from .dependencies import CurrentUser, get_current_user
from .models import (
    MessageResponse,
    ScrapListResponse,
    ScrapResponse,
    ScrapUpdateRequest,
    VibeRequest,
)
from .services import nominatim
from .services.enrichment import build_maps_url
from .services.hydrate import hydrate_scraps
from .services.places import normalize_place_name, region_for_country_code


def get_owned_scrap(sb, scrap_id: str, user_id: str) -> dict[str, Any]:
    rows = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("id", scrap_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail="Scrap not found")
    return rows.data[0]


def _hydrated_scrap(sb, scrap: dict[str, Any], *, with_vibes: bool = False) -> ScrapResponse:
    return ScrapResponse(**hydrate_scraps(sb, [scrap], with_vibes=with_vibes)[0])


@router.get(
    "/scraps/{scrap_id}",
    response_model=ScrapResponse,
    status_code=200,
    summary="Get one scrap",
)
async def get_scrap(
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Fetch a single scrap with its place and sources."""
    sb = get_supabase()
    return _hydrated_scrap(sb, get_owned_scrap(sb, scrap_id, user.user_id))


@router.get(
    "/visited",
    response_model=ScrapListResponse,
    status_code=200,
    summary="Places you've marked visited",
)
async def list_visited(
    user: CurrentUser = Depends(get_current_user),
) -> ScrapListResponse:
    """Every scrap the user marked visited (any trip or the wishlist),
    most-recently-visited first — the Visited view."""
    sb = get_supabase()
    rows = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("user_id", user.user_id)
        .not_.is_("visited_at", "null")
        .order("visited_at", desc=True)
        .execute()
    ).data or []
    return ScrapListResponse(
        scraps=[ScrapResponse(**s) for s in hydrate_scraps(sb, rows)]
    )


@router.patch(
    "/scraps/{scrap_id}",
    response_model=ScrapResponse,
    status_code=200,
    summary="Edit a scrap",
)
async def update_scrap(
    body: ScrapUpdateRequest,
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Edit place fields, category, notes, or favorite flag. Place edits write
    to the scrap's canonical place row (safe — places are per-user). Pass
    regeocode=true to re-run Nominatim on the (possibly edited) place."""
    sb = get_supabase()
    existing = get_owned_scrap(sb, scrap_id, user.user_id)
    place = (
        sb.table("travelscrapbook_places")
        .select("*")
        .eq("id", existing["place_id"])
        .execute()
    ).data[0]

    update = body.model_dump(exclude_unset=True, exclude={"regeocode"})

    scrap_update = {k: update[k] for k in ("notes", "is_favorite") if k in update}
    # visited is a soft timestamp flag, not a 1:1 column — map true→now(), false→NULL.
    if "visited" in update:
        scrap_update["visited_at"] = "now()" if update["visited"] else None
    place_update: dict[str, Any] = {}
    if update.get("place_name"):
        place_update["name"] = update["place_name"]
        place_update["name_normalized"] = normalize_place_name(update["place_name"])
    if "place_city" in update:
        place_update["city"] = update["place_city"]
    if "place_country" in update:
        place_update["country"] = update["place_country"]
    if update.get("category"):
        place_update["category"] = update["category"]

    merged = {
        "name": place_update.get("name", place["name"]),
        "city": place_update.get("city", place.get("city")),
        "country": place_update.get("country", place.get("country")),
    }

    if body.regeocode and merged["name"]:
        query = ", ".join(p for p in merged.values() if p)
        result = await nominatim.geocode(query)
        if result:
            place_update.update({
                "lat": result.lat,
                "lng": result.lng,
                "geocode_confidence": GeocodeConfidence.HIGH,
                "geocode_display_name": result.display_name,
                "osm_type": result.osm_type,
                "osm_id": result.osm_id,
                # Re-pinning refreshes the country_code + derived macro-region
                # (and, via accept-language=en, English names) — the path that
                # fixes older local-language places.
                "country_code": result.country_code,
                "region": region_for_country_code(sb, result.country_code),
            })
        else:
            place_update.update({
                "lat": None,
                "lng": None,
                "geocode_confidence": GeocodeConfidence.NONE,
                "geocode_display_name": None,
                "osm_type": None,
                "osm_id": None,
            })

    if place_update and merged["name"]:
        place_update["maps_url"] = build_maps_url(
            merged["name"], merged["city"], merged["country"]
        )

    if place_update:
        place_update["updated_at"] = "now()"
        sb.table("travelscrapbook_places").update(place_update).eq(
            "id", existing["place_id"]
        ).execute()
    if scrap_update:
        scrap_update["updated_at"] = "now()"
        updated = (
            sb.table("travelscrapbook_scraps")
            .update(scrap_update)
            .eq("id", scrap_id)
            .execute()
        )
        existing = updated.data[0]
    return _hydrated_scrap(sb, existing)


@router.delete(
    "/scraps/{scrap_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete a scrap",
)
async def delete_scrap(
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Remove a saved place (the canonical place row and sources remain)."""
    sb = get_supabase()
    get_owned_scrap(sb, scrap_id, user.user_id)
    sb.table("travelscrapbook_scraps").delete().eq("id", scrap_id).execute()
    return MessageResponse(message="Scrap deleted")


# ── Vibes (per-traveler consensus input) ─────────────────────────────────────

@router.put(
    "/scraps/{scrap_id}/vibe",
    response_model=ScrapResponse,
    status_code=200,
    summary="Set my vibe on a place",
)
async def set_vibe(
    body: VibeRequest,
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Record (or change) the current traveler's vibe on a saved place. Any
    member of the trip may set their own — including viewers — so everyone
    contributes to the group consensus."""
    sb = get_supabase()
    scrap = get_accessible_scrap(sb, scrap_id, user.user_id)
    sb.table("travelscrapbook_scrap_vibes").upsert(
        {
            "scrap_id": scrap_id,
            "user_id": user.user_id,
            "level": body.level,
            "updated_at": "now()",
        },
        on_conflict="scrap_id,user_id",
    ).execute()
    return _hydrated_scrap(sb, scrap, with_vibes=True)


@router.delete(
    "/scraps/{scrap_id}/vibe",
    response_model=ScrapResponse,
    status_code=200,
    summary="Clear my vibe on a place",
)
async def clear_vibe(
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Remove the current traveler's vibe on a place (back to no opinion)."""
    sb = get_supabase()
    scrap = get_accessible_scrap(sb, scrap_id, user.user_id)
    sb.table("travelscrapbook_scrap_vibes").delete().eq(
        "scrap_id", scrap_id
    ).eq("user_id", user.user_id).execute()
    return _hydrated_scrap(sb, scrap, with_vibes=True)
