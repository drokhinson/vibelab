"""Unified game search — collection-first, then DB, optionally BGG."""

import logging
from typing import Any

from ..models import (
    BggSearchResult,
    UnifiedSearchHit,
    UnifiedSearchResponse,
)
from ..bgg_client import fetch_bgg, parse_bgg_xml
from ._helpers import game_summary_from_row, game_select_clause

logger = logging.getLogger(__name__)


def _collection_hits(
    sb,
    viewer_id: str,
    query: str,
    limit: int,
    *,
    include_expansions: bool,
) -> list[UnifiedSearchHit]:
    """Name-match the viewer's collection, filtered in SQL.

    This runs per keystroke; the old version fetched the viewer's ENTIRE
    collection every call and substring-filtered in Python. The !inner hint
    makes the embedded-game ilike apply to the parent collection rows, and
    the trigram index from migration 039 serves the ILIKE.
    """
    if limit <= 0:
        return []
    q = (
        sb.table("boardgamebuddy_collections")
        .select(
            "status, game_id, "
            f"boardgamebuddy_games!boardgamebuddy_collections_game_id_fkey!inner({game_select_clause()})"
        )
        .eq("user_id", viewer_id)
        .ilike("boardgamebuddy_games.name", f"%{query}%")
    )
    if not include_expansions:
        q = q.eq("boardgamebuddy_games.is_expansion", False)
    rows = q.limit(limit).execute().data or []
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
    include_expansions: bool,
) -> list[UnifiedSearchHit]:
    q = (
        sb.table("boardgamebuddy_games")
        .select(game_select_clause())
        .ilike("name", f"%{query}%")
    )
    if not include_expansions:
        q = q.eq("is_expansion", False)
    rows = (
        q.order("name")
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


def _rpc_hits(
    sb,
    viewer_id: str,
    query: str,
    limit: int,
    *,
    include_expansions: bool,
) -> list[UnifiedSearchHit]:
    """Single index-backed query via the boardgamebuddy_search_games RPC.

    The RPC does the trigram-indexed catalog ILIKE, LEFT JOINs the viewer's
    collection, and returns rows collection-first. Each row carries the
    GameSummary columns plus `in_collection` / `collection_status`. Raises if
    the RPC is missing or predates migration 041's `p_include_expansions`
    parameter, so unified_search can fall back.
    """
    res = sb.rpc(
        "boardgamebuddy_search_games",
        {
            "p_viewer": viewer_id,
            "p_query": query,
            "p_limit": limit,
            "p_include_expansions": include_expansions,
        },
    ).execute()
    rows = res.data or []
    hits: list[UnifiedSearchHit] = []
    for r in rows:
        if not r or not r.get("name"):
            continue
        if r.get("in_collection"):
            hits.append(UnifiedSearchHit(
                source="collection",
                game=game_summary_from_row(r),
                collection_status=r.get("collection_status"),
            ))
        else:
            hits.append(UnifiedSearchHit(source="db", game=game_summary_from_row(r)))
    return hits


async def _bgg_hits(
    sb,
    query: str,
    limit: int,
    *,
    include_expansions: bool,
) -> list[BggSearchResult]:
    """Proxy the existing /games/search-bgg behavior. Swallows network errors
    so a flaky BGG never breaks the main search."""
    type_param = "boardgame,boardgameexpansion" if include_expansions else "boardgame"
    try:
        body = await fetch_bgg(
            "/search",
            {"query": query, "type": type_param},
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
        is_expansion = item.get("type") == "boardgameexpansion"
        # BGG's type= filter isn't reliably exclusive, so drop expansion rows
        # here too rather than trusting the query string alone.
        if is_expansion and not include_expansions:
            continue
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
            "is_expansion": is_expansion,
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
    include_expansions: bool = False,
) -> UnifiedSearchResponse:
    """Collection hits first, then DB hits, then (optionally) BGG.

    Expansions are excluded by default: they aren't pickable as a session's
    main game and are added through the base game's expansion section instead.
    """
    q = (query or "").strip()
    if not q:
        return UnifiedSearchResponse(results=[], bgg_results=[], bgg_searched=include_bgg)

    # Fast path: one index-backed RPC. Fall back to the two-query PostgREST
    # path if the RPC isn't present yet (migration 041 not applied) or errors,
    # so an auto-deploy ahead of the migration never breaks search.
    try:
        all_hits = _rpc_hits(sb, viewer_id, q, limit, include_expansions=include_expansions)
    except Exception as exc:
        logger.warning("search RPC unavailable, using two-query fallback: %s", exc)
        collection_hits = _collection_hits(
            sb, viewer_id, q, limit, include_expansions=include_expansions,
        )
        exclude = {h.game.id for h in collection_hits}
        remaining = max(0, limit - len(collection_hits))
        db_hits = (
            _db_hits(
                sb, q, remaining,
                exclude_game_ids=exclude,
                include_expansions=include_expansions,
            )
            if remaining
            else []
        )
        all_hits = collection_hits + db_hits

    bgg_results: list[BggSearchResult] = []
    if include_bgg:
        bgg_results = await _bgg_hits(sb, q, limit, include_expansions=include_expansions)

    return UnifiedSearchResponse(
        results=all_hits,
        bgg_results=bgg_results,
        bgg_searched=include_bgg,
    )
