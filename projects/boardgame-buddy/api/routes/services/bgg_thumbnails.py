"""Thumbnails for BGG search rows — BGG's /search carries no images.

Three sources, cheapest first, for at most one /thing call per request:

  1. The catalog. A game already imported has a thumbnail we host.
  2. boardgamebuddy_bgg_thumb_cache (migration 054). Every answer BGG has
     given is kept — including "none" — so a game is looked up once rather
     than once per search, per deploy, per worker. Not a stub games row: that
     would flip already_in_db and join every backfill queue.
  3. BGG, for whatever is left: one batched /thing?stats=0 (BGG takes up to 20
     ids), written through to the cache.

A BGG failure answers None for the rows it owed; the sheet keeps its
placeholder mark, the same way a flaky BGG never breaks the search itself.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Iterable

from supabase import Client

from ..bgg_client import fetch_bgg, parse_bgg_xml, thing_item_image_urls
from ._helpers import chunked

logger = logging.getLogger(__name__)

THUMB_CACHE_TABLE = "boardgamebuddy_bgg_thumb_cache"

# /thing accepts a comma-separated id list; 20 is what every other batched
# /thing here settled on. Also the endpoint's cap, so one request is at most
# one BGG call.
MAX_IDS = 20

# Thumbnails rarely change; this only bounds how long a "BGG has none" answer,
# or a moved image, can linger.
_STALE_AFTER = timedelta(days=90)

# PostgREST carries the id set in the query string.
_READ_CHUNK = 150


def _from_catalog(sb: Client, ids: list[int]) -> dict[int, str]:
    out: dict[int, str] = {}
    for chunk in chunked(ids, _READ_CHUNK):
        rows = (
            sb.table("boardgamebuddy_games")
            .select("bgg_id, thumbnail_url")
            .in_("bgg_id", chunk)
            .execute()
            .data
            or []
        )
        for r in rows:
            if r.get("thumbnail_url"):
                out[int(r["bgg_id"])] = r["thumbnail_url"]
    return out


def cached_thumbnails(sb: Client, ids: list[int]) -> dict[int, str | None]:
    """Fresh cache rows only. A None value is a real answer: BGG has none."""
    cutoff = datetime.now(timezone.utc) - _STALE_AFTER
    out: dict[int, str | None] = {}
    for chunk in chunked(ids, _READ_CHUNK):
        rows = (
            sb.table(THUMB_CACHE_TABLE)
            .select("bgg_id, thumbnail_url, fetched_at")
            .in_("bgg_id", chunk)
            .execute()
            .data
            or []
        )
        for r in rows:
            try:
                fetched = datetime.fromisoformat(str(r["fetched_at"]).replace("Z", "+00:00"))
            except (TypeError, ValueError):
                continue
            if fetched >= cutoff:
                out[int(r["bgg_id"])] = r.get("thumbnail_url")
    return out


def known_thumbnails(sb: Client, ids: Iterable[int]) -> dict[int, str | None]:
    """Catalog + cache, never BGG. Blocking — callers go through to_thread.

    The search response reads these two itself, in _as_results, so most rows
    arrive with a thumbnail and the sheet only asks about the unseen ones.
    """
    wanted = list(dict.fromkeys(int(i) for i in ids))
    if not wanted:
        return {}
    found: dict[int, str | None] = dict(_from_catalog(sb, wanted))
    rest = [i for i in wanted if i not in found]
    if rest:
        found.update(cached_thumbnails(sb, rest))
    return found


async def _from_bgg(ids: list[int]) -> dict[int, str | None] | None:
    """One /thing call. None (not {}) when BGG failed, so nothing is cached."""
    try:
        body = await fetch_bgg(
            "/thing", {"id": ",".join(str(i) for i in ids), "stats": 0}, timeout=10.0
        )
        root = parse_bgg_xml(body, context=f"search thumbnails ({len(ids)} ids)")
    except Exception as exc:  # noqa: BLE001 — a thumbnail, never the sheet
        logger.warning("BGG thumbnail lookup failed (%d ids): %s", len(ids), exc)
        return None
    out: dict[int, str | None] = {i: None for i in ids}
    for item in root.findall("item"):
        try:
            bgg_id = int(item.get("id", "0"))
        except (TypeError, ValueError):
            continue
        if bgg_id in out:
            out[bgg_id] = thing_item_image_urls(item)[1]
    return out


def _write_cache(sb: Client, answers: dict[int, str | None]) -> None:
    now = datetime.now(timezone.utc).isoformat()
    try:
        sb.table(THUMB_CACHE_TABLE).upsert(
            [
                {"bgg_id": i, "thumbnail_url": url, "fetched_at": now}
                for i, url in answers.items()
            ],
            on_conflict="bgg_id",
        ).execute()
    except Exception:  # noqa: BLE001 — the answer still goes back to the caller
        logger.warning("BGG thumbnail cache write failed (%d ids)", len(answers), exc_info=True)


async def bgg_thumbnails(sb: Client, ids: list[int]) -> dict[int, str | None]:
    """Thumbnail per requested id; None where BGG has none or could not say."""
    wanted = list(dict.fromkeys(int(i) for i in ids))[:MAX_IDS]
    if not wanted:
        return {}
    found = await asyncio.to_thread(known_thumbnails, sb, wanted)
    missing = [i for i in wanted if i not in found]
    if missing:
        fetched = await _from_bgg(missing)
        if fetched is not None:
            await asyncio.to_thread(_write_cache, sb, fetched)
            found.update(fetched)
    return {i: found.get(i) for i in wanted}
