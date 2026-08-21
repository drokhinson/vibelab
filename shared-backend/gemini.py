"""Shared Google Gemini caller.

One place for "ask Gemini for a JSON object" so every app that needs a small
LLM task shares the same endpoint, model alias, error type, and api_logs
plumbing. Currently used by BoardgameBuddy chapter generation
(`routes/boardgame_buddy/services/chapter_ai.py`).

Travel Trove's place extraction (`routes/travel_scrapbook/services/llm.py`)
predates this module and keeps its own copy of the call — it carries a lot of
extraction-specific coercion. If it is ever touched substantially, migrate it
onto `generate_json` here.

Usage:

    from gemini import GeminiError, generate_json

    data = await generate_json(
        app="boardgame-buddy",
        system="You write board game reference cards…",
        prompt=prompt,
        max_tokens=2000,
        temperature=0.4,
        params={"game": game_name},
    )
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Optional

import httpx

from api_logger import log_external_call

# The Google-maintained "-latest" alias rather than a pinned model ID: the
# previously pinned gemini-2.5-flash was pulled from the API on 2026-07-09
# (ahead of its announced shutdown), 404-ing every request. The alias hot-swaps
# to the current Flash-Lite release with a 2-week email notice before any
# behavior change, so a silent early deprecation can't take an app down again.
# Swap to gemini-flash-latest for a stronger (still free-tier) model if output
# quality needs it.
GEMINI_MODEL = "gemini-flash-lite-latest"

_ENDPOINT = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)

# Lazy module-level singleton: one connection pool for the process rather than
# a fresh client (and TLS handshake) per call. 45s covers a long structured
# generation on a cold model; the caller is a user-facing request, so this is
# also the ceiling on how long that request can hang.
_client: Optional[httpx.AsyncClient] = None


class GeminiError(Exception):
    """Any failure talking to Gemini: missing key, transport, non-200, safety
    block, or an unparseable reply. Callers map this to their own HTTP error."""


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=45.0)
    return _client


def _get_api_key() -> str:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise GeminiError("GEMINI_API_KEY is not set")
    return key


def _extract_text(payload: dict) -> str:
    """Pull the model's text out of Gemini's generateContent response."""
    candidates = payload.get("candidates") or []
    if not candidates:
        # No candidate = safety block or empty reply. Surface the reason if any.
        reason = payload.get("promptFeedback", {}).get("blockReason", "no candidates")
        raise GeminiError(f"Gemini returned no usable output ({reason})")
    parts = candidates[0].get("content", {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts)
    if not text:
        raise GeminiError("Gemini returned an empty response")
    return text


def _parse_json(text: str) -> dict:
    """Tolerant JSON parse: strip code fences, grab the outermost object.

    responseMimeType=application/json makes fenced output unlikely, but the
    model still drifts occasionally and a fence would otherwise 500 the route.
    """
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise GeminiError(f"no JSON object in Gemini reply: {text[:200]}")
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError as exc:
        raise GeminiError(f"malformed JSON in Gemini reply: {exc}") from exc


async def generate_json(
    *,
    app: str,
    system: str,
    prompt: str,
    max_tokens: int,
    temperature: float = 0.0,
    params: Optional[dict[str, Any]] = None,
) -> dict:
    """Ask Gemini for a single JSON object and return it parsed.

    `app` and `params` land on the public.api_logs row written for the call.
    Raises GeminiError on every failure mode.
    """
    api_key = _get_api_key()
    client = _get_client()
    body = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "maxOutputTokens": max_tokens,
            "temperature": temperature,
        },
    }

    # The API key rides in a header (never in the logged URL/params).
    async with log_external_call(
        app=app,
        api_name="gemini",
        method="POST",
        url=_ENDPOINT,
        params={"model": GEMINI_MODEL, **(params or {})},
    ) as record:
        try:
            resp = await client.post(
                _ENDPOINT,
                headers={"x-goog-api-key": api_key},
                json=body,
            )
        except httpx.HTTPError as exc:
            raise GeminiError(f"Gemini request failed: {exc}") from exc
        record.attach_response(resp)
        if resp.status_code != 200:
            raise GeminiError(f"Gemini API error {resp.status_code}: {resp.text[:300]}")
        text = _extract_text(resp.json())

    return _parse_json(text)
