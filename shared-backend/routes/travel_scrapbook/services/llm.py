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

from ..constants import APP_NAME, GEMINI_MODEL, LLM_MAX_TOKENS_MULTI, MAX_PLACES_PER_SOURCE
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
        "shops'). Reply with this exact JSON shape:\n"
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
        "  ]\n"
        "}\n"
        f"Order by prominence. Include at most {MAX_PLACES_PER_SOURCE}. "
        'If no specific place is identifiable, return {"places": []}.'
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


async def extract_places(
    url: str,
    page: Optional[PageContent],
    categories: list[str],
    shared_text: Optional[str] = None,
) -> list[PlaceExtraction]:
    """Ask Gemini for every place the page mentions. Raises LLMError on
    failure; an empty list means the page has no identifiable places."""
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

    return _coerce_places(_parse_json(text), categories)
