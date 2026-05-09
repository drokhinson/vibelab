"""Plant catalog routes — cache-first reads, lazy fill on miss.

The user-facing read paths (search, detail) ALWAYS query
`plantplanner_plant_cache` directly. External API calls only happen as a
side effect of cache fill (when the user-supplied criteria turn up too few
local matches) or cache enrich (when a detail panel needs a hardiness zone
that wasn't captured at first sync).

Phase 1: shopping step + builder shortlist consume `/catalog/search`.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, Query
from pydantic import BaseModel

from db import get_supabase
from . import router
from .api_clients import (
    SEARCH_RESULT_CAP,
    merge_records,
    normalize_perenual,
    normalize_trefle,
    perenual_lookup_by_scientific,
    trefle_filter,
    trefle_search,
)
from .garden_units import garden_is_climate_controlled, garden_uses_inches
from .image_mirror import mirror_all_sizes

logger = logging.getLogger(__name__)

# Below this many cache hits, fall through to a live API fill.
LAZY_FILL_THRESHOLD = 8


class CatalogPlant(BaseModel):
    """Cache-row representation returned to the frontend."""
    id: str
    source: str
    scientific_name: str
    common_name: Optional[str] = None
    family: Optional[str] = None
    emoji: Optional[str] = None
    hardiness_min: Optional[int] = None
    hardiness_max: Optional[int] = None
    sunlight: Optional[str] = None
    watering: Optional[str] = None
    cycle: Optional[str] = None
    indoor: Optional[bool] = None
    height_min_cm: Optional[int] = None
    height_max_cm: Optional[int] = None
    spread_cm: Optional[int] = None
    days_to_harvest: Optional[int] = None
    edible: Optional[bool] = None
    vegetable: Optional[bool] = None
    toxicity: Optional[str] = None
    growth_rate: Optional[str] = None
    ph_min: Optional[float] = None
    ph_max: Optional[float] = None
    sowing: Optional[str] = None
    nitrogen_fixation: Optional[bool] = None
    tags: List[str] = []
    image_thumbnail_path: Optional[str] = None
    image_medium_path: Optional[str] = None
    image_regular_path: Optional[str] = None
    # Original CDN URLs are exposed only as a fallback when the mirror is missing.
    image_thumbnail_url: Optional[str] = None
    image_medium_url: Optional[str] = None
    image_regular_url: Optional[str] = None


class CatalogSearchResponse(BaseModel):
    plants: List[CatalogPlant]
    total: int
    fill_triggered: bool


def _row_to_catalog_plant(row: Dict[str, Any]) -> CatalogPlant:
    return CatalogPlant(
        id=row["id"],
        source=row.get("source") or "merged",
        scientific_name=row.get("scientific_name") or "",
        common_name=row.get("common_name"),
        family=row.get("family"),
        emoji=row.get("emoji"),
        hardiness_min=row.get("hardiness_min"),
        hardiness_max=row.get("hardiness_max"),
        sunlight=row.get("sunlight"),
        watering=row.get("watering"),
        cycle=row.get("cycle"),
        indoor=row.get("indoor"),
        height_min_cm=row.get("height_min_cm"),
        height_max_cm=row.get("height_max_cm"),
        spread_cm=row.get("spread_cm"),
        days_to_harvest=row.get("days_to_harvest"),
        edible=row.get("edible"),
        vegetable=row.get("vegetable"),
        toxicity=row.get("toxicity"),
        growth_rate=row.get("growth_rate"),
        ph_min=row.get("ph_min"),
        ph_max=row.get("ph_max"),
        sowing=row.get("sowing"),
        nitrogen_fixation=row.get("nitrogen_fixation"),
        tags=row.get("tags") or [],
        image_thumbnail_path=row.get("image_thumbnail_path"),
        image_medium_path=row.get("image_medium_path"),
        image_regular_path=row.get("image_regular_path"),
        image_thumbnail_url=row.get("image_thumbnail_url"),
        image_medium_url=row.get("image_medium_url"),
        image_regular_url=row.get("image_regular_url"),
    )


def _strip_internal_fields(row: Dict[str, Any]) -> Dict[str, Any]:
    """Remove fields that aren't columns of plantplanner_plant_cache before insert/update."""
    return {k: v for k, v in row.items() if v is not None}


async def _upsert_normalized(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Insert-or-update normalized rows keyed by scientific_name. Returns full rows."""
    if not rows:
        return []
    sb = get_supabase()
    payloads = [
        _strip_internal_fields(r)
        for r in rows
        if r.get("scientific_name")
    ]
    if not payloads:
        return []
    result = (
        sb.table("plantplanner_plant_cache")
        .upsert(payloads, on_conflict="scientific_name")
        .execute()
    )
    return result.data or []


async def _enrich_with_perenual(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """For each row missing hardiness, look it up in Perenual and merge."""
    enriched: List[Dict[str, Any]] = []
    for row in rows:
        if row.get("hardiness_min") is not None or not row.get("scientific_name"):
            enriched.append(row)
            continue
        try:
            p_record = await perenual_lookup_by_scientific(row["scientific_name"])
        except Exception as exc:
            logger.info("Perenual enrich failed: %s", exc)
            p_record = None
        if not p_record:
            enriched.append(row)
            continue
        merged = merge_records(row, normalize_perenual(p_record))
        enriched.append(merged)
    return enriched


async def _mirror_images_for_rows(rows: List[Dict[str, Any]]) -> None:
    """Mirror each row's available image sizes; persist storage paths back to the table."""
    sb = get_supabase()
    for row in rows:
        if not row.get("id"):
            continue
        updates = await mirror_all_sizes(row)
        if not updates:
            continue
        updates["last_image_synced_at"] = "now()"
        try:
            sb.table("plantplanner_plant_cache").update(updates).eq("id", row["id"]).execute()
        except Exception as exc:
            logger.info("Image path persist failed for %s: %s", row.get("scientific_name"), exc)


def _build_cache_query(
    sb: Any,
    *,
    sunlight: Optional[str],
    watering: Optional[str],
    indoor: Optional[bool],
    zone: Optional[int],
    edible: Optional[bool],
    cycle: Optional[str],
    max_height_cm: Optional[int],
    max_spread_cm: Optional[int],
    query: Optional[str],
):
    q = sb.table("plantplanner_plant_cache").select("*")
    if sunlight:
        q = q.eq("sunlight", sunlight)
    if watering:
        q = q.eq("watering", watering)
    if indoor is True:
        q = q.eq("indoor", True)
    if zone is not None:
        q = q.lte("hardiness_min", zone).gte("hardiness_max", zone)
    if edible is True:
        q = q.eq("edible", True)
    if cycle:
        q = q.eq("cycle", cycle)
    if max_height_cm is not None:
        # Allow rows whose height is unknown OR within the cap.
        q = q.or_(f"height_max_cm.is.null,height_max_cm.lte.{max_height_cm}")
    if max_spread_cm is not None:
        q = q.or_(f"spread_cm.is.null,spread_cm.lte.{max_spread_cm}")
    if query:
        ilike = f"%{query.lower()}%"
        q = q.or_(f"common_name.ilike.{ilike},scientific_name.ilike.{ilike}")
    return q


def _shade_to_sunlight(shade_level: Optional[str]) -> Optional[str]:
    return {
        "full_sun": "full_sun",
        "partial": "part_shade",
        "shade": "full_shade",
    }.get(shade_level or "")


def _water_plan_to_watering(water_plan: Optional[str]) -> Optional[str]:
    return {
        "regular": "average",
        "occasional": "minimum",
        "rain_only": "minimum",
    }.get(water_plan or "")


def _zone_label_to_int(zone_label: Optional[str]) -> Optional[int]:
    if not zone_label:
        return None
    digits = "".join(ch for ch in zone_label if ch.isdigit())
    try:
        return int(digits) if digits else None
    except ValueError:
        return None


def _planting_season_to_cycle(season: Optional[str]) -> Optional[str]:
    """Map the wizard's planting_season to a plant `cycle` filter.

    Plants started in spring/summer are dominated by annuals (single-season
    crops). Fall-planted is heavily perennial (bulbs, shrubs, garlic). Winter
    planting is rare in temperate zones — leave unfiltered.
    """
    return {
        "spring": "annual",
        "summer": "annual",
        "fall":   "perennial",
    }.get((season or "").lower())


# Plant-size buckets keyed off the wizard's grid dims + garden_type. The cap
# cells stop a 4-inch pot from showing 10ft tomatoes.
PLANTER_SIZE_CAPS = {
    "small":  {"max_height_cm": 90,  "max_spread_cm": 60},
    "medium": {"max_height_cm": 200, "max_spread_cm": 150},
    "large":  {"max_height_cm": None, "max_spread_cm": None},
}


def _derive_planter_size(
    *,
    garden_type: Optional[str],
    grid_width: Optional[int],
    grid_height: Optional[int],
) -> Optional[str]:
    """Map (garden_type, dims) to a small/medium/large bucket.

    Inch-unit types (pots, planter boxes) bucket on the longer side directly
    in inches. Foot-unit types bucket on area in square feet.
    """
    if not garden_type:
        return None
    if garden_uses_inches(garden_type):
        if grid_width is None or grid_height is None:
            return "small"
        longest = max(grid_width, grid_height)
        if longest <= 18:
            return "small"
        if longest <= 30:
            return "medium"
        return "large"
    if grid_width is None or grid_height is None:
        return "medium"
    sq_ft = grid_width * grid_height
    if sq_ft <= 16:
        return "small"
    if sq_ft <= 50:
        return "medium"
    return "large"


async def _trigger_lazy_fill(
    *,
    query: Optional[str],
    sunlight: Optional[str],
    edible: Optional[bool],
) -> int:
    """Hit Trefle (and Perenual for hardiness) and write results to cache. Returns rows added."""
    trefle_records: List[Dict[str, Any]] = []
    if query:
        trefle_records = await trefle_search(query)
    if not trefle_records:
        light_min = 7 if sunlight == "full_sun" else 4 if sunlight == "part_shade" else None
        trefle_records = await trefle_filter(edible=edible, light_min=light_min)
    if not trefle_records:
        return 0

    normalized = [normalize_trefle(r) for r in trefle_records]
    enriched = await _enrich_with_perenual(normalized)
    written = await _upsert_normalized(enriched)
    # Image mirroring is fire-and-forget for this request — populate progressively.
    try:
        await _mirror_images_for_rows(written)
    except Exception as exc:
        logger.info("Image mirror sweep failed: %s", exc)
    return len(written)


@router.get(
    "/catalog/search",
    response_model=CatalogSearchResponse,
    status_code=200,
    summary="Search the cached plant catalog with planter conditions",
)
async def catalog_search(
    query: Optional[str] = Query(None, description="Free-text query (common or scientific name)"),
    sunlight: Optional[str] = Query(None, description="full_sun | part_shade | full_shade"),
    watering: Optional[str] = Query(None, description="frequent | average | minimum | none"),
    indoor: Optional[bool] = Query(None, description="True to require indoor-tolerant plants"),
    zone: Optional[int] = Query(None, description="USDA zone number (e.g. 6)"),
    edible: Optional[bool] = Query(None, description="True to require edible"),
    cycle: Optional[str] = Query(None, description="annual | perennial | biennial"),
    max_height_cm: Optional[int] = Query(None, ge=1, description="Cap on height_max_cm; null heights pass."),
    max_spread_cm: Optional[int] = Query(None, ge=1, description="Cap on spread_cm; null spreads pass."),
    shade_level: Optional[str] = Query(None, description="Wizard's shade_level — auto-maps to sunlight"),
    water_plan: Optional[str] = Query(None, description="Wizard's water_plan — auto-maps to watering"),
    usda_zone: Optional[str] = Query(None, description="Wizard's usda_zone label (e.g. 6b)"),
    planting_season: Optional[str] = Query(None, description="Wizard's planting_season — auto-maps to cycle"),
    garden_type: Optional[str] = Query(None, description="Wizard's garden_type — combined with grid dims to derive size caps"),
    grid_width: Optional[int] = Query(None, ge=1, description="Wizard grid_width; ft for outdoor types, in for indoor"),
    grid_height: Optional[int] = Query(None, ge=1, description="Wizard grid_height; ft for outdoor types, in for indoor"),
    planter_size: Optional[str] = Query(None, description="Override the derived bucket: small | medium | large"),
    limit: int = Query(SEARCH_RESULT_CAP, ge=1, le=50),
) -> CatalogSearchResponse:
    """List cache plants matching the wizard's planter conditions; lazy-fill on miss."""
    effective_sunlight = sunlight or _shade_to_sunlight(shade_level)
    effective_watering = watering or _water_plan_to_watering(water_plan)
    effective_zone = zone if zone is not None else _zone_label_to_int(usda_zone)
    effective_cycle = cycle or _planting_season_to_cycle(planting_season)

    # Climate-controlled planters require indoor-tolerant plants. Outdoor pots
    # are exposed to the user's actual zone — they do NOT force indoor=True.
    effective_indoor = indoor
    if effective_indoor is None and garden_is_climate_controlled(garden_type):
        effective_indoor = True

    # Plant-size caps come from explicit planter_size (override) or are derived
    # from garden_type + grid dims. max_height_cm / max_spread_cm overrides win.
    bucket = planter_size or _derive_planter_size(
        garden_type=garden_type,
        grid_width=grid_width,
        grid_height=grid_height,
    )
    caps = PLANTER_SIZE_CAPS.get(bucket or "", {}) if bucket else {}
    effective_max_height = max_height_cm if max_height_cm is not None else caps.get("max_height_cm")
    effective_max_spread = max_spread_cm if max_spread_cm is not None else caps.get("max_spread_cm")

    sb = get_supabase()
    def _q():
        return _build_cache_query(
            sb,
            sunlight=effective_sunlight,
            watering=effective_watering,
            indoor=effective_indoor,
            zone=effective_zone,
            edible=edible,
            cycle=effective_cycle,
            max_height_cm=effective_max_height,
            max_spread_cm=effective_max_spread,
            query=query,
        ).limit(limit)

    rows: List[Dict[str, Any]] = (_q().execute().data or [])

    fill_triggered = False
    if len(rows) < LAZY_FILL_THRESHOLD:
        fill_triggered = True
        added = await _trigger_lazy_fill(
            query=query,
            sunlight=effective_sunlight,
            edible=edible,
        )
        if added:
            rows = (_q().execute().data or [])

    return CatalogSearchResponse(
        plants=[_row_to_catalog_plant(r) for r in rows],
        total=len(rows),
        fill_triggered=fill_triggered,
    )


@router.get(
    "/catalog/{cache_id}",
    response_model=CatalogPlant,
    status_code=200,
    summary="Get a single cached plant; lazy-enriches hardiness on first call",
)
async def catalog_detail(cache_id: str) -> CatalogPlant:
    """Return a cached plant. If hardiness is missing, enrich via Perenual and persist."""
    sb = get_supabase()
    row_resp = (
        sb.table("plantplanner_plant_cache")
        .select("*")
        .eq("id", cache_id)
        .execute()
    )
    if not row_resp.data:
        raise HTTPException(status_code=404, detail="Plant not found")
    row = row_resp.data[0]

    if row.get("hardiness_min") is None and row.get("scientific_name"):
        try:
            p_record = await perenual_lookup_by_scientific(row["scientific_name"])
        except Exception as exc:
            logger.info("Perenual detail enrich failed: %s", exc)
            p_record = None
        if p_record:
            merged = merge_records(row, normalize_perenual(p_record))
            written = await _upsert_normalized([merged])
            if written:
                row = written[0]

    # Mirror any newly-discovered images in the background (best-effort).
    try:
        updates = await mirror_all_sizes(row)
        if updates:
            updates["last_image_synced_at"] = "now()"
            sb.table("plantplanner_plant_cache").update(updates).eq("id", row["id"]).execute()
            row.update(updates)
    except Exception as exc:
        logger.info("Detail image mirror failed: %s", exc)

    return _row_to_catalog_plant(row)
