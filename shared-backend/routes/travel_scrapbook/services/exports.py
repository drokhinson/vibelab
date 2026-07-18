"""Trip exports: Google Maps directions links, My Maps CSV, a Markdown
itinerary, and a KML point layer.

All are plain-string / plain-file constructions — no Google API involved.
"""

import csv
import io
from dataclasses import dataclass
from typing import Optional
from xml.sax.saxutils import escape as xml_escape

# Google Maps /dir/ URLs render reliably up to about 10 waypoints; longer
# trips are split into legs that overlap at the seam (last stop of leg N is
# the first stop of leg N+1) so navigation is continuous.
MAX_STOPS_PER_LEG = 10


@dataclass
class Stop:
    label: str
    lat: float
    lng: float


@dataclass
class DirLeg:
    label: str
    url: str
    stop_count: int


def _dir_url(stops: list[Stop]) -> str:
    path = "/".join(f"{s.lat:.6f},{s.lng:.6f}" for s in stops)
    return f"https://www.google.com/maps/dir/{path}"


def build_dir_links(stops: list[Stop]) -> list[DirLeg]:
    """Chunk an ordered stop list into shareable directions URLs."""
    if len(stops) < 2:
        return []
    legs: list[DirLeg] = []
    i = 0
    part = 1
    while i < len(stops) - 1:
        chunk = stops[i : i + MAX_STOPS_PER_LEG]
        legs.append(
            DirLeg(
                label=f"Leg {part}: {chunk[0].label} → {chunk[-1].label}",
                url=_dir_url(chunk),
                stop_count=len(chunk),
            )
        )
        i += MAX_STOPS_PER_LEG - 1  # overlap: last stop repeats as next start
        part += 1
    return legs


def build_csv(rows: list[dict[str, Optional[str]]]) -> str:
    """CSV in the shape Google My Maps imports (WKT-free, lat/lng columns)."""
    buf = io.StringIO()
    writer = csv.DictWriter(
        buf,
        fieldnames=["name", "category", "address", "latitude", "longitude", "notes", "url"],
        extrasaction="ignore",
    )
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return buf.getvalue()


def _place_maps_link(place: dict) -> Optional[str]:
    """The best Google Maps URL for a place: its own maps_url, else a
    lat/lng search link, else nothing (place isn't geocoded)."""
    if place.get("maps_url"):
        return place["maps_url"]
    if place.get("lat") is not None and place.get("lng") is not None:
        return f"https://www.google.com/maps/search/?api=1&query={place['lat']},{place['lng']}"
    return None


def _place_lines(p: dict, n: int) -> list[str]:
    """One numbered place entry: heading + map link, meta, note, source."""
    name = p.get("place_name") or "Stop"
    link = _place_maps_link(p)
    heading = f"{n}. **{name}**"
    if link:
        heading += f" — [map]({link})"
    out = [heading]
    meta = " · ".join(
        m for m in (
            (p.get("category") or "").replace("_", " ").title() or None,
            p.get("geocode_display_name"),
        ) if m
    )
    if meta:
        out.append(f"   {meta}")
    if p.get("notes"):
        out.append(f"   > {p['notes']}")
    src = p.get("sources") or []
    if src:
        out.append(f"   [{src[0].get('source_domain') or 'link'}]({src[0]['url']})")
    out.append("")
    return out


def build_markdown(
    trip: dict,
    places: list[dict],
    anchors: list[dict],
    day_label: str | None = None,
    day_groups: list[tuple[str, list[dict]]] | None = None,
) -> str:
    """A human-readable Markdown itinerary: trip header, start/end anchors, then
    the places. `places` are hydrated scrap dicts in display order. `day_label`
    (single-day export) is appended to the H1 and drops the date range from the
    subtitle. `day_groups` (a whole-trip plan export) renders one **## <day>**
    section per day, numbered within the day, in the client's itinerary order."""
    title = trip.get("name") or "Trip"
    if day_label:
        title += f" — {day_label}"
    lines: list[str] = [f"# {title}"]

    date_part = None if day_label else _date_range(trip.get("start_date"), trip.get("end_date"))
    subtitle = " · ".join(p for p in (trip.get("destination"), date_part) if p)
    if subtitle:
        lines.append(f"_{subtitle}_")
    if trip.get("notes"):
        lines.append("")
        lines.append(trip["notes"])

    start = next((a for a in anchors if a.get("role") == "start" and a.get("label")), None)
    end = next((a for a in anchors if a.get("role") == "end" and a.get("label")), None)
    if start:
        lines += ["", f"**Start:** {start['label']}"]
    if end:
        lines.append(f"**End:** {end['label']}")

    if day_groups is not None:
        if not places:
            lines += ["", "_No places yet._"]
        for heading, group in day_groups:
            lines += ["", f"## {heading}", ""]
            for i, p in enumerate(group, 1):
                lines += _place_lines(p, i)
    else:
        lines += ["", f"## Places ({len(places)})", ""]
        if not places:
            lines.append("_No places yet._")
        for i, p in enumerate(places, 1):
            lines += _place_lines(p, i)

    return "\n".join(lines).rstrip() + "\n"


def _date_range(start: Optional[str], end: Optional[str]) -> Optional[str]:
    """`start – end`, either bound optional (ISO date strings straight through)."""
    if start and end:
        return f"{start} – {end}"
    return start or end or None


def build_kml(trip_name: str, places: list[dict]) -> str:
    """A KML point layer — one <Placemark> per geocoded place — that imports
    into Google My Maps and Google Earth as named, described pins."""
    marks: list[str] = []
    for p in places:
        if p.get("lat") is None or p.get("lng") is None:
            continue
        desc_parts = [
            (p.get("category") or "").replace("_", " ").title(),
            p.get("geocode_display_name"),
            p.get("notes"),
            _place_maps_link(p),
        ]
        desc = "\n".join(d for d in desc_parts if d)
        marks.append(
            "    <Placemark>\n"
            f"      <name>{xml_escape(p.get('place_name') or 'Stop')}</name>\n"
            f"      <description><![CDATA[{desc}]]></description>\n"
            f"      <Point><coordinates>{p['lng']:.6f},{p['lat']:.6f},0</coordinates></Point>\n"
            "    </Placemark>"
        )
    body = "\n".join(marks)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<kml xmlns="http://www.opengis.net/kml/2.2">\n'
        "  <Document>\n"
        f"    <name>{xml_escape(trip_name or 'Trip')}</name>\n"
        f"{body}\n"
        "  </Document>\n"
        "</kml>\n"
    )
