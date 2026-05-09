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
    shade_level: Optional[str] = Query(None, description="Wizard's shade_level — auto-maps to sunlight"),
    water_plan: Optional[str] = Query(None, description="Wizard's water_plan — auto-maps to watering"),
    usda_zone: Optional[str] = Query(None, description="Wizard's usda_zone label (e.g. 6b)"),
    limit: int = Query(SEARCH_RESULT_CAP, ge=1, le=50),
) -> CatalogSearchResponse:
    """List cache plants matching the wizard's planter conditions; lazy-fill on miss."""
    effective_sunlight = sunlight or _shade_to_sunlight(shade_level)
    effective_watering = watering or _water_plan_to_watering(water_plan)
    effective_zone = zone if zone is not None else _zone_label_to_int(usda_zone)

    sb = get_supabase()
    q = _build_cache_query(
        sb,
        sunlight=effective_sunlight,
        watering=effective_watering,
        indoor=indoor,
        zone=effective_zone,
        edible=edible,
        query=query,
    ).limit(limit)
    result = q.execute()
    rows: List[Dict[str, Any]] = result.data or []

    fill_triggered = False
    if len(rows) < LAZY_FILL_THRESHOLD:
        fill_triggered = True
        added = await _trigger_lazy_fill(
            query=query,
            sunlight=effective_sunlight,
            edible=edible,
        )
        if added:
            q2 = _build_cache_query(
                sb,
                sunlight=effective_sunlight,
                watering=effective_watering,
                indoor=indoor,
                zone=effective_zone,
                edible=edible,
                query=query,
            ).limit(limit)
            rows = (q2.execute().data or [])

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
