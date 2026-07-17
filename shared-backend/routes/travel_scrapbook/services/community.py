"""Community place pool: every user's canonical places as a browsable,
privacy-safe catalog.

Places are facts about the world (name, category, coordinates, public source
URLs) and are shared; scraps, notes, ratings, vibes, and user identity are
never exposed. Grouping is by OSM identity when Nominatim supplied one, else
by (normalized name, country code).

The catalog read (grouping, facets, pagination, source chips) lives in SQL —
travelscrapbook_community_places, migration 015 — called directly from
community_routes.py. This module keeps the write-side helper (copying a
community place into the caller's own places).
"""

from typing import Any

from supabase import Client


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
