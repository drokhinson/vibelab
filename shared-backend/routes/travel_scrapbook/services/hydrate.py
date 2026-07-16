"""Scrap hydration: merge canonical place fields + source chips onto scrap rows.

The API keeps serving flat place fields on scraps (place_name, lat, maps_url…)
so every consumer — web cards, route optimizer, exports — reads one shape.
Three DB round-trips total regardless of scrap count (scraps → places →
place_sources+sources), never N+1. Trip surfaces pass with_vibes=True to also
attach each traveler's vibe, the "added by" owner, and the group consensus
(two extra round-trips: vibes → profiles).
"""

from collections import Counter
from typing import Any, Optional

from supabase import Client

from ..constants import TripVibe

# Consensus tie-break: most-committed wins when two levels tie on count.
_VIBE_ORDER = [TripVibe.BOOKED, TripVibe.MUST_DO, TripVibe.INTERESTED, TripVibe.COULD_SKIP]
_VIBE_LABEL = {
    TripVibe.BOOKED: "Booked",
    TripVibe.MUST_DO: "Must do",
    TripVibe.INTERESTED: "Interested",
    TripVibe.COULD_SKIP: "Could skip",
}


def _consensus(levels: list[str]) -> dict[str, Any]:
    """Roll a scrap's vibe levels into {counts, total, headline}."""
    counts = Counter(levels)
    total = len(levels)
    if not total:
        return {"counts": {}, "total": 0, "headline": "No vibes yet"}
    # Highest count, breaking ties by commitment order.
    top = max(_VIBE_ORDER, key=lambda lv: (counts.get(lv, 0), -_VIBE_ORDER.index(lv)))
    top_n = counts.get(top, 0)
    label = _VIBE_LABEL[top]
    headline = label if total == 1 else f"{label} · {top_n} of {total}"
    return {"counts": dict(counts), "total": total, "headline": headline}


def hydrate_scraps(
    sb: Client,
    scraps: list[dict[str, Any]],
    *,
    with_vibes: bool = False,
) -> list[dict[str, Any]]:
    """Return scrap rows with place fields flattened in and sources attached.

    og_image_url is the first non-null image among the place's sources
    (newest first), giving cards a photo without storing one on the place.

    When with_vibes is set (trip surfaces only), also attach each traveler's
    ``vibes``, the ``added_by_*`` owner, and a ``consensus`` roll-up.
    """
    if not scraps:
        return []
    place_ids = sorted({s["place_id"] for s in scraps if s.get("place_id")})

    places = {
        p["id"]: p
        for p in (
            sb.table("travelscrapbook_places")
            .select("*")
            .in_("id", place_ids)
            .execute()
        ).data or []
    }

    links = (
        sb.table("travelscrapbook_place_sources")
        .select("place_id, created_at, "
                "travelscrapbook_sources(id, url, source_domain, og_title, og_image_url)")
        .in_("place_id", place_ids)
        .execute()
    ).data or []
    sources_by_place: dict[str, list[dict[str, Any]]] = {}
    for link in sorted(links, key=lambda l: l["created_at"], reverse=True):
        src = link.get("travelscrapbook_sources")
        if src:
            sources_by_place.setdefault(link["place_id"], []).append(src)

    vibes_by_scrap, names = _load_vibes(sb, scraps) if with_vibes else ({}, {})

    hydrated = []
    for scrap in scraps:
        place = places.get(scrap.get("place_id")) or {}
        sources = sources_by_place.get(scrap.get("place_id"), [])
        row = {
            **scrap,
            "place_name": place.get("name"),
            "place_city": place.get("city"),
            "place_region": place.get("region"),
            "place_country": place.get("country"),
            "category": place.get("category") or "other",
            "lat": place.get("lat"),
            "lng": place.get("lng"),
            "geocode_confidence": place.get("geocode_confidence") or "none",
            "geocode_display_name": place.get("geocode_display_name"),
            "maps_url": place.get("maps_url"),
            "og_image_url": next(
                (s["og_image_url"] for s in sources if s.get("og_image_url")), None
            ),
            "sources": [
                {
                    "id": s["id"],
                    "url": s["url"],
                    "source_domain": s.get("source_domain"),
                    "og_title": s.get("og_title"),
                }
                for s in sources
            ],
        }
        if with_vibes:
            owner_id = scrap.get("user_id")
            scrap_vibes = vibes_by_scrap.get(scrap["id"], [])
            row["added_by_user_id"] = owner_id
            row["added_by_display_name"] = names.get(owner_id)
            row["vibes"] = [
                {
                    "user_id": v["user_id"],
                    "display_name": names.get(v["user_id"], "Traveler"),
                    "level": v["level"],
                }
                for v in scrap_vibes
            ]
            row["consensus"] = _consensus([v["level"] for v in scrap_vibes])
        hydrated.append(row)
    return hydrated


def _load_vibes(
    sb: Client, scraps: list[dict[str, Any]]
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, str]]:
    """Fetch every scrap's vibe rows + the display names needed for the cards
    (scrap owners + raters) in two round-trips."""
    scrap_ids = sorted({s["id"] for s in scraps})
    vibe_rows = (
        sb.table("travelscrapbook_scrap_vibes")
        .select("scrap_id, user_id, level")
        .in_("scrap_id", scrap_ids)
        .execute()
    ).data or []
    vibes_by_scrap: dict[str, list[dict[str, Any]]] = {}
    for v in vibe_rows:
        vibes_by_scrap.setdefault(v["scrap_id"], []).append(v)

    user_ids = {s.get("user_id") for s in scraps if s.get("user_id")}
    user_ids.update(v["user_id"] for v in vibe_rows)
    user_ids.discard(None)
    names: dict[str, str] = {}
    if user_ids:
        names = {
            p["id"]: p["display_name"]
            for p in (
                sb.table("travelscrapbook_profiles")
                .select("id, display_name")
                .in_("id", sorted(user_ids))
                .execute()
            ).data or []
        }
    return vibes_by_scrap, names
