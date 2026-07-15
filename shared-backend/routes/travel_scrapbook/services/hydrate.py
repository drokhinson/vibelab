"""Scrap hydration: merge canonical place fields + source chips onto scrap rows.

The API keeps serving flat place fields on scraps (place_name, lat, maps_url…)
so every consumer — web cards, route optimizer, exports — reads one shape.
Three DB round-trips total regardless of scrap count (scraps → places →
place_sources+sources), never N+1.
"""

from typing import Any

from supabase import Client


def hydrate_scraps(sb: Client, scraps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return scrap rows with place fields flattened in and sources attached.

    og_image_url is the first non-null image among the place's sources
    (newest first), giving cards a photo without storing one on the place.
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

    hydrated = []
    for scrap in scraps:
        place = places.get(scrap.get("place_id")) or {}
        sources = sources_by_place.get(scrap.get("place_id"), [])
        row = {
            **scrap,
            "place_name": place.get("name"),
            "place_city": place.get("city"),
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
        hydrated.append(row)
    return hydrated
