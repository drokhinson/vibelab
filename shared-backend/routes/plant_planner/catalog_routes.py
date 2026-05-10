"""Plant catalog routes — cache-first reads, lazy fill on miss.

The user-facing read paths (search, detail) ALWAYS query
`plantplanner_plant_cache` directly. External API calls only happen as a
side effect of cache fill (when the user-supplied criteria turn up too few
local matches) or cache enrich (when a detail panel needs a hardiness zone
that wasn't captured at first sync).

Phase 1: shopping step + builder shortlist consume `/catalog/search`.
"""

from __future__ import annotations

import asyncio
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
    perenual_filter,
    perenual_get,
    perenual_lookup_by_scientific,
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


_PERENUAL_DETAILS_CONCURRENCY = 5


async def _hydrate_perenual_details(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Fan out species-details calls for every species-list summary in `records`.

    Perenual's /species-list returns a slim summary (id, names, watering,
    sunlight, cycle, default_image). The detail fields the popup needs —
    family, hardiness, indoor, dimensions, description, care_level, soil,
    growing_months, attracts, etc. — only land via /species/details/{id}.

    Calls are concurrent under a semaphore to keep peak Perenual QPS modest;
    a failed details call falls back to the list summary so the row still
    gets the basics (name + image).
    """
    if not records:
        return []
    sem = asyncio.Semaphore(_PERENUAL_DETAILS_CONCURRENCY)

    async def _fetch(rec: Dict[str, Any]) -> Dict[str, Any]:
        rid = rec.get("id")
        try:
            rid_int = int(rid) if rid is not None else None
        except (TypeError, ValueError):
            rid_int = None
        if rid_int is None:
            return rec
        async with sem:
            try:
                detail = await perenual_get(rid_int)
            except Exception as exc:
                logger.info("Perenual species-details failed for id=%s: %s", rid_int, exc)
                return rec
        if not detail:
            return rec
        # Details payload is a strict superset of the list summary.
        merged = dict(rec)
        merged.update(detail)
        return merged

    return await asyncio.gather(*[_fetch(r) for r in records])


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


async def _trigger_lazy_fill(
    *,
    query: Optional[str],
    sunlight: Optional[str],
    edible: Optional[bool],
) -> int:
    """Hit Perenual species-list (with details hydration) and persist. Returns rows added.

    Mirrors `fill_perenual` but is invoked from `/catalog/search` when the
    cache returns fewer than `LAZY_FILL_THRESHOLD` matches. Image mirroring
    is opportunistic — a failure doesn't block the response since the
    popup falls back to the original Perenual CDN URL.
    """
    try:
        records = await perenual_filter(
            sunlight=sunlight,
            edible=edible,
            query=query,
        )
    except Exception as exc:
        logger.info("Perenual lazy fill failed: %s", exc)
        return 0
    if not records:
        return 0

    hydrated = await _hydrate_perenual_details(records)
    normalized = [n for n in (normalize_perenual(r) for r in hydrated) if n.get("scientific_name")]
    if not normalized:
        return 0
    written = await _upsert_normalized(normalized)
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
    "/catalog/{cache_id}/refresh",
    response_model=CatalogPlant,
    status_code=200,
    summary="Re-pull a single cache row from Perenual species-details and upsert",
)
async def refresh_from_perenual(cache_id: str) -> CatalogPlant:
    """Backfill a cache row by re-running the Perenual species-details lookup.

    Powers the popup's "Refresh from Perenual" button — handy when the
    species-details fan-out at import time was rate-limited or otherwise
    failed and a row landed with sparse data.
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

    # Resolve a Perenual species id. Prefer the stored source_id when this
    # row originally came from Perenual; otherwise look up by name.
    perenual_id: Optional[int] = None
    source = (row.get("source") or "").lower()
    raw_source_id = (row.get("source_id") or "").strip()
    if source == "perenual" and raw_source_id:
        try:
            perenual_id = int(raw_source_id)
        except ValueError:
            perenual_id = None
    if perenual_id is None:
        sci = (row.get("scientific_name") or "").strip()
        if not sci:
            raise HTTPException(status_code=404, detail="Cache row has no name to look up")
        try:
            p_record = await perenual_lookup_by_scientific(sci)
        except Exception as exc:
            logger.exception("Perenual lookup failed for %r", sci)
            raise HTTPException(status_code=502, detail=f"Perenual request failed: {exc}")
        if not p_record:
            raise HTTPException(status_code=404, detail="No Perenual match found")
        try:
            perenual_id = int(p_record.get("id"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=502, detail="Perenual returned a record with no id")

    try:
        detail = await perenual_get(perenual_id)
    except Exception as exc:
        logger.exception("Perenual species-details failed for id=%s", perenual_id)
        raise HTTPException(status_code=502, detail=f"Perenual request failed: {exc}")
    if not detail:
        raise HTTPException(status_code=502, detail="Perenual returned no detail payload")

    normalized = normalize_perenual(detail)
    # Pin the existing primary key so the upsert updates this row in place.
    normalized["id"] = row["id"]
    written = await _upsert_normalized([normalized])
    if not written:
        raise HTTPException(status_code=500, detail="Failed to persist refreshed row")

    return _row_to_catalog_plant(written[0])


# ── Cache-fill orchestration ────────────────────────────────────────────────
#
# Drive each external API as a discrete, observable step so the frontend's
# plant-selection screen can render a to-do list while creating a new planter:
#   1. (frontend) save planter
#   2. POST /catalog/fill/perenual    — filtered species-list + per-row
#                                       species-details hydration → upsert
#   3. POST /catalog/fill/compatible  — count plants matching planter conditions
# Steps 2–3 take the same wizard-conditions body and are independently
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
    "/catalog/fill/perenual",
    response_model=FillStepResponse,
    status_code=200,
    summary="Step 2: seed the cache with a Perenual species-list filtered to the wizard conditions",
)
async def fill_perenual(body: FillBody) -> FillStepResponse:
    """Query Perenual v2/species-list with wizard filters and hydrate every hit.

    Perenual's filter params align with the wizard's filter logic
    (cycle, watering, sunlight, hardiness, indoor, edible). The species-list
    response only carries the slim summary, so we follow up with one
    species-details call per hit (concurrency capped at
    `_PERENUAL_DETAILS_CONCURRENCY`) so the upsert writes the full
    normalized field set (family, hardiness, dimensions, growth_rate, …)
    plus the rich `raw_perenual_json` payload the popup reads from.
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

    hydrated = await _hydrate_perenual_details(records)

    normalized: List[Dict[str, Any]] = []
    sci_names: List[str] = []
    for r in hydrated:
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

    return FillStepResponse(status="ok", fetched=len(records), new_plants=new_plants)


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
