"""Shared BoardGameGeek XMLAPI2 client.

Used by both the game-catalog import endpoints (game_routes.py) and the BGG
account-linking sync (bgg_link_routes.py). All BGG HTTP traffic should go
through `fetch_bgg()` so error handling, auth headers, and the User-Agent
stay consistent.
"""

import logging
import os
import xml.etree.ElementTree as ET

import httpx
from fastapi import HTTPException

logger = logging.getLogger(__name__)

BGG_API_BASE = "https://boardgamegeek.com/xmlapi2"
BGG_USER_AGENT = "vibelab-boardgame-buddy/1.0"
BGG_API_TOKEN = os.getenv("BGG_API_TOKEN")


async def fetch_bgg(path: str, params: dict, *, timeout: float) -> str:
    """GET an XML document from the BGG API with consistent error mapping.

    Raises HTTPException for any non-200 response so callers can let it bubble
    up. 202 is mapped to 503 ("warming up, retry shortly") because BGG returns
    it while building cold-cache results — the caller should retry.
    """
    headers = {"User-Agent": BGG_USER_AGENT}
    if BGG_API_TOKEN:
        headers["Authorization"] = f"Bearer {BGG_API_TOKEN}"

    try:
        async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
            resp = await client.get(f"{BGG_API_BASE}{path}", params=params)
    except httpx.HTTPError as exc:
        logger.warning("BGG network error on %s %s: %s", path, params, exc)
        raise HTTPException(
            status_code=503,
            detail="BoardGameGeek is temporarily unreachable. Try again in a moment.",
        )

    if resp.status_code == 401:
        logger.error("BGG 401 — BGG_API_TOKEN missing or invalid")
        raise HTTPException(
            status_code=502,
            detail="BoardGameGeek authentication failed. Ensure BGG_API_TOKEN is set in Railway.",
        )
    if resp.status_code == 202:
        logger.info("BGG 202 (warming up) for %s %s", path, params)
        raise HTTPException(
            status_code=503,
            detail="BoardGameGeek is warming up this result. Retry in a few seconds.",
        )
    if resp.status_code == 429:
        logger.warning("BGG 429 rate limit for %s %s", path, params)
        raise HTTPException(
            status_code=429,
            detail="BoardGameGeek rate-limited us. Wait a few seconds and try again.",
        )
    if resp.status_code != 200:
        logger.warning(
            "BGG returned %s for %s %s: %s",
            resp.status_code, path, params, resp.text[:200],
        )
        raise HTTPException(
            status_code=502,
            detail=f"BoardGameGeek returned HTTP {resp.status_code}.",
        )

    return resp.text


def parse_bgg_xml(body: str, *, context: str) -> ET.Element:
    """Parse a BGG XML payload; map parse errors to a 502."""
    try:
        return ET.fromstring(body)
    except ET.ParseError as exc:
        logger.warning(
            "BGG XML parse error (%s): %s\nbody[:300]=%r",
            context, exc, body[:300],
        )
        raise HTTPException(
            status_code=502,
            detail="Could not parse BoardGameGeek response.",
        )


def normalize_image_url(url: str | None) -> str | None:
    """Ensure BGG image URLs have an explicit https: scheme.

    BGG returns protocol-relative URLs (`//cf.geekdo-images.com/...`); the
    Storage uploader and the frontend image proxy both want a full URL.
    """
    if not url:
        return None
    url = url.strip()
    if url.startswith("//"):
        return "https:" + url
    return url
