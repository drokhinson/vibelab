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
    FloraConfigError,
    flora_lookup_by_scientific,
    merge_records,
    normalize_flora,
    normalize_perenual,
    normalize_trefle,
    perenual_filter,
    perenual_lookup_by_scientific,
    trefle_filter,
    trefle_get,
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
    # Raw upstream payloads — surfaced so the frontend can render fields we
    # haven't yet promoted to first-class columns (description, care_level,
    # soil[], growing_months[], attracts[], poisonous_to_pets, distribution,
    # etc.). Treat as opaque key/value dicts; shape varies by API version.
    raw_perenual_json: Optional[Dict[str, Any]] = None
    raw_trefle_json: Optional[Dict[str, Any]] = None


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
        raw_perenual_json=row.get("raw_perenual_json"),
        raw_trefle_json=row.get("raw_trefle_json"),
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


# shade_level / water_plan now use Perenual's `sunlight` / `watering` enums
# directly — no runtime mapping needed. These thin wrappers stay so callers
# don't have to care; they normalize "" / unknown values to None.
_VALID_SUNLIGHT = {"full_sun", "sun-part_shade", "part_shade", "full_shade"}
_VALID_WATERING = {"frequent", "average", "minimum", "none"}


def _shade_to_sunlight(shade_level: Optional[str]) -> Optional[str]:
    return shade_level if shade_level in _VALID_SUNLIGHT else None


def _water_plan_to_watering(water_plan: Optional[str]) -> Optional[str]:
    return water_plan if water_plan in _VALID_WATERING else None


def _zone_label_to_int(zone_label: Optional[str]) -> Optional[int]:
    """Stored zone is now a plain integer string '1'-'13'. Tolerates legacy
    a/b half-zone suffixes for any rows in flight before migration 015."""
    if not zone_label:
        return None
    digits = "".join(ch for ch in zone_label if ch.isdigit())
    try:
        return int(digits) if digits else None
    except ValueError:
        return None


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


async def _trefle_lookup_for_row(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Find the best Trefle search hit for a cache row.

    Tries scientific_name first; falls back to common_name. Prefers an exact
    scientific-name match in the result set, otherwise returns the top hit.
    Returns the search-summary record only — call trefle_get(id) afterward
    for the deep growth/specifications nested fields.
    """
    sci = (row.get("scientific_name") or "").strip()
    common = (row.get("common_name") or "").strip()
    target_sci = sci.lower() if sci else None
    for q in (sci, common):
        if not q:
            continue
        try:
            hits = await trefle_search(q)
        except Exception as exc:
            logger.info("Trefle lookup search failed for %r: %s", q, exc)
            continue
        if not hits:
            continue
        if target_sci:
            for h in hits:
                if (h.get("scientific_name") or "").strip().lower() == target_sci:
                    return h
        return hits[0]
    return None


async def _trefle_record_with_detail(search_hit: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize a Trefle hit, hydrating growth/specifications via trefle_get
    when the search-summary record doesn't already include them. Without the
    detail call, normalize_trefle returns near-empty extras (height/pH/etc.
    live in the nested `growth` and `specifications` blocks)."""
    detail_rec: Optional[Dict[str, Any]] = None
    rec_id = search_hit.get("id")
    if rec_id is not None:
        try:
            detail_rec = await trefle_get(int(rec_id))
        except Exception as exc:
            logger.info("Trefle detail fetch failed for id=%s: %s", rec_id, exc)
    return normalize_trefle(search_hit, detail=detail_rec)


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
        # Trefle's light is 0–10; map our 4-tier sunlight enum onto a min cutoff.
        light_min = (
            7 if sunlight == "full_sun"
            else 5 if sunlight == "sun-part_shade"
            else 4 if sunlight == "part_shade"
            else None
        )
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
    # cycle is informative-only — kept on the cache row but not derived from
    # planting_season any more. The query param still works as an explicit
    # override for callers that want it.
    effective_cycle = cycle

    # Indoor planters require indoor-tolerant plants; outdoor planters
    # require non-indoor plants. Always send the boolean so Perenual filters
    # both directions (was previously None for outdoor → no filter).
    effective_indoor = indoor
    if effective_indoor is None and garden_type:
        effective_indoor = garden_is_climate_controlled(garden_type)
    # Indoor planters are climate-controlled — hardiness (outdoor cold zones)
    # doesn't apply. Drop the zone filter so tropicals etc. aren't excluded.
    if effective_indoor is True:
        effective_zone = None

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


@router.post(
    "/catalog/{cache_id}/enrich/trefle",
    response_model=CatalogPlant,
    status_code=200,
    summary="Look up a single cached plant on Trefle by name and merge new fields",
)
async def enrich_trefle(cache_id: str) -> CatalogPlant:
    """Search Trefle by scientific (then common) name, hydrate via trefle_get, merge.

    Powers the plant detail panel's "Import from Trefle" button: pulls the
    Trefle-strong fields (height, pH, days_to_harvest, toxicity, growth_rate,
    sowing) for plants that arrived via Perenual/Flora and are missing them.
    """
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
    if not (row.get("scientific_name") or row.get("common_name")):
        raise HTTPException(status_code=400, detail="Cache row has no name to look up")

    try:
        search_hit = await _trefle_lookup_for_row(row)
    except Exception as exc:
        logger.exception("Trefle enrich failed")
        raise HTTPException(status_code=502, detail=f"Trefle request failed: {exc}")
    if search_hit is None:
        raise HTTPException(status_code=404, detail="No Trefle match found")

    normalized = await _trefle_record_with_detail(search_hit)
    merged = merge_records(row, normalized)
    written = await _upsert_normalized([merged])
    if not written:
        raise HTTPException(status_code=500, detail="Failed to persist Trefle merge")

    new_row = written[0]
    try:
        await _mirror_images_for_rows(written)
    except Exception as exc:
        logger.info("Trefle enrich image mirror failed: %s", exc)

    return _row_to_catalog_plant(new_row)


# ── Cache-fill orchestration ────────────────────────────────────────────────
#
# Drive each external API as a discrete, observable step so the frontend's
# plant-selection screen can render a 5-item to-do list while creating a new
# planter:
#   1. (frontend) save planter
#   2. POST /catalog/fill/perenual    — filtered species-list seed → upsert
#   3. POST /catalog/fill/trefle      — fill missing height/pH/days_to_harvest
#   4. POST /catalog/fill/flora       — supplement with Flora data
#   5. POST /catalog/fill/compatible  — count plants matching planter conditions
# Steps 2–5 take the same wizard-conditions body and are independently
# idempotent. The frontend reports per-step status; the user can continue to
# the grid even if a step soft-fails (the final /catalog/search requery falls
# back to whatever the cache already holds).


class FillBody(BaseModel):
    """Wizard conditions used to drive each fill step."""
    shade_level: Optional[str] = None
    water_plan: Optional[str] = None
    usda_zone: Optional[str] = None
    planting_season: Optional[str] = None
    garden_type: Optional[str] = None
    grid_width: Optional[int] = None
    grid_height: Optional[int] = None
    edible: Optional[bool] = None
    query: Optional[str] = None


class FillStepResponse(BaseModel):
    status: str                       # ok | error
    fetched: int = 0                  # records returned by the upstream API
    new_plants: int = 0               # rows newly inserted into the cache
    enriched: int = 0                 # rows updated in place
    error: Optional[str] = None       # human-readable error if status != ok


class CompatibleStepResponse(BaseModel):
    status: str
    compatible_plants: int = 0
    total_in_cache: int = 0
    error: Optional[str] = None


def _build_query_from_body(body: FillBody) -> Dict[str, Any]:
    """Resolve the wizard payload into the same effective filters /catalog/search uses."""
    sunlight = _shade_to_sunlight(body.shade_level)
    watering = _water_plan_to_watering(body.water_plan)
    zone     = _zone_label_to_int(body.usda_zone)
    # cycle stays on the cached row but is no longer used as a filter (it's
    # informational); the planting_season → cycle bridge has been retired.
    cycle    = None
    # Always-explicit boolean: True for indoor planters, False for outdoor.
    indoor   = garden_is_climate_controlled(body.garden_type) if body.garden_type else None
    # Indoor planters are climate-controlled — USDA hardiness (which describes
    # outdoor cold-tolerance) doesn't apply. Drop the hardiness filter so we
    # don't exclude tropicals etc. from indoor-pot recommendations.
    if indoor is True:
        zone = None
    bucket = _derive_planter_size(
        garden_type=body.garden_type,
        grid_width=body.grid_width,
        grid_height=body.grid_height,
    )
    caps = PLANTER_SIZE_CAPS.get(bucket or "", {}) if bucket else {}
    return {
        "sunlight":   sunlight,
        "watering":   watering,
        "zone":       zone,
        "cycle":      cycle,
        "indoor":     indoor,
        "edible":     body.edible,
        "max_height_cm": caps.get("max_height_cm"),
        "max_spread_cm": caps.get("max_spread_cm"),
        "query":      body.query,
    }


@router.post(
    "/catalog/fill/trefle",
    response_model=FillStepResponse,
    status_code=200,
    summary="Step 3: enrich Perenual-seeded rows with Trefle (height, pH, days_to_harvest)",
)
async def fill_trefle(body: FillBody) -> FillStepResponse:
    """For matching cache rows missing Trefle-strong fields, look up by sci name and merge.

    Trefle is the primary source for height, pH, and days_to_harvest — fields
    Perenual doesn't expose. After Perenual seeds the cache, scan the matching
    rows and fill any Trefle gaps.
    """
    sb = get_supabase()
    filters = _build_query_from_body(body)
    candidates = (
        _build_cache_query(
            sb,
            sunlight=filters["sunlight"],
            watering=filters["watering"],
            indoor=filters["indoor"],
            zone=filters["zone"],
            edible=filters["edible"],
            cycle=filters["cycle"],
            max_height_cm=filters["max_height_cm"],
            max_spread_cm=filters["max_spread_cm"],
            query=filters["query"],
        )
        .limit(SEARCH_RESULT_CAP)
        .execute()
        .data
    ) or []

    targets = [
        r for r in candidates
        if r.get("height_max_cm") is None
        or r.get("ph_min") is None
        or r.get("days_to_harvest") is None
    ]
    if not targets:
        return FillStepResponse(status="ok", fetched=0, enriched=0)

    enriched_rows: List[Dict[str, Any]] = []
    fetched = 0
    try:
        for row in targets:
            search_hit = await _trefle_lookup_for_row(row)
            if search_hit is None:
                continue
            fetched += 1
            normalized = await _trefle_record_with_detail(search_hit)
            merged = merge_records(row, normalized)
            enriched_rows.append(merged)
    except Exception as exc:
        logger.exception("Trefle fill failed")
        return FillStepResponse(status="error", fetched=fetched, error=f"Trefle request failed: {exc}")

    written = await _upsert_normalized(enriched_rows) if enriched_rows else []
    try:
        await _mirror_images_for_rows(written)
    except Exception as exc:
        logger.info("Trefle fill image mirror failed: %s", exc)

    return FillStepResponse(status="ok", fetched=fetched, enriched=len(written))


@router.post(
    "/catalog/fill/perenual",
    response_model=FillStepResponse,
    status_code=200,
    summary="Step 2: seed the cache with a Perenual species-list filtered to the wizard conditions",
)
async def fill_perenual(body: FillBody) -> FillStepResponse:
    """Query Perenual v2/species-list with wizard filters; upsert results.

    Perenual's filter params now align with the wizard's filter logic
    (cycle, watering, sunlight, hardiness, indoor, edible). Using it as
    the seeding step captures cycle/watering/hardiness/sunlight/indoor
    plus all three image sizes in a single round trip.
    """
    sb = get_supabase()
    filters = _build_query_from_body(body)
    try:
        records = await perenual_filter(
            watering=filters["watering"],
            sunlight=filters["sunlight"],
            indoor=filters["indoor"],
            edible=filters["edible"],
            query=filters["query"],
        )
    except Exception as exc:
        logger.exception("Perenual fill failed")
        return FillStepResponse(status="error", error=f"Perenual request failed: {exc}")

    if not records:
        return FillStepResponse(status="ok", fetched=0, new_plants=0)

    normalized: List[Dict[str, Any]] = []
    sci_names: List[str] = []
    for r in records:
        n = normalize_perenual(r)
        sci = n.get("scientific_name")
        if not sci:
            continue
        normalized.append(n)
        sci_names.append(sci)

    pre_existing: set[str] = set()
    if sci_names:
        existing = (
            sb.table("plantplanner_plant_cache")
            .select("scientific_name")
            .in_("scientific_name", sci_names)
            .execute()
        )
        pre_existing = {row["scientific_name"] for row in (existing.data or [])}

    written = await _upsert_normalized(normalized)
    new_plants = sum(1 for row in written if row.get("scientific_name") not in pre_existing)

    try:
        await _mirror_images_for_rows(written)
    except Exception as exc:
        logger.info("Perenual fill image mirror failed: %s", exc)

    return FillStepResponse(status="ok", fetched=len(records), new_plants=new_plants)


@router.post(
    "/catalog/fill/flora",
    response_model=FillStepResponse,
    status_code=200,
    summary="Step 4: enrich cached plants with FloraAPI (US-flora supplemental data)",
)
async def fill_flora(body: FillBody) -> FillStepResponse:
    """Cross-check matching cache plants against Flora and merge any new fields."""
    sb = get_supabase()
    filters = _build_query_from_body(body)
    candidates = (
        _build_cache_query(
            sb,
            sunlight=filters["sunlight"],
            watering=filters["watering"],
            indoor=filters["indoor"],
            zone=filters["zone"],
            edible=filters["edible"],
            cycle=filters["cycle"],
            max_height_cm=filters["max_height_cm"],
            max_spread_cm=filters["max_spread_cm"],
            query=filters["query"],
        )
        .limit(SEARCH_RESULT_CAP)
        .execute()
        .data
    ) or []

    if not candidates:
        return FillStepResponse(status="ok", fetched=0, enriched=0)

    enriched_rows: List[Dict[str, Any]] = []
    fetched = 0
    try:
        for row in candidates:
            sci = row.get("scientific_name")
            if not sci:
                continue
            f_record = await flora_lookup_by_scientific(sci)
            if f_record is None:
                continue
            fetched += 1
            merged = merge_records(row, normalize_flora(f_record))
            enriched_rows.append(merged)
    except FloraConfigError:
        return FillStepResponse(status="error", error="FLORA_API_KEY is not configured on the server")
    except Exception as exc:
        logger.exception("Flora fill failed")
        return FillStepResponse(status="error", fetched=fetched, error=f"Flora request failed: {exc}")

    written = await _upsert_normalized(enriched_rows) if enriched_rows else []
    return FillStepResponse(status="ok", fetched=fetched, enriched=len(written))


@router.post(
    "/catalog/fill/compatible",
    response_model=CompatibleStepResponse,
    status_code=200,
    summary="Step 5: count cache plants compatible with the planter's conditions",
)
async def fill_compatible(body: FillBody) -> CompatibleStepResponse:
    """Apply the wizard's full filter set against the enriched cache; return a count."""
    sb = get_supabase()
    filters = _build_query_from_body(body)
    try:
        rows = (
            _build_cache_query(
                sb,
                sunlight=filters["sunlight"],
                watering=filters["watering"],
                indoor=filters["indoor"],
                zone=filters["zone"],
                edible=filters["edible"],
                cycle=filters["cycle"],
                max_height_cm=filters["max_height_cm"],
                max_spread_cm=filters["max_spread_cm"],
                query=filters["query"],
            )
            .limit(SEARCH_RESULT_CAP)
            .execute()
            .data
        ) or []
        total = (
            sb.table("plantplanner_plant_cache")
            .select("id", count="exact")
            .execute()
            .count
        ) or 0
    except Exception as exc:
        logger.exception("Compatible-count step failed")
        return CompatibleStepResponse(status="error", error=str(exc))

    return CompatibleStepResponse(
        status="ok",
        compatible_plants=len(rows),
        total_in_cache=int(total),
    )
