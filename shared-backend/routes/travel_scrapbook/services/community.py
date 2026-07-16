"""Community place pool: read-time aggregation of every user's canonical
places into a browsable, privacy-safe catalog.

Places are facts about the world (name, category, coordinates, public source
URLs) and are shared; scraps, notes, ratings, vibes, and user identity are
never exposed. Grouping is by OSM identity when Nominatim supplied one, else
by (normalized name, country code).

Python-side aggregation over one broad query is fine at prototype scale; the
upgrade path when the places table grows is a SQL RPC with the same shape.
"""

from typing import Any, Optional

from supabase import Client

from .places import geo_facets, geo_match

MAX_SAMPLE_SOURCES = 3


def _group_key(p: dict[str, Any]) -> tuple:
    if p.get("osm_id") is not None:
        return ("osm", p.get("osm_type"), p["osm_id"])
    return ("name", p.get("name_normalized"), (p.get("country_code") or "").lower())


def _completeness(p: dict[str, Any]) -> tuple:
    """Pick the most complete row as the group's representative."""
    return (
        p.get("lat") is not None,
        bool(p.get("maps_url")),
        bool(p.get("city")),
        p.get("category") != "other",
    )


def aggregate_places(
    sb: Client,
    *,
    q: Optional[str] = None,
    region: Optional[str] = None,
    country: Optional[str] = None,
    city: Optional[str] = None,
    category: Optional[str] = None,
    limit: int = 24,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int, dict[str, list[str]]]:
    """One page of community catalog entries matching the filters (most-saved
    first), the filtered total, and the geo drill-down facets.

    Only geocoded places qualify (a pin keeps catalog quality up). Geo
    filtering happens Python-side AFTER grouping so the facets (regions →
    countries with data → cities) reflect the whole q/category-matched pool.
    Each entry carries the representative place's canonical fields plus
    saved_by_count (distinct users), source_count, up to MAX_SAMPLE_SOURCES
    sample source chips, and a cover og_image_url — no user identity, notes,
    or ratings. Source chips are attached for the returned page only.
    """
    query = (
        sb.table("travelscrapbook_places")
        .select("id, user_id, name, name_normalized, city, region, country, "
                "country_code, category, lat, lng, maps_url, osm_type, osm_id")
        .not_.is_("lat", "null")
    )
    if q:
        query = query.or_(f"name.ilike.%{q}%,city.ilike.%{q}%")
    if category:
        query = query.eq("category", category)
    rows = query.limit(2000).execute().data or []

    groups: dict[tuple, list[dict[str, Any]]] = {}
    for p in rows:
        groups.setdefault(_group_key(p), []).append(p)

    entries = []
    for members in groups.values():
        rep = max(members, key=_completeness)
        entries.append({
            "ref_place_id": rep["id"],
            "name": rep["name"],
            "city": rep.get("city"),
            "region": rep.get("region"),
            "country": rep.get("country"),
            "category": rep.get("category") or "other",
            "lat": rep.get("lat"),
            "lng": rep.get("lng"),
            "maps_url": rep.get("maps_url"),
            "saved_by_count": len({m["user_id"] for m in members}),
            "_place_ids": [m["id"] for m in members],
        })

    # geo_facets/geo_match read place_-prefixed keys; alias the entry fields.
    def geo_view(e: dict[str, Any]) -> dict[str, Any]:
        return {"place_region": e["region"], "place_country": e["country"],
                "place_city": e["city"]}

    facets = geo_facets([geo_view(e) for e in entries], region=region, country=country)
    filtered = [
        e for e in entries
        if geo_match(geo_view(e), region=region, country=country, city=city)
    ]
    filtered.sort(key=lambda e: (-e["saved_by_count"], e["name"] or ""))
    page = filtered[offset:offset + limit]

    _attach_sources(sb, page)
    for e in page:
        e.pop("_place_ids", None)
    return page, len(filtered), facets


def _attach_sources(sb: Client, entries: list[dict[str, Any]]) -> None:
    """One batched place_sources join for every entry's member places →
    source_count + sample public source chips + a cover image."""
    all_ids = [pid for e in entries for pid in e["_place_ids"]]
    for e in entries:
        e["source_count"] = 0
        e["sample_sources"] = []
        e["og_image_url"] = None
    if not all_ids:
        return
    links = (
        sb.table("travelscrapbook_place_sources")
        .select("place_id, created_at, "
                "travelscrapbook_sources(url, source_domain, og_title, og_image_url)")
        .in_("place_id", all_ids)
        .execute()
    ).data or []
    by_place: dict[str, list[dict[str, Any]]] = {}
    for link in sorted(links, key=lambda l: l["created_at"], reverse=True):
        src = link.get("travelscrapbook_sources")
        if src:
            by_place.setdefault(link["place_id"], []).append(src)
    for e in entries:
        seen_urls = set()
        sources = []
        for pid in e["_place_ids"]:
            for s in by_place.get(pid, []):
                if s["url"] in seen_urls:
                    continue
                seen_urls.add(s["url"])
                sources.append(s)
        e["source_count"] = len(sources)
        e["sample_sources"] = [
            {"url": s["url"], "source_domain": s.get("source_domain"),
             "og_title": s.get("og_title")}
            for s in sources[:MAX_SAMPLE_SOURCES]
        ]
        e["og_image_url"] = next(
            (s["og_image_url"] for s in sources if s.get("og_image_url")), None)


def copy_place_for_user(sb: Client, user_id: str, ref_place: dict[str, Any]) -> dict[str, Any]:
    """The caller's own place row for a community entry — reused when they
    already have this place (same OSM identity, else same normalized name +
    country), otherwise created as a copy of the canonical fields. No
    Nominatim call: the coordinates are already known."""
    mine = None
    if ref_place.get("osm_id") is not None:
        rows = (
            sb.table("travelscrapbook_places")
            .select("*")
            .eq("user_id", user_id)
            .eq("osm_type", ref_place.get("osm_type"))
            .eq("osm_id", ref_place["osm_id"])
            .limit(1)
            .execute()
        ).data
        mine = rows[0] if rows else None
    if mine is None:
        rows = (
            sb.table("travelscrapbook_places")
            .select("*")
            .eq("user_id", user_id)
            .eq("name_normalized", ref_place["name_normalized"])
            .limit(1)
            .execute()
        ).data
        mine = rows[0] if rows else None
    if mine:
        return mine
    copied = {
        k: ref_place.get(k)
        for k in ("name", "name_normalized", "city", "region", "country",
                  "country_code", "category", "lat", "lng",
                  "geocode_confidence", "geocode_display_name",
                  "osm_type", "osm_id", "maps_url")
    }
    copied["user_id"] = user_id
    copied["category"] = copied.get("category") or "other"
    copied["geocode_confidence"] = copied.get("geocode_confidence") or "none"
    return sb.table("travelscrapbook_places").insert(copied).execute().data[0]
