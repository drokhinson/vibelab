"""Unified game search — collection-first, then DB, optionally BGG."""

import logging
from typing import Any

from ..models import (
    BggSearchResult,
    GameSummary,
    UnifiedSearchHit,
    UnifiedSearchResponse,
)
from ..bgg_client import fetch_bgg, parse_bgg_xml
from ._helpers import fetch_games_by_ids, game_summary_from_row, game_select_clause

logger = logging.getLogger(__name__)


def _collection_hits(sb, viewer_id: str, query: str, limit: int) -> list[UnifiedSearchHit]:
    """Name-match the viewer's collection, filtered in SQL.

    This runs per keystroke; the old version fetched the viewer's ENTIRE
    collection every call and substring-filtered in Python. The !inner hint
    makes the embedded-game ilike apply to the parent collection rows, and
    the trigram index from migration 039 serves the ILIKE.
    """
    if limit <= 0:
        return []
    rows = (
        sb.table("boardgamebuddy_collections")
        .select(
            "status, game_id, "
            f"boardgamebuddy_games!boardgamebuddy_collections_game_id_fkey!inner({game_select_clause()})"
        )
        .eq("user_id", viewer_id)
        .ilike("boardgamebuddy_games.name", f"%{query}%")
        .limit(limit)
        .execute()
        .data
        or []
    )
    hits: list[UnifiedSearchHit] = []
    for r in rows:
        g = r.get("boardgamebuddy_games") or {}
        if not g or not g.get("name"):
            continue
        hits.append(UnifiedSearchHit(
            source="collection",
            game=game_summary_from_row(g),
            collection_status=r["status"],
        ))
    hits.sort(key=lambda h: h.game.name.lower())
    return hits


def _db_hits(
    sb,
    query: str,
    limit: int,
    *,
    exclude_game_ids: set[str],
) -> list[UnifiedSearchHit]:
    rows = (
        sb.table("boardgamebuddy_games")
        .select(game_select_clause())
        .ilike("name", f"%{query}%")
        .order("name")
        .limit(limit + len(exclude_game_ids))
        .execute()
        .data
        or []
    )
    hits: list[UnifiedSearchHit] = []
    for r in rows:
        if r["id"] in exclude_game_ids:
            continue
        hits.append(UnifiedSearchHit(source="db", game=game_summary_from_row(r)))
        if len(hits) >= limit:
            break
    return hits


async def _bgg_hits(sb, query: str, limit: int) -> list[BggSearchResult]:
    """Proxy the existing /games/search-bgg behavior. Swallows network errors
    so a flaky BGG never breaks the main search."""
    try:
        body = await fetch_bgg(
            "/search",
            {"query": query, "type": "boardgame,boardgameexpansion"},
            timeout=10.0,
        )
    except Exception as exc:
        logger.warning("BGG search failed for %r: %s", query, exc)
        return []

    try:
        root = parse_bgg_xml(body, context=f"unified search query={query!r}")
    except Exception as exc:
        logger.warning("BGG XML parse failed for %r: %s", query, exc)
        return []

    raw: list[dict[str, Any]] = []
    for item in root.findall("item")[:limit]:
        try:
            bgg_id = int(item.get("id", "0"))
        except (TypeError, ValueError):
            continue
        if not bgg_id:
            continue
        name_el = item.find("name")
        year_el = item.find("yearpublished")
        name = name_el.get("value", "") if name_el is not None else ""
        year = None
        if year_el is not None:
            try:
                year = int(year_el.get("value", "0")) or None
            except (TypeError, ValueError):
                year = None
        raw.append({
            "bgg_id": bgg_id,
            "name": name,
            "year_published": year,
            "is_expansion": item.get("type") == "boardgameexpansion",
        })

    if not raw:
        return []

    bgg_ids = [r["bgg_id"] for r in raw]
    existing = (
        sb.table("boardgamebuddy_games")
        .select("bgg_id")
        .in_("bgg_id", bgg_ids)
        .execute()
        .data
        or []
    )
    have = {row["bgg_id"] for row in existing}
    return [
        BggSearchResult(
            bgg_id=r["bgg_id"],
            name=r["name"],
            year_published=r["year_published"],
            is_expansion=r["is_expansion"],
            already_in_db=r["bgg_id"] in have,
        )
        for r in raw
    ]


async def unified_search(
    sb,
    viewer_id: str,
    query: str,
    *,
    limit: int = 20,
    include_bgg: bool = False,
) -> UnifiedSearchResponse:
    """Collection hits first, then DB hits, then (optionally) BGG."""
    q = (query or "").strip()
    if not q:
        return UnifiedSearchResponse(results=[], bgg_results=[], bgg_searched=include_bgg)

    collection_hits = _collection_hits(sb, viewer_id, q, limit)
    exclude = {h.game.id for h in collection_hits}
    remaining = max(0, limit - len(collection_hits))
    db_hits = _db_hits(sb, q, remaining, exclude_game_ids=exclude) if remaining else []
    all_hits = collection_hits + db_hits

    bgg_results: list[BggSearchResult] = []
    if include_bgg:
        bgg_results = await _bgg_hits(sb, q, limit)

    return UnifiedSearchResponse(
        results=all_hits,
        bgg_results=bgg_results,
        bgg_searched=include_bgg,
    )
