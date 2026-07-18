"""Parse Google Maps URLs directly instead of sending them through the LLM.

A Google Maps link already names the place and encodes its exact pin
coordinates, so routing it through Gemini (which re-guesses the place from
scraped text) can drift to a *different* location. `is_maps_url` / `parse_maps_url`
extract the place name and coordinates straight from the URL; callers then
reverse-geocode the pin for city/region/country (see services/nominatim.reverse).

Handles the common Maps URL shapes plus the `maps.app.goo.gl` / `goo.gl/maps`
short links (expanded by following the redirect).
"""

import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import parse_qs, unquote, urlparse

import httpx

from api_logger import log_external_call

from ..constants import APP_NAME

HTTP_TIMEOUT = 10.0

_BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# Full-map hosts and short-link hosts.
_MAPS_HOSTS = ("google.com/maps", "maps.google.")
_SHORT_HOSTS = ("maps.app.goo.gl", "goo.gl")

# Exact pin in the `data=` blob: !3d<lat>!4d<lng> — most reliable.
_DATA_COORDS = re.compile(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)")
# Viewport center: @<lat>,<lng>,<zoom>z
_AT_COORDS = re.compile(r"@(-?\d+\.\d+),(-?\d+\.\d+)")
# A bare "lat,lng" pair (used for q=/query=/ll= param values).
_LATLNG = re.compile(r"^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$")
# Place name from the /place/<Name>/ path segment.
_PLACE_SEG = re.compile(r"/maps/place/([^/@]+)")


@dataclass
class MapsPlace:
    name: Optional[str]
    lat: Optional[float]
    lng: Optional[float]
    expanded_url: str


def is_maps_url(url: str) -> bool:
    """True for any Google Maps link — full map URLs and short links alike."""
    if not url:
        return False
    parsed = urlparse(url.strip())
    host = (parsed.hostname or "").lower().removeprefix("www.")
    hp = f"{host}{parsed.path}"
    if any(marker in hp for marker in _MAPS_HOSTS):
        return True
    # goo.gl is only a Maps short link under /maps (or the maps.app subdomain).
    if host == "maps.app.goo.gl":
        return True
    if host == "goo.gl" and parsed.path.startswith("/maps"):
        return True
    return False


def _is_short_link(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower().removeprefix("www.")
    return host in _SHORT_HOSTS


async def _expand_short_link(url: str) -> str:
    """Follow a maps.app.goo.gl / goo.gl redirect to the full maps URL. Returns
    the original URL unchanged on any failure."""
    try:
        async with log_external_call(
            app=APP_NAME,
            api_name="gmaps-expand",
            method="GET",
            url=url,
        ) as record:
            async with httpx.AsyncClient(
                timeout=HTTP_TIMEOUT,
                follow_redirects=True,
                headers={"User-Agent": _BROWSER_UA, "Accept-Language": "en"},
            ) as client:
                resp = await client.get(url)
            record.attach_response(resp)
        final = str(resp.url)
        # EU consent interstitial hides the real URL in ?continue=<encoded>.
        parsed = urlparse(final)
        if (parsed.hostname or "").startswith("consent."):
            cont = parse_qs(parsed.query).get("continue")
            if cont:
                return unquote(cont[0])
        return final
    except httpx.HTTPError:
        return url


def _extract_coords(url: str) -> tuple[Optional[float], Optional[float]]:
    m = _DATA_COORDS.search(url) or _AT_COORDS.search(url)
    if m:
        try:
            return float(m.group(1)), float(m.group(2))
        except ValueError:
            pass
    # q / query / ll param carrying a bare "lat,lng".
    params = parse_qs(urlparse(url).query)
    for key in ("q", "query", "ll"):
        for val in params.get(key, []):
            pair = _LATLNG.match(val)
            if pair:
                try:
                    return float(pair.group(1)), float(pair.group(2))
                except ValueError:
                    continue
    return None, None


def _extract_name(url: str) -> Optional[str]:
    seg = _PLACE_SEG.search(url)
    if seg:
        name = unquote(seg.group(1)).replace("+", " ").strip()
        # A /place/<lat,lng> segment is coordinates, not a name.
        if name and not _LATLNG.match(name):
            return name
    # Fall back to a q/query text value that isn't itself coordinates.
    params = parse_qs(urlparse(url).query)
    for key in ("q", "query"):
        for val in params.get(key, []):
            text = val.replace("+", " ").strip()
            if text and not _LATLNG.match(text):
                return text
    return None


async def parse_maps_url(url: str) -> Optional[MapsPlace]:
    """Extract place name + pin coordinates from a Google Maps URL, expanding a
    short link first if needed. Returns None when nothing usable can be parsed
    (caller then falls back to the normal fetch + LLM path)."""
    if not url:
        return None
    expanded = await _expand_short_link(url) if _is_short_link(url) else url
    lat, lng = _extract_coords(expanded)
    name = _extract_name(expanded)
    if lat is None and not name:
        return None
    return MapsPlace(name=name, lat=lat, lng=lng, expanded_url=expanded)
