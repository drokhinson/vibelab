"""Scrap enrichment orchestrator: fetch page → Haiku extract → geocode.

Runs as a FastAPI background task after POST /scraps returns 201. Never
raises — every failure path writes status='failed' + error_kind so the
frontend can offer a retry. Partial success (e.g. place extracted but not
geocoded) still lands as 'ready' with geocode_confidence='none'; the user
can edit fields and re-geocode.
"""

import logging
from typing import Any, Optional
from urllib.parse import quote

from db import get_supabase

from ..constants import EnrichErrorKind, GeocodeConfidence, ScrapStatus
from . import llm, nominatim, scraper

logger = logging.getLogger("travel_scrapbook.enrichment")


def build_maps_url(place_name: str, city: Optional[str], country: Optional[str]) -> str:
    """Google Maps search link — a plain URL, no API key involved."""
    parts = [place_name] + [p for p in (city, country) if p]
    return "https://www.google.com/maps/search/?api=1&query=" + quote(", ".join(parts))


async def _geocode_with_fallback(
    extraction: llm.PlaceExtraction,
) -> tuple[Optional[nominatim.GeocodeResult], GeocodeConfidence]:
    """Try increasingly loose queries; report how loose the match was."""
    name, city, country = extraction.place_name, extraction.city, extraction.country

    attempts: list[tuple[str, GeocodeConfidence]] = []
    if extraction.geocode_query:
        attempts.append((extraction.geocode_query, GeocodeConfidence.HIGH))
    if name and city:
        attempts.append((", ".join(p for p in (name, city, country) if p), GeocodeConfidence.HIGH))
    if name and country:
        attempts.append((f"{name}, {country}", GeocodeConfidence.MEDIUM))
    if city:
        attempts.append((", ".join(p for p in (city, country) if p), GeocodeConfidence.LOW))

    seen: set[str] = set()
    for query, confidence in attempts:
        key = query.lower().strip()
        if key in seen:
            continue
        seen.add(key)
        result = await nominatim.geocode(query)
        if result:
            return result, confidence
    return None, GeocodeConfidence.NONE


def _load_category_slugs(sb) -> list[str]:
    rows = (
        sb.table("travelscrapbook_categories")
        .select("slug")
        .order("sort_order")
        .execute()
    )
    return [r["slug"] for r in (rows.data or [])] or ["other"]


async def enrich_scrap(scrap_id: str) -> None:
    """Full enrichment pipeline for one scrap. Safe to re-run (retry)."""
    sb = get_supabase()
    row = (
        sb.table("travelscrapbook_scraps")
        .select("id, source_url")
        .eq("id", scrap_id)
        .execute()
    )
    if not row.data:
        return  # deleted while queued
    url = row.data[0]["source_url"]

    update: dict[str, Any] = {}
    try:
        # 1. Fetch the page — degradable. Blocked/unreachable pages still get
        #    a URL-only LLM pass (slugs often name the place).
        page: Optional[scraper.PageContent] = None
        fetch_error: Optional[scraper.ScrapeError] = None
        try:
            page = await scraper.fetch_page(url)
            update.update({
                "og_title": page.og_title or page.title,
                "og_description": page.og_description,
                "og_image_url": page.og_image,
            })
        except scraper.ScrapeError as exc:
            fetch_error = exc
            logger.info("scrap %s: page fetch degraded (%s)", scrap_id, exc.kind)

        # 2. LLM place extraction — required. If this fails we mark failed.
        try:
            categories = _load_category_slugs(sb)
            extraction = await llm.extract_place(url, page, categories)
        except llm.LLMError as exc:
            logger.warning("scrap %s: LLM failed: %s", scrap_id, exc)
            kind = EnrichErrorKind.LLM
            if fetch_error is not None:
                kind = (
                    EnrichErrorKind.NETWORK
                    if fetch_error.kind == scraper.ScrapeErrorKind.NETWORK
                    else EnrichErrorKind.BLOCKED
                )
            update.update({"status": ScrapStatus.FAILED, "error_kind": kind})
            return

        update.update({
            "place_name": extraction.place_name,
            "place_city": extraction.city,
            "place_country": extraction.country,
            "category": extraction.category,
        })

        # 3. Geocode — best-effort.
        if extraction.place_name or extraction.city:
            result, confidence = await _geocode_with_fallback(extraction)
            if result:
                update.update({
                    "lat": result.lat,
                    "lng": result.lng,
                    "geocode_confidence": confidence,
                    "geocode_display_name": result.display_name,
                })

        # 4. Maps link (name-based reads better than raw coordinates).
        if extraction.place_name:
            update["maps_url"] = build_maps_url(
                extraction.place_name, extraction.city, extraction.country
            )

        update.update({"status": ScrapStatus.READY, "error_kind": None})
    except Exception:
        # Absolute backstop — background tasks must never explode silently
        # into uvicorn logs without moving the row out of 'pending'.
        logger.exception("scrap %s: unexpected enrichment failure", scrap_id)
        update.update({"status": ScrapStatus.FAILED, "error_kind": EnrichErrorKind.LLM})
    finally:
        update["updated_at"] = "now()"
        sb.table("travelscrapbook_scraps").update(update).eq("id", scrap_id).execute()
