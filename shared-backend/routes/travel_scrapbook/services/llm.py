"""Place extraction via Claude Haiku.

Given whatever context we managed to scrape (possibly only the URL, when the
source site blocks us), ask Haiku to identify the single main place the page
is about and produce a Nominatim-friendly geocode query. ~500 input / ~150
output tokens per call.
"""

import json
import os
import re
from dataclasses import dataclass
from typing import Optional

import anthropic

from api_logger import log_external_call

from ..constants import APP_NAME, HAIKU_MODEL
from .scraper import PageContent

MAX_TOKENS = 300

_client: Optional[anthropic.AsyncAnthropic] = None


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


def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise LLMError("ANTHROPIC_API_KEY is not set")
        _client = anthropic.AsyncAnthropic()
    return _client


_SYSTEM = (
    "You extract travel places from web pages people saved while planning "
    "trips. Respond with ONLY a JSON object — no prose, no code fences."
)


def _build_prompt(url: str, page: Optional[PageContent], categories: list[str]) -> str:
    lines = [f"URL: {url}"]
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
            "The page could not be fetched. Infer the place from the URL "
            "alone (path slugs often contain the place name)."
        )
    lines.append(
        "\nExtract the single main place this page is about. If it lists "
        "several, pick the most prominent. Reply with this exact JSON shape:\n"
        "{\n"
        '  "place_name": string or null,\n'
        '  "city": string or null,\n'
        '  "country": string or null,\n'
        f'  "category": one of {json.dumps(categories)},\n'
        '  "geocode_query": string or null  // best search string for OpenStreetMap Nominatim,\n'
        '  "confident": boolean\n'
        "}\n"
        "If no specific place is identifiable, set place_name to null."
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


async def extract_place(
    url: str, page: Optional[PageContent], categories: list[str]
) -> PlaceExtraction:
    """Ask Haiku what place the page is about. Raises LLMError on failure."""
    client = _get_client()
    prompt = _build_prompt(url, page, categories)

    async with log_external_call(
        app=APP_NAME,
        api_name="anthropic-haiku",
        method="POST",
        url="https://api.anthropic.com/v1/messages",
        params={"model": HAIKU_MODEL, "source_url": url},
    ) as record:
        try:
            response = await client.messages.create(
                model=HAIKU_MODEL,
                max_tokens=MAX_TOKENS,
                system=_SYSTEM,
                messages=[{"role": "user", "content": prompt}],
            )
        except anthropic.APIError as exc:
            raise LLMError(f"Anthropic API error: {exc}") from exc
        text = next((b.text for b in response.content if b.type == "text"), "")
        record.status_code = 200
        record.body_excerpt = text[:1000]
        record.extra = {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        }

    data = _parse_json(text)
    category = data.get("category")
    if category not in categories:
        category = "other"
    return PlaceExtraction(
        place_name=data.get("place_name") or None,
        city=data.get("city") or None,
        country=data.get("country") or None,
        category=category,
        geocode_query=data.get("geocode_query") or None,
        confident=bool(data.get("confident", False)),
    )
