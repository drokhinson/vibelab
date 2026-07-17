"""Place extraction via Google Gemini (free tier).

Given whatever context we managed to scrape (possibly only the URL, when the
source site blocks us — plus any share-sheet caption the phone sent along),
ask Gemini for EVERY distinct place the page mentions. One reel or listicle
can fan out into several places; a single-place page returns a one-element
list. ~500 input / ~150–800 output tokens per call — inside Gemini's free tier.
"""

import json
import os
import re
from dataclasses import dataclass
from typing import Optional

import httpx

from api_logger import log_external_call

from ..constants import (
    APP_NAME,
    AnchorType,
    BookingKind,
    GEMINI_MODEL,
    LLM_MAX_TOKENS_MULTI,
    MAX_PLACES_PER_SOURCE,
)
from .scraper import PageContent
_ENDPOINT = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)

_client: Optional[httpx.AsyncClient] = None


class LLMError(Exception):
    pass


@dataclass
class PlaceExtraction:
    place_name: Optional[str]
    city: Optional[str]
    country: Optional[str]
    category: str
    geocode_query: Optional[str]
    confident: bool
    # Set when the place came straight from a Google Maps URL (services/gmaps):
    # the exact pin coordinates and the original link, so enrichment can
    # reverse-geocode the point instead of re-guessing via forward geocode.
    lat: Optional[float] = None
    lng: Optional[float] = None
    maps_url: Optional[str] = None


@dataclass
class BookingExtraction:
    """The page is itself a lodging/transport booking (or listing) — captured
    with a trip context it becomes a checkpoint instead of a place scrap."""
    kind: str                        # BookingKind: 'stay' | 'travel'
    label: str                       # e.g. "Hotel Doma" / "Flight to Athens"
    location: Optional[str]          # geocodable place string
    start_date: Optional[str]        # ISO date — stay: check-in; travel: leg day
    end_date: Optional[str]          # ISO date — stay only: check-out
    time: Optional[str]              # HH:MM — travel only: departure time
    transport_type: Optional[str]    # AnchorType — travel only


def _get_api_key() -> str:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise LLMError("GEMINI_API_KEY is not set")
    return key


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=30.0)
    return _client


_SYSTEM = (
    "You extract travel places from web pages people saved while planning "
    "trips. Respond with ONLY a JSON object — no prose, no code fences."
)


def _build_prompt(
    url: str,
    page: Optional[PageContent],
    categories: list[str],
    shared_text: Optional[str] = None,
) -> str:
    lines = [f"URL: {url}"]
    if shared_text:
        # Share-sheet caption from the user's phone — often the only usable
        # context when the source site (Instagram etc.) blocks server fetches.
        lines.append(f"Share-sheet text from the user's app: {shared_text}")
    if page:
        if page.title:
            lines.append(f"Page title: {page.title}")
        if page.og_title:
            lines.append(f"og:title: {page.og_title}")
        if page.og_description:
            lines.append(f"og:description: {page.og_description}")
        if page.text_excerpt:
            lines.append(f"Page text (truncated): {page.text_excerpt}")
    else:
        lines.append(
            "The page could not be fetched. Infer the place(s) from the URL "
            "and any share-sheet text (path slugs often contain the place name)."
        )
    lines.append(
        "\nExtract EVERY distinct real-world place a traveler would want to "
        "save from this page (restaurants, bars, sights, shops, lodging...). "
        "A page may be about one place or list many (e.g. '10 best ramen "
        "shops'). Additionally, decide whether the page IS a lodging or "
        "transport booking: a hotel/Airbnb reservation, confirmation, or "
        "listing page ('stay'), or a flight/train/ferry/bus/car-rental "
        "booking or itinerary ('travel'). If so fill in \"booking\"; for any "
        "other page (articles, reels, maps, reviews) set \"booking\" to null. "
        "Reply with this exact JSON shape:\n"
        "{\n"
        '  "places": [\n'
        "    {\n"
        '      "place_name": string,\n'
        '      "city": string or null,\n'
        '      "country": string or null,\n'
        f'      "category": one of {json.dumps(categories)},\n'
        '      "geocode_query": string or null  // best search string for OpenStreetMap Nominatim,\n'
        '      "confident": boolean\n'
        "    }\n"
        "  ],\n"
        '  "booking": null or {\n'
        '    "kind": "stay" or "travel",\n'
        '    "label": string,  // e.g. "Hotel Doma" or "Flight to Athens (ATH)",\n'
        '    "location": string or null,  // geocodable: property + city, or the destination airport/station,\n'
        '    "start_date": "YYYY-MM-DD" or null,  // stay: check-in; travel: departure day,\n'
        '    "end_date": "YYYY-MM-DD" or null,  // stay only: check-out,\n'
        '    "time": "HH:MM" or null,  // travel only: departure time,\n'
        '    "transport_type": one of ["airport", "train_station", "car_rental", "other"] or null  // travel only\n'
        "  }\n"
        "}\n"
        "For a booking page, still list the lodging or destination as a place "
        f"entry in \"places\". Order by prominence. Include at most {MAX_PLACES_PER_SOURCE}. "
        'If no specific place is identifiable, return {"places": [], "booking": null}.'
    )
    return "\n".join(lines)


def _parse_json(text: str) -> dict:
    """Tolerant JSON parse: strip code fences, grab the outermost object."""
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise LLMError(f"no JSON object in LLM reply: {text[:200]}")
    return json.loads(text[start : end + 1])


def _extract_text(payload: dict) -> str:
    """Pull the model's text out of Gemini's generateContent response."""
    candidates = payload.get("candidates") or []
    if not candidates:
        # No candidate = safety block or empty reply. Surface the reason if any.
        reason = payload.get("promptFeedback", {}).get("blockReason", "no candidates")
        raise LLMError(f"Gemini returned no usable output ({reason})")
    parts = candidates[0].get("content", {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts)
    if not text:
        raise LLMError("Gemini returned an empty response")
    return text


def _coerce_places(data: dict, categories: list[str]) -> list[PlaceExtraction]:
    """Accept {"places": [...]} (canonical) or a bare single-place object
    (belt-and-braces for model drift); drop unusable entries; clamp count."""
    raw = data.get("places")
    if raw is None:
        raw = [data]  # bare single object
    if not isinstance(raw, list):
        raise LLMError(f"unexpected LLM reply shape: {str(data)[:200]}")

    places: list[PlaceExtraction] = []
    for item in raw[:MAX_PLACES_PER_SOURCE]:
        if not isinstance(item, dict):
            continue
        name = (item.get("place_name") or "").strip() if item.get("place_name") else ""
        if not name:
            continue
        category = item.get("category")
        if category not in categories:
            category = "other"
        places.append(PlaceExtraction(
            place_name=name,
            city=item.get("city") or None,
            country=item.get("country") or None,
            category=category,
            geocode_query=item.get("geocode_query") or None,
            confident=bool(item.get("confident", False)),
        ))
    return places


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^\d{2}:\d{2}(:\d{2})?$")


def _coerce_booking(data: dict) -> Optional[BookingExtraction]:
    """Validate the optional booking classification; None on anything off."""
    raw = data.get("booking")
    if not isinstance(raw, dict):
        return None
    kind = raw.get("kind")
    label = (raw.get("label") or "").strip()
    if kind not in (BookingKind.STAY, BookingKind.TRAVEL) or not label:
        return None

    def _date(v: object) -> Optional[str]:
        return v if isinstance(v, str) and _DATE_RE.match(v) else None

    time_ = raw.get("time")
    if not (isinstance(time_, str) and _TIME_RE.match(time_)):
        time_ = None
    transport = raw.get("transport_type")
    if transport not in tuple(AnchorType):
        transport = None
    return BookingExtraction(
        kind=kind,
        label=label[:120],
        location=(raw.get("location") or None),
        start_date=_date(raw.get("start_date")),
        end_date=_date(raw.get("end_date")),
        time=time_,
        transport_type=transport,
    )


async def extract_places(
    url: str,
    page: Optional[PageContent],
    categories: list[str],
    shared_text: Optional[str] = None,
) -> tuple[list[PlaceExtraction], Optional[BookingExtraction]]:
    """Ask Gemini for every place the page mentions, plus whether the page is
    itself a lodging/transport booking. Raises LLMError on failure; an empty
    place list means the page has no identifiable places."""
    api_key = _get_api_key()
    client = _get_client()
    prompt = _build_prompt(url, page, categories, shared_text)
    body = {
        "system_instruction": {"parts": [{"text": _SYSTEM}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "maxOutputTokens": LLM_MAX_TOKENS_MULTI,
            "temperature": 0,
        },
    }

    # The API key rides in a header (never in the logged URL/params).
    async with log_external_call(
        app=APP_NAME,
        api_name="gemini",
        method="POST",
        url=_ENDPOINT,
        params={"model": GEMINI_MODEL, "source_url": url},
    ) as record:
        try:
            resp = await client.post(
                _ENDPOINT,
                headers={"x-goog-api-key": api_key},
                json=body,
            )
        except httpx.HTTPError as exc:
            raise LLMError(f"Gemini request failed: {exc}") from exc
        record.attach_response(resp)
        if resp.status_code != 200:
            raise LLMError(f"Gemini API error {resp.status_code}: {resp.text[:300]}")
        payload = resp.json()
        text = _extract_text(payload)

    data = _parse_json(text)
    return _coerce_places(data, categories), _coerce_booking(data)
