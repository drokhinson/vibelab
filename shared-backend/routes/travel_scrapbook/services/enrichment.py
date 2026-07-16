"""Source enrichment orchestrator: fetch page → Gemini extract → places → scraps.

Runs as a FastAPI background task after POST /capture returns 202. Never
raises — every failure path writes the source's status='failed' + error_kind
so the frontend can offer a retry. One source fans out into N places; each
place the user hasn't saved yet becomes a scrap that is auto-staged onto a
nearby trip (awaiting review), approved directly when the capture carried an
explicit trip hint, or dropped into the inbox.

A URL the LLM classifies as a lodging/transport BOOKING (hotel reservation,
flight itinerary...) captured with a trip context becomes a checkpoint (a
stay/travel anchor) on that trip instead, with its dates filled in.
"""

import logging
from typing import Any, Optional
from urllib.parse import quote

from db import get_supabase

from ..constants import (
    AnchorRole,
    AnchorType,
    BookingKind,
    EnrichErrorKind,
    GeocodeConfidence,
    ScrapStatus,
    SourceStatus,
)
from . import llm, nominatim, places, scraper

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


def _user_has_scrap_for_place(sb, user_id: str, place_id: str) -> bool:
    rows = (
        sb.table("travelscrapbook_scraps")
        .select("id")
        .eq("user_id", user_id)
        .eq("place_id", place_id)
        .limit(1)
        .execute()
    )
    return bool(rows.data)


async def _materialize_place(
    sb,
    source: dict[str, Any],
    extraction: llm.PlaceExtraction,
) -> None:
    """One extraction → deduped place + source link (+ scrap if new to the user)."""
    geo, confidence = await _geocode_with_fallback(extraction)
    maps_url = build_maps_url(extraction.place_name, extraction.city, extraction.country)

    place, _created = places.find_or_create_place(
        sb, source["user_id"], extraction, geo, confidence, maps_url
    )

    # Attach the source to the place regardless of scrap dedupe — collecting
    # "how the user stumbled on this" across many URLs IS the point.
    sb.table("travelscrapbook_place_sources").upsert(
        {"place_id": place["id"], "source_id": source["id"]},
        on_conflict="place_id,source_id",
        ignore_duplicates=True,
    ).execute()

    if _user_has_scrap_for_place(sb, source["user_id"], place["id"]):
        return  # already saved — the new source chip is the only change

    scrap: dict[str, Any] = {
        "user_id": source["user_id"],
        "place_id": place["id"],
        "trip_id": None,
        "status": ScrapStatus.INBOX,
        "notes": source.get("capture_notes"),
    }
    if source.get("trip_hint_id"):
        # The user picked the trip at capture time — no review needed.
        scrap.update({"trip_id": source["trip_hint_id"], "status": ScrapStatus.APPROVED})
    elif place["lat"] is not None and extraction.confident:
        match = places.match_trip(sb, source["user_id"], place)
        if match:
            scrap.update({"trip_id": match["id"], "status": ScrapStatus.STAGED})
    sb.table("travelscrapbook_scraps").insert(scrap).execute()


async def _materialize_checkpoint(
    sb, source: dict[str, Any], booking: llm.BookingExtraction
) -> bool:
    """A booking link captured with a trip context becomes a checkpoint (a
    stay/travel anchor) on that trip, dates filled in from the page. Without a
    trip there is nowhere to hang it — the caller falls back to the place flow.
    Re-capturing the same booking updates the existing checkpoint in place.
    Returns True when a checkpoint row was written."""
    trip_id = source.get("trip_hint_id")
    if not trip_id:
        return False

    role = AnchorRole.STAY if booking.kind == BookingKind.STAY else AnchorRole.TRAVEL
    query = booking.location or booking.label
    geo = await nominatim.geocode(query)
    row: dict[str, Any] = {
        "trip_id": trip_id,
        "role": role,
        "label": booking.label,
        "query": query,
        "lat": geo.lat if geo else None,
        "lng": geo.lng if geo else None,
        "geocode_confidence": GeocodeConfidence.HIGH if geo else GeocodeConfidence.NONE,
    }
    if role == AnchorRole.STAY:
        row.update({
            "stay_date": booking.start_date,
            "stay_end_date": booking.end_date,
        })
    else:
        row.update({
            "type": booking.transport_type or AnchorType.OTHER,
            "anchor_date": booking.start_date,
            "anchor_time": booking.time,
        })

    existing = (
        sb.table("travelscrapbook_anchors")
        .select("id, label")
        .eq("trip_id", trip_id)
        .eq("role", role)
        .execute()
    ).data or []
    match = next(
        (a for a in existing if (a.get("label") or "").casefold() == booking.label.casefold()),
        None,
    )
    if match:
        sb.table("travelscrapbook_anchors").update(row).eq("id", match["id"]).execute()
    else:
        sb.table("travelscrapbook_anchors").insert(row).execute()
    return True


async def process_source(source_id: str) -> None:
    """Full enrichment pipeline for one source. Safe to re-run (retry)."""
    sb = get_supabase()
    row = (
        sb.table("travelscrapbook_sources")
        .select("id, user_id, url, shared_text, capture_notes, trip_hint_id")
        .eq("id", source_id)
        .execute()
    )
    if not row.data:
        return  # deleted while queued
    source = row.data[0]
    url = source["url"]

    update: dict[str, Any] = {}
    try:
        # 1. Fetch the page — degradable. Blocked/unreachable pages still get
        #    a URL-only LLM pass (slugs + share-sheet text often name places).
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
            logger.info("source %s: page fetch degraded (%s)", source_id, exc.kind)

        # 2. LLM place extraction — required. If this fails we mark failed.
        try:
            categories = _load_category_slugs(sb)
            extractions, booking = await llm.extract_places(
                url, page, categories, shared_text=source.get("shared_text")
            )
        except llm.LLMError as exc:
            logger.warning("source %s: LLM failed: %s", source_id, exc)
            kind = EnrichErrorKind.LLM
            if fetch_error is not None:
                kind = (
                    EnrichErrorKind.NETWORK
                    if fetch_error.kind == scraper.ScrapeErrorKind.NETWORK
                    else EnrichErrorKind.BLOCKED
                )
            update.update({"status": SourceStatus.FAILED, "error_kind": kind})
            return

        # 2b. Booking pages (hotel/flight/train reservations or listings)
        #     captured onto a trip become a checkpoint with dates filled in.
        #     Without a trip context the booking falls through to the normal
        #     place flow (the LLM lists the lodging/destination in places too).
        checkpoint_created = False
        if booking is not None:
            try:
                checkpoint_created = await _materialize_checkpoint(sb, source, booking)
            except Exception:
                logger.exception("source %s: failed to materialize booking", source_id)
        if checkpoint_created:
            # The page is about the stay/leg itself — the checkpoint replaces
            # the place scraps so the hotel doesn't double as a plan.
            extractions = []

        if not extractions and not checkpoint_created:
            update.update({
                "status": SourceStatus.FAILED,
                "error_kind": EnrichErrorKind.NO_PLACE,
            })
            return

        # 3. Fan out: place per extraction, serially — the Nominatim throttle
        #    (≥1.1s spacing) makes serial the polite and simple choice.
        errors = 0
        for extraction in extractions:
            try:
                await _materialize_place(sb, source, extraction)
            except Exception:
                errors += 1
                logger.exception(
                    "source %s: failed to materialize %r", source_id, extraction.place_name
                )

        if errors and errors == len(extractions):
            # Every place hit a real error (e.g. a schema/DB failure) — don't
            # pretend success. Surface it in the inbox "Couldn't read" pile so a
            # broken import is visible and retryable instead of vanishing.
            update.update({
                "status": SourceStatus.FAILED,
                "error_kind": EnrichErrorKind.INTERNAL,
            })
            return
        update.update({"status": SourceStatus.READY, "error_kind": None})
    except Exception:
        # Absolute backstop — background tasks must never explode silently
        # into uvicorn logs without moving the row out of 'processing'.
        logger.exception("source %s: unexpected enrichment failure", source_id)
        update.update({"status": SourceStatus.FAILED, "error_kind": EnrichErrorKind.LLM})
    finally:
        update["updated_at"] = "now()"
        sb.table("travelscrapbook_sources").update(update).eq("id", source_id).execute()
