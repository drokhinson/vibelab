"""Trip exports: Google Maps multi-stop directions links + My Maps CSV.

Both are plain-URL / plain-file constructions — no Google API involved.
"""

import csv
import io
from dataclasses import dataclass
from typing import Optional

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
