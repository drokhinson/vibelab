"""Parse Google Maps URLs directly instead of sending them through the LLM.

A Google Maps link already names the place and encodes its exact pin
coordinates, so routing it through Gemini (which re-guesses the place from
scraped text) can drift to a *different* location. `is_maps_url` / `parse_maps_url`
extract the place name and coordinates straight from the URL; callers then
reverse-geocode the pin for city/region/country (see services/nominatim.reverse).

Handles the common Maps URL shapes plus the `maps.app.goo.gl` / `goo.gl/maps`
short links (expanded by following the redirect).

Freshly-shared app links are the tricky case: expanded server-side (no browser
JS) they resolve to the *feature-id* form — `/maps/place/<Name>/data=!1s0x…:0x…`
— which carries Google's internal place id but NO decimal `!3d…!4d…` pin. With
no coordinates a caller can only forward-geocode the bare name, which for a
common/ambiguous name lands on the wrong same-named place anywhere on earth. So
when the URL itself yields no pin we recover it from the rendered page body (the
redirect fetch already downloads it), anchored to the feature id so we grab THAT
place's coordinates rather than a nearby result's.
"""

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional
from urllib.parse import parse_qs, unquote, urlparse

import httpx

from api_logger import log_external_call

from ..constants import APP_NAME

if TYPE_CHECKING:  # annotations only — avoids a runtime import cycle
    from .trace import ImportTrace

HTTP_TIMEOUT = 10.0

_BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# Google serves datacenter IPs (e.g. Railway) a cookie-consent interstitial
# instead of the real place page — and that interstitial body carries no
# !3d<lat>!4d<lng> pin, so a freshly-shared app link (feature-id form, no pin in
# the URL) then has NO coordinate signal and callers forward-geocode the bare
# name onto the wrong same-named place. Presenting an accepted-consent cookie
# makes Google return the real page whose body has the pin. Static, non-PII:
# CONSENT=YES+ is the documented minimal opt-out; SOCS is the current cookie.
_CONSENT_COOKIE = "CONSENT=YES+; SOCS=CAI"

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
# Feature id in the data blob: !1s0x<hex>:0x<hex>. Present on the app-share URL
# form even when the decimal pin (!3d!4d) is not — used to anchor the pin we
# recover from the page body to the right place.
_FTID = re.compile(r"!1s(0x[0-9a-f]+:0x[0-9a-f]+)", re.IGNORECASE)


@dataclass
class MapsPlace:
    name: Optional[str]
    lat: Optional[float]
    lng: Optional[float]
    expanded_url: str


@dataclass
class _Expansion:
    """A followed short link: the final URL, every URL seen along the redirect
    chain, and the final page's HTML body (empty string on any fetch failure)."""
    final_url: str
    chain_urls: list[str]
    body: str


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


async def _fetch(url: str) -> httpx.Response:
    """One redirect-following GET, logged. Raises httpx.HTTPError on failure."""
    async with log_external_call(
        app=APP_NAME,
        api_name="gmaps-expand",
        method="GET",
        url=url,
    ) as record:
        async with httpx.AsyncClient(
            timeout=HTTP_TIMEOUT,
            follow_redirects=True,
            headers={
                "User-Agent": _BROWSER_UA,
                "Accept-Language": "en",
                # Sent as an explicit header (not the cookie jar) so it rides
                # every redirect hop, including the ?continue= consent re-fetch.
                "Cookie": _CONSENT_COOKIE,
            },
        ) as client:
            resp = await client.get(url)
        record.attach_response(resp)
    return resp


async def _expand_short_link(url: str) -> _Expansion:
    """Follow a maps.app.goo.gl / goo.gl redirect to the full maps place page,
    keeping every URL seen along the way plus the final page body (the pin often
    lives only in the body, not the URL). Returns the original URL with an empty
    body on any failure."""
    try:
        resp = await _fetch(url)
    except httpx.HTTPError:
        return _Expansion(url, [url], "")

    chain = [str(r.url) for r in resp.history] + [str(resp.url)]
    final = str(resp.url)

    # EU consent interstitial hides the real place URL in ?continue=<encoded> —
    # and the coordinates live on THAT page, not the consent wall, so follow it.
    parsed = urlparse(final)
    if (parsed.hostname or "").startswith("consent."):
        cont = parse_qs(parsed.query).get("continue")
        if cont:
            real = unquote(cont[0])
            chain.append(real)
            try:
                resp = await _fetch(real)
            except httpx.HTTPError:
                return _Expansion(real, chain, "")
            chain += [str(r.url) for r in resp.history] + [str(resp.url)]
            return _Expansion(str(resp.url), chain, resp.text or "")

    return _Expansion(final, chain, resp.text or "")


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


def _best_coords(urls: list[str]) -> tuple[Optional[float], Optional[float]]:
    """Best coordinates across every URL we saw. An exact pin (!3d!4d) anywhere
    in the chain beats a coarse viewport (@lat,lng) anywhere, so we sweep for the
    pin first — a consent/redirect hop can carry the pin while the final URL has
    only the viewport (or nothing)."""
    for url in urls:
        m = _DATA_COORDS.search(url)
        if m:
            try:
                return float(m.group(1)), float(m.group(2))
            except ValueError:
                pass
    for url in urls:
        lat, lng = _extract_coords(url)
        if lat is not None:
            return lat, lng
    return None, None


def _coords_from_body(
    body: str, ftid: Optional[str]
) -> tuple[Optional[float], Optional[float]]:
    """Recover the pin from a rendered Maps place page when the URL didn't carry
    it. The app-share URL only has the feature id; the decimal pin sits in the
    page. Anchor to the feature id so we read THAT place's coordinates rather
    than a nearby result's, then fall back to the first pin/viewport in the page."""
    if not body:
        return None, None
    if ftid:
        anchored = re.search(
            re.escape(ftid) + r".{0,6000}?!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)",
            body,
            re.DOTALL,
        )
        if anchored:
            try:
                return float(anchored.group(1)), float(anchored.group(2))
            except ValueError:
                pass
    m = _DATA_COORDS.search(body) or _AT_COORDS.search(body)
    if m:
        try:
            return float(m.group(1)), float(m.group(2))
        except ValueError:
            pass
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


async def parse_maps_url(
    url: str, trace: "Optional[ImportTrace]" = None
) -> Optional[MapsPlace]:
    """Extract place name + pin coordinates from a Google Maps URL, expanding a
    short link first if needed. Returns None when nothing usable can be parsed
    (caller then falls back to the normal fetch + LLM path). Records the
    expansion on the trace when one is supplied."""
    if not url:
        return None
    short = _is_short_link(url)
    if short:
        exp = await _expand_short_link(url)
    else:
        exp = _Expansion(url, [url], "")

    # Coordinates from the URL(s) first; when the app-share URL only names the
    # place (feature-id form, no pin), recover the pin from the page body so we
    # don't fall back to a name-only forward geocode that lands on the wrong
    # same-named place.
    lat, lng = _best_coords(exp.chain_urls)
    if lat is None:
        ftid = _FTID.search(exp.final_url)
        lat, lng = _coords_from_body(exp.body, ftid.group(1) if ftid else None)

    name = _extract_name(exp.final_url)
    result = None if (lat is None and not name) else MapsPlace(
        name=name, lat=lat, lng=lng, expanded_url=exp.final_url
    )
    if trace is not None:
        trace.add(
            "url_expansion",
            "Google Maps link parsed" if result else "Google Maps link — nothing parsable",
            {
                "original_url": url,
                "was_short_link": short,
                "expanded_url": exp.final_url,
                "redirect_chain": exp.chain_urls,
                "extracted_name": name,
                "coords": {"lat": lat, "lng": lng} if lat is not None else None,
                "parsed": result is not None,
            },
        )
    return result
