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
from dataclasses import replace
from typing import Any, Optional

from db import get_supabase

from ..constants import (
    AnchorRole,
    AnchorType,
    BookingKind,
    EnrichErrorKind,
    GeocodeConfidence,
    MembershipStatus,
    SourceStatus,
)
from . import checkpoints, gmaps, llm, nominatim, places, scraper, trails
from .places import build_maps_url

logger = logging.getLogger("travel_scrapbook.enrichment")


def _pin_name(geo: Optional[nominatim.GeocodeResult]) -> str:
    """A display name for a Maps pin that carried coords but no place name."""
    if geo:
        if geo.city:
            return geo.city
        if geo.display_name:
            return geo.display_name.split(",")[0].strip() or "Pinned location"
    return "Pinned location"


def _maps_extraction(mp: gmaps.MapsPlace) -> Optional[llm.PlaceExtraction]:
    """Build a PlaceExtraction straight from a parsed Google Maps URL — no LLM.
    The coordinates ride along so _materialize_place reverse-geocodes the exact
    pin rather than forward-geocoding a re-guessed query.

    When the URL yields NO pin (mp.lat is None), the place is left ungeocoded
    on purpose: forward-geocoding the bare, often-ambiguous Maps name lands
    confidently on the wrong same-named place. geocode_query stays None so
    _geocode_with_fallback makes zero attempts (→ GeocodeConfidence.NONE), and
    confident=False keeps a coordinate-less place out of trip auto-staging."""
    if mp.lat is None and not mp.name:
        return None
    return llm.PlaceExtraction(
        place_name=mp.name,
        city=None,
        country=None,
        category="other",
        geocode_query=None,
        confident=mp.lat is not None,
        lat=mp.lat,
        lng=mp.lng,
        maps_url=mp.expanded_url,
    )


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
    """Category slugs offered to the LLM. Checkpoint-only categories (020,
    via the cached checkpoints.checkpoint_category_slugs set) are held back so
    Gemini can't misfile a sight as "transport"; lodging stays in, since hotel
    listicles legitimately produce lodging scraps."""
    rows = (
        sb.table("travelscrapbook_categories")
        .select("slug")
        .order("sort_order")
        .execute()
    )
    cp_slugs = checkpoints.checkpoint_category_slugs(sb)
    slugs = [
        r["slug"] for r in (rows.data or [])
        if r["slug"] not in cp_slugs or r["slug"] == "lodging"
    ]
    return slugs or ["other"]


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
    if extraction.lat is not None and extraction.lng is not None:
        # A Google Maps pin: reverse-geocode the exact point for city/region/
        # country, but keep the URL's coordinates as the authoritative pin.
        geo = await nominatim.reverse(extraction.lat, extraction.lng)
        geo = (
            replace(geo, lat=extraction.lat, lng=extraction.lng)
            if geo
            else nominatim.GeocodeResult(
                lat=extraction.lat, lng=extraction.lng, display_name=""
            )
        )
        confidence = GeocodeConfidence.HIGH
    else:
        geo, confidence = await _geocode_with_fallback(extraction)

    if not extraction.place_name:
        extraction = replace(extraction, place_name=_pin_name(geo))
    maps_url = extraction.maps_url or build_maps_url(
        extraction.place_name, extraction.city, extraction.country
    )

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

    # The scrap is just the saved place now — its trip links live in
    # travelscrapbook_scrap_trips.
    inserted = (
        sb.table("travelscrapbook_scraps")
        .insert({
            "user_id": source["user_id"],
            "place_id": place["id"],
            "notes": source.get("capture_notes"),
        })
        .execute()
    ).data
    scrap_id = inserted[0]["id"] if inserted else None
    if not scrap_id:
        return

    # Attach a trip membership: the user's explicit pick (approved, no review) or
    # an auto-matched trip by scope (staged, awaiting review).
    membership: Optional[dict[str, Any]] = None
    if source.get("trip_hint_id"):
        membership = {
            "scrap_id": scrap_id, "trip_id": source["trip_hint_id"],
            "status": MembershipStatus.APPROVED,
        }
    elif place["lat"] is not None and extraction.confident:
        match = places.match_trip(sb, source["user_id"], place)
        if match:
            membership = {
                "scrap_id": scrap_id, "trip_id": match["id"],
                "status": MembershipStatus.STAGED,
            }
    if membership:
        sb.table("travelscrapbook_scrap_trips").insert(membership).execute()


async def _materialize_checkpoint(
    sb, source: dict[str, Any], booking: llm.BookingExtraction
) -> bool:
    """A booking link captured with a trip context becomes a checkpoint on that
    trip: a place + scrap (deduped like any capture, so it also shows on the
    Wander List under Stays & transport) + a role-bearing membership with the
    dates filled in from the page (020). Without a trip there is nowhere to
    hang the role — the caller falls back to the place flow, which still files
    the lodging/transport place itself. Re-capturing the same booking updates
    the existing checkpoint's dates (place dedupe replaces the old label
    matching). Returns True when a checkpoint membership was written."""
    trip_id = source.get("trip_hint_id")
    if not trip_id:
        return False

    role = AnchorRole.STAY if booking.kind == BookingKind.STAY else AnchorRole.TRAVEL
    category = checkpoints.category_for(
        role, booking.transport_type or AnchorType.OTHER
    )
    place, scrap = await checkpoints.materialize_checkpoint_scrap(
        sb, source["user_id"],
        label=booking.label,
        category=category,
        query=booking.location or booking.label,
        # URL-capture is the AI entry point: geocode the extracted location so
        # the booking still lands on the map (manual add-by-name does not).
        geocode_query=True,
    )
    # The booking URL is how the user stumbled on this place — attach it, same
    # as the ordinary place flow does.
    sb.table("travelscrapbook_place_sources").upsert(
        {"place_id": place["id"], "source_id": source["id"]},
        on_conflict="place_id,source_id",
        ignore_duplicates=True,
    ).execute()

    if role == AnchorRole.STAY:
        dates: dict[str, Any] = {
            "plan_date": booking.start_date,
            "plan_end_date": booking.end_date,
        }
    else:
        dates = {
            "plan_date": booking.start_date,
            "plan_time": booking.time,
        }

    # Re-capture matching, in legacy spirit: the same booking (same label) on
    # this trip updates its checkpoint in place — including REPOINTING to a new
    # place when the property moved beyond the dedupe radius — instead of
    # stacking a second stay. Match by scrap OR by the booking label's
    # normalized name among this role's checkpoints.
    label_norm = places.normalize_place_name(booking.label)
    existing = (
        sb.table("travelscrapbook_scrap_trips")
        .select("id, scrap_id, travelscrapbook_scraps(place_id, "
                "travelscrapbook_places(name_normalized))")
        .eq("trip_id", trip_id)
        .eq("role", role)
        .execute()
    ).data or []
    match = next(
        (m for m in existing if m["scrap_id"] == scrap["id"]
         or ((m.get("travelscrapbook_scraps") or {}).get("travelscrapbook_places") or {})
            .get("name_normalized") == label_norm),
        None,
    )
    if match:
        sb.table("travelscrapbook_scrap_trips").update({
            "scrap_id": scrap["id"],   # repoint if the booking's place changed
            **dates,
        }).eq("id", match["id"]).execute()
    else:
        sb.table("travelscrapbook_scrap_trips").insert({
            "scrap_id": scrap["id"],
            "trip_id": trip_id,
            "role": role,
            "status": MembershipStatus.APPROVED,
            **dates,
        }).execute()
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
        # 0. Google Maps links parse to themselves — the URL already names the
        #    place and encodes its exact pin, so skip the page fetch + LLM
        #    (which re-guesses from scraped text and can drift to a different
        #    location). Fall through to the normal path if parsing yields nothing.
        if gmaps.is_maps_url(url):
            mp = await gmaps.parse_maps_url(url)
            extraction = _maps_extraction(mp) if mp else None
            if extraction is not None:
                try:
                    await _materialize_place(sb, source, extraction)
                    update.update({"status": SourceStatus.READY, "error_kind": None})
                except Exception:
                    logger.exception("source %s: failed to materialize maps pin", source_id)
                    update.update({
                        "status": SourceStatus.FAILED,
                        "error_kind": EnrichErrorKind.INTERNAL,
                    })
                return

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

        # 2c. Trail sites (Komoot, AllTrails, Strava…) are hikes — force the
        #     category regardless of the LLM's guess. The trailhead still
        #     geocodes normally from the extraction below.
        if trails.is_trail_url(url):
            extractions = [replace(e, category="hike") for e in extractions]

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
