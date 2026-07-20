"""Source enrichment orchestrator: fetch page → Gemini extract → places → scraps.

Runs as a FastAPI background task after POST /capture returns 202. Never
raises — every failure path writes the source's status='failed' + error_kind
so the frontend can offer a retry. One source fans out into N places; each
place the user hasn't saved yet becomes a scrap that is auto-staged onto a
nearby trip (awaiting review), approved directly when the capture carried an
explicit trip hint, or dropped into the inbox.

A URL the LLM classifies as a lodging/transport BOOKING (hotel reservation,
flight itinerary...) captured with a trip context becomes a checkpoint (a
stay/travel checkpoint) on that trip instead, with its dates filled in.
"""

import logging
import re
from dataclasses import replace
from typing import Any, Optional
from urllib.parse import urlparse

from db import get_supabase

from ..constants import (
    CheckpointRole,
    CheckpointType,
    BookingKind,
    EnrichErrorKind,
    GeocodeConfidence,
    MembershipStatus,
    SourceStatus,
)
from . import checkpoints, gmaps, instagram, llm, nominatim, places, scraper, trails
from .places import build_maps_url
from .trace import ImportTrace, clip

logger = logging.getLogger("travel_scrapbook.enrichment")

# URL path words that are structural, not place names — a slug made only of
# these (plus an opaque id) carries no place signal.
_SLUG_STOPWORDS = {
    "reel", "reels", "p", "tv", "video", "videos", "watch", "share", "story",
    "stories", "post", "posts", "status", "photo", "photos", "s", "v", "e",
}


def _slug_has_place_tokens(url: str) -> bool:
    """True when the URL path looks like human-readable text that could name a
    place — a hyphen/underscore-joined slug, or an all-lowercase word segment —
    rather than a bare opaque permalink like instagram.com/reel/<id> (whose id
    is mixed-case and/or digit-bearing and so reads as nothing)."""
    path = urlparse(url).path
    # A hyphen/underscore-joined slug is almost always human-readable text.
    if re.search(r"[A-Za-z]-[A-Za-z]|[A-Za-z]_[A-Za-z]", path):
        return True
    for seg in path.split("/"):
        seg = seg.strip()
        if not seg or seg.lower() in _SLUG_STOPWORDS:
            continue
        # A plain lowercase alphabetic segment reads as a word; an opaque
        # permalink id (mixed case or containing digits) does not.
        if len(seg) >= 4 and seg.isalpha() and seg.islower():
            return True
    return False


def _has_place_signal(
    url: str, page: Optional[scraper.PageContent], context_text: Optional[str]
) -> bool:
    """True when there is real text a place could be extracted from: page
    content, a share-sheet caption/recovered caption, or a human-readable URL
    slug. False for a bare opaque social permalink with no caption — the case
    that used to make the LLM hallucinate famous landmarks."""
    if context_text and context_text.strip():
        return True
    if page is not None and any(
        (v or "").strip()
        for v in (page.text_excerpt, page.og_title, page.og_description, page.title)
    ):
        return True
    return _slug_has_place_tokens(url)


def _degraded_error_kind(
    fetch_error: Optional[scraper.ScrapeError], default: EnrichErrorKind
) -> EnrichErrorKind:
    """Pick the honest failure reason: a blocked/unreachable fetch is reported
    as blocked/network (not "no places found"), so a site that refused us is
    never mislabeled as a readable page that simply named nothing."""
    if fetch_error is None:
        return default
    if fetch_error.kind == scraper.ScrapeErrorKind.NETWORK:
        return EnrichErrorKind.NETWORK
    return EnrichErrorKind.BLOCKED


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
    trace: Optional[ImportTrace] = None,
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
    tried: list[str] = []
    for query, confidence in attempts:
        key = query.lower().strip()
        if key in seen:
            continue
        seen.add(key)
        tried.append(query)
        result = await nominatim.geocode(query)
        if result:
            if trace is not None:
                trace.add("geocode", f"Geocoded “{name or query}”", {
                    "tried": tried, "matched_query": query,
                    "confidence": str(confidence),
                    "lat": result.lat, "lng": result.lng,
                    "display_name": result.display_name,
                })
            return result, confidence
    if trace is not None:
        trace.add(
            "geocode",
            f"Geocode found nothing for “{name or extraction.geocode_query or 'place'}”",
            {"tried": tried, "confidence": str(GeocodeConfidence.NONE)},
        )
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
    trace: Optional[ImportTrace] = None,
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
        if trace is not None:
            trace.add("geocode", f"Reverse-geocoded pin for “{extraction.place_name or 'pin'}”", {
                "lat": extraction.lat, "lng": extraction.lng,
                "confidence": str(confidence),
                "display_name": geo.display_name if geo else None,
            })
    else:
        geo, confidence = await _geocode_with_fallback(extraction, trace)

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
        if trace is not None:
            trace.add("materialize", f"“{place['name']}” already saved", {
                "place_id": place["id"], "name": place["name"],
                "new_place": _created, "scrap_created": False,
                "note": "already on the user's Wander List — only the source link was added",
            })
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

    if trace is not None:
        trace.add("materialize", f"Saved “{place['name']}”", {
            "place_id": place["id"], "name": place["name"],
            "city": place.get("city"), "country": place.get("country"),
            "lat": place.get("lat"), "lng": place.get("lng"),
            "confidence": str(confidence), "new_place": _created,
            "scrap_created": True,
            "trip_membership": membership["status"] if membership else None,
        })


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

    role = CheckpointRole.STAY if booking.kind == BookingKind.STAY else CheckpointRole.TRAVEL
    category = checkpoints.category_for(
        role, booking.transport_type or CheckpointType.OTHER
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

    if role == CheckpointRole.STAY:
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


def _persist_trace(
    sb, source: dict[str, Any], trace: ImportTrace, update: dict[str, Any]
) -> None:
    """Store the parse trace, keeping only the newest 5 per user. Audit-only and
    fully best-effort — a failure here must never affect the import outcome."""
    try:
        # One trace per source: a retry replaces its own prior trace rather than
        # consuming the last-5 budget, so the list stays 5 *distinct* links.
        sb.table("travelscrapbook_import_traces").delete().eq(
            "source_id", source["id"]
        ).execute()
        sb.table("travelscrapbook_import_traces").insert({
            "source_id": source["id"],
            "user_id": source["user_id"],
            "url": trace.url,
            "final_status": update.get("status"),
            "error_kind": update.get("error_kind"),
            "trace": trace.to_json(),
        }).execute()
        # Retention: drop everything past the newest 5 for this user.
        stale = (
            sb.table("travelscrapbook_import_traces")
            .select("id")
            .eq("user_id", source["user_id"])
            .order("created_at", desc=True)
            .range(5, 10_000)
            .execute()
        ).data or []
        if stale:
            sb.table("travelscrapbook_import_traces").delete().in_(
                "id", [r["id"] for r in stale]
            ).execute()
    except Exception:
        logger.exception("source %s: failed to persist import trace", source["id"])


async def process_source(source_id: str) -> None:
    """Full enrichment pipeline for one source. Safe to re-run (retry)."""
    sb = get_supabase()
    row = (
        sb.table("travelscrapbook_sources")
        .select(
            "id, user_id, url, shared_text, capture_notes, trip_hint_id, captured_via"
        )
        .eq("id", source_id)
        .execute()
    )
    if not row.data:
        return  # deleted while queued
    source = row.data[0]
    url = source["url"]

    trace = ImportTrace(url)
    trace.add("capture", "Link captured", {
        "url": url,
        "captured_via": source.get("captured_via"),
        "shared_text": clip(source.get("shared_text")),
        "trip_hint": bool(source.get("trip_hint_id")),
    })

    update: dict[str, Any] = {}
    try:
        # 0. Google Maps links parse to themselves — the URL already names the
        #    place and encodes its exact pin, so skip the page fetch + LLM
        #    (which re-guesses from scraped text and can drift to a different
        #    location). Fall through to the normal path if parsing yields nothing.
        if gmaps.is_maps_url(url):
            mp = await gmaps.parse_maps_url(url, trace)
            extraction = _maps_extraction(mp) if mp else None
            if extraction is not None:
                try:
                    await _materialize_place(sb, source, extraction, trace)
                    update.update({"status": SourceStatus.READY, "error_kind": None})
                except Exception:
                    logger.exception("source %s: failed to materialize maps pin", source_id)
                    update.update({
                        "status": SourceStatus.FAILED,
                        "error_kind": EnrichErrorKind.INTERNAL,
                    })
                return

        # 1. Fetch the page — degradable. Blocked/unreachable pages still get a
        #    URL-only LLM pass (slugs + share-sheet text often name places).
        page: Optional[scraper.PageContent] = None
        fetch_error: Optional[scraper.ScrapeError] = None
        try:
            page = await scraper.fetch_page(url)
            update.update({
                "og_title": page.og_title or page.title,
                "og_description": page.og_description,
                "og_image_url": page.og_image,
            })
            trace.add("page_fetch", "Fetched the page", {
                "ok": True,
                "title": page.title,
                "og_title": page.og_title,
                "og_description": clip(page.og_description),
                "og_image": page.og_image,
                "text_excerpt": clip(page.text_excerpt),
            })
        except scraper.ScrapeError as exc:
            fetch_error = exc
            logger.info("source %s: page fetch degraded (%s)", source_id, exc.kind)
            trace.add("page_fetch", "Page fetch failed", {
                "ok": False, "kind": str(exc.kind), "message": exc.message,
            })

        # 1b. When the site blocked us, try to recover the caption before giving
        #     up — a real caption is the only thing that lets us name the place
        #     instead of the LLM inventing one.
        recovered_caption: Optional[str] = None
        if page is None and instagram.is_recoverable(url):
            recovered_caption = await instagram.recover_caption(url, trace)

        context_parts = [
            t for t in (source.get("shared_text"), recovered_caption) if t and t.strip()
        ]
        context_text = "\n".join(context_parts) or None

        # 1c. Honest-failure guard: with no page content, no caption/share text,
        #     and only an opaque permalink, there is nothing real to extract. Skip
        #     the LLM entirely rather than let it hallucinate a famous default —
        #     and report WHY it failed (site blocked us / unreachable), not the
        #     misleading "no places found".
        if not _has_place_signal(url, page, context_text):
            kind = _degraded_error_kind(fetch_error, EnrichErrorKind.NO_PLACE)
            update.update({"status": SourceStatus.FAILED, "error_kind": kind})
            trace.add("note", "No place signal — skipped the AI call", {
                "reason": "no page content, no caption/share text, and an opaque URL",
                "error_kind": str(kind),
            })
            return

        # 2. LLM place extraction — required. If this fails we mark failed.
        try:
            categories = _load_category_slugs(sb)
            extractions, booking = await llm.extract_places(
                url, page, categories, shared_text=context_text, trace=trace
            )
        except llm.LLMError as exc:
            logger.warning("source %s: LLM failed: %s", source_id, exc)
            kind = _degraded_error_kind(fetch_error, EnrichErrorKind.LLM)
            update.update({"status": SourceStatus.FAILED, "error_kind": kind})
            trace.add("note", "AI call failed", {"error": str(exc)[:300], "error_kind": str(kind)})
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
            trace.add("materialize", "Saved as a trip checkpoint", {
                "kind": booking.kind, "label": booking.label,
            })

        if not extractions and not checkpoint_created:
            # The LLM found nothing. If the page was blocked/unreachable, say so;
            # only a genuinely readable page that named no place is "no_place".
            kind = _degraded_error_kind(fetch_error, EnrichErrorKind.NO_PLACE)
            update.update({"status": SourceStatus.FAILED, "error_kind": kind})
            trace.add("note", "AI returned no places", {"error_kind": str(kind)})
            return

        # 2c. Trail sites (Komoot, AllTrails, Strava…) are hikes — force the
        #     category regardless of the LLM's guess. The trailhead still
        #     geocodes normally from the extraction below.
        if trails.is_trail_url(url):
            extractions = [replace(e, category="hike") for e in extractions]

        trace.add("result_split", f"Fanning out into {len(extractions)} place(s)", {
            "places": [e.place_name for e in extractions],
        })

        # 3. Fan out: place per extraction, serially — the Nominatim throttle
        #    (≥1.1s spacing) makes serial the polite and simple choice.
        errors = 0
        for extraction in extractions:
            try:
                await _materialize_place(sb, source, extraction, trace)
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
        trace.add("final", "Import finished", {
            "status": update.get("status"),
            "error_kind": update.get("error_kind"),
        })
        _persist_trace(sb, source, trace, update)
