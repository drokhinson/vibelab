"""Unified game search — collection-first, then DB, optionally BGG."""

import logging
import re
from typing import Any, Optional

from ..models import (
    BggSearchResult,
    UnifiedSearchHit,
    UnifiedSearchResponse,
)
from ..bgg_client import fetch_bgg, parse_bgg_xml
from ._helpers import game_summary_from_row, game_select_clause

logger = logging.getLogger(__name__)

# A BGG id, typed bare or pasted as a link. BGG's own /search endpoint matches
# NAMES only, so "342942" there is a miss — yet an id (or the url you copied out
# of the address bar) is often exactly what you have in hand: off a shelf label,
# a forum post, a rulebook QR. Resolving it costs one /thing call, which is the
# same call the import itself makes and lands in the same 24h in-process cache.
#
# The url form also accepts /boardgameexpansion/ and BGG's occasional
# /boardgame/<id> with no slug. The trailing (?!\d) stops a 9-digit paste from
# being silently truncated to the first eight.
_BGG_URL_RE = re.compile(
    r"^https?://(?:www\.)?boardgamegeek\.com/boardgame(?:expansion)?/(\d{1,8})(?:[/?#]|$)",
    re.IGNORECASE,
)
_BGG_BARE_ID_RE = re.compile(r"^(\d{1,8})(?!\d)$")


def _parse_bgg_id(query: str) -> tuple[Optional[int], bool]:
    """(bgg_id, came_from_a_url) for a query that names one game outright.

    The url flag is what decides whether the name search still runs alongside
    it: a pasted link is unambiguous, but a bare number is NOT — "1830",
    "1960" and "18xx" are titles as well as plausible ids — so a typed number
    gets the id hit AND the name search, and the user picks.
    """
    q = (query or "").strip()
    m = _BGG_URL_RE.match(q)
    if m:
        return int(m.group(1)), True
    m = _BGG_BARE_ID_RE.match(q)
    if m:
        bgg_id = int(m.group(1))
        return (bgg_id, False) if bgg_id else (None, False)
    return None, False


# Hard ceiling on BGG rows returned in one response. BGG's /search has no
# paging — it hands back every match in one document, and for a franchise like
# Munchkin that is hundreds of items — so this is the only thing bounding the
# payload. Generous enough to be "the whole list" for any real query, low
# enough that a one-letter search cannot return five thousand rows.
_BGG_HARD_CAP = 500

# PostgREST takes the id set in the query string, so the existence check goes
# out in chunks rather than as one 500-id url.
_EXISTS_CHUNK = 150


def _name_rank(q: str, name: str) -> int:
    """How well `name` answers the query `q` — lower is better.

    BGG returns its matches in no useful order and does not rank them, so
    without this the list is whatever order BGG felt like. Searching "munchkin"
    put Epische Munchkin, a warehouse bookmark and four Good/Bad/Munchkin
    editions on screen and never showed plain Munchkin at all.

    Both arguments are already lowercased by the caller.
    """
    if name == q:
        return 0                                    # Munchkin
    if name.startswith(q + " ") or name.startswith(q + ":"):
        return 1                                    # Munchkin Booty
    if name.startswith(q):
        return 2                                    # Munchkinland
    if re.search(r"\b" + re.escape(q) + r"\b", name):
        return 3                                    # Star Munchkin
    if q in name:
        return 4                                    # ...munchkinesque...
    tokens = q.split()
    if len(tokens) > 1 and all(t in name for t in tokens):
        return 5                                    # every word, scattered
    return 6                                        # BGG matched an alias


def _rank_key(q: str, row: dict[str, Any]) -> tuple:
    """Best name match first, then base games ahead of expansions.

    Expansion rank sits BELOW name rank rather than above it on purpose: an
    expansion whose name is what you typed is a better answer than a base game
    that merely contains the word. Within one name rank, though, the base game
    is what people mean — so all of rank 1's base games come before any of
    rank 1's expansions. Shorter name breaks the remaining ties, which puts
    "Munchkin Fu" ahead of "Munchkin Fu Guest Artist Edition"; the name itself
    breaks the last of them so the order is stable rather than BGG's.
    """
    name = (row.get("name") or "").lower()
    return (
        _name_rank(q, name),
        1 if row.get("is_expansion") else 0,
        len(name),
        name,
    )


async def _bgg_thing_row(bgg_id: int, *, include_expansions: bool) -> Optional[dict[str, Any]]:
    """One /thing lookup, in the same raw shape _bgg_hits builds from /search.

    Returns None rather than raising for every "that is not a game you can
    import" case — an unknown id, an accessory or an RPG item, an expansion
    where the caller does not want one, a flaky BGG. The id search degrades to
    the name search either way, which is the right answer when the number the
    user typed turns out to be a title.
    """
    try:
        body = await fetch_bgg("/thing", {"id": bgg_id, "stats": 0}, timeout=10.0)
        root = parse_bgg_xml(body, context=f"thing id={bgg_id}")
    except Exception as exc:
        logger.warning("BGG /thing lookup failed for id=%s: %s", bgg_id, exc)
        return None

    item = root.find("item")
    if item is None:
        return None
    item_type = item.get("type") or ""
    if item_type not in ("boardgame", "boardgameexpansion"):
        return None
    is_expansion = item_type == "boardgameexpansion"
    if is_expansion and not include_expansions:
        return None

    # The primary name, not the first one: /thing lists every localized title,
    # and for a widely translated game the first is often not English.
    name_el = item.find("name[@type='primary']")
    if name_el is None:
        name_el = item.find("name")
    name = name_el.get("value", "") if name_el is not None else ""
    if not name:
        return None

    year = None
    year_el = item.find("yearpublished")
    if year_el is not None:
        try:
            year = int(year_el.get("value", "0")) or None
        except (TypeError, ValueError):
            year = None

    return {
        "bgg_id": bgg_id,
        "name": name,
        "year_published": year,
        "is_expansion": is_expansion,
    }


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
    *,
    include_expansions: bool,
) -> list[BggSearchResult]:
    """Proxy the existing /games/search-bgg behavior. Swallows network errors
    so a flaky BGG never breaks the main search.

    Two lookups, not one. BGG's /search matches names, so a query that IS an
    id — or the url you copied out of the address bar — finds nothing there;
    that one goes to /thing instead and lands at the top of the list. See
    _parse_bgg_id for why a bare number still runs both.
    """
    raw: list[dict[str, Any]] = []
    seen: set[int] = set()

    direct_id, from_url = _parse_bgg_id(query)
    if direct_id:
        row = await _bgg_thing_row(direct_id, include_expansions=include_expansions)
        if row:
            raw.append(row)
            seen.add(direct_id)
    if from_url:
        # A url names one game and nothing else, and the name search below
        # cannot add to that — /search matches titles, and a url string is not
        # one. So this is the whole answer, including when the link resolved to
        # nothing importable and the answer is an empty list.
        return _as_results(sb, raw)

    type_param = "boardgame,boardgameexpansion" if include_expansions else "boardgame"
    try:
        body = await fetch_bgg(
            "/search",
            {"query": query, "type": type_param},
            timeout=10.0,
        )
    except Exception as exc:
        logger.warning("BGG search failed for %r: %s", query, exc)
        return _as_results(sb, raw)

    try:
        root = parse_bgg_xml(body, context=f"unified search query={query!r}")
    except Exception as exc:
        logger.warning("BGG XML parse failed for %r: %s", query, exc)
        return _as_results(sb, raw)

    # EVERY item, then filter, then rank, then cap — in that order, and the
    # order is the fix. This used to slice `findall("item")[:limit]` FIRST and
    # drop expansions afterwards, which had two compounding failures on a
    # franchise search: expansions inside the first 20 were discarded with
    # nothing backfilling them, so a 20-row request returned a handful; and
    # BGG's own order is not relevance, so the rows that survived were an
    # arbitrary 20 of hundreds. Searching "munchkin" never showed Munchkin.
    matches: list[dict[str, Any]] = []
    for item in root.findall("item"):
        is_expansion = item.get("type") == "boardgameexpansion"
        # BGG's type= filter isn't reliably exclusive, so drop expansion rows
        # here too rather than trusting the query string alone.
        if is_expansion and not include_expansions:
            continue
        try:
            bgg_id = int(item.get("id", "0"))
        except (TypeError, ValueError):
            continue
        if not bgg_id or bgg_id in seen:
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
        matches.append({
            "bgg_id": bgg_id,
            "name": name,
            "year_published": year,
            "is_expansion": is_expansion,
        })
        seen.add(bgg_id)

    q_lower = (query or "").strip().lower()
    matches.sort(key=lambda r: _rank_key(q_lower, r))
    # An id hit, if there was one, keeps the top spot: the user named that game
    # outright and no name score outranks having asked for it by number.
    return _as_results(sb, raw + matches[: max(0, _BGG_HARD_CAP - len(raw))])


def _as_results(sb, raw: list[dict[str, Any]]) -> list[BggSearchResult]:
    """Stamp already_in_db across the whole batch in one query.

    Its own function because the id lookup can return before the name search
    runs (or instead of it), and every one of those exits still owes the rows
    their "already in the library" flag.
    """
    if not raw:
        return []
    ids = [r["bgg_id"] for r in raw]
    have: set[int] = set()
    # Chunked: PostgREST carries the id set in the query string, and the whole
    # list can now be hundreds long.
    for i in range(0, len(ids), _EXISTS_CHUNK):
        existing = (
            sb.table("boardgamebuddy_games")
            .select("bgg_id")
            .in_("bgg_id", ids[i:i + _EXISTS_CHUNK])
            .execute()
            .data
            or []
        )
        have.update(row["bgg_id"] for row in existing)
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
        # No `limit` here. That one is per DB source, and BGG is not one — its
        # /search returns the whole match set in a single document with no
        # paging, so what bounds this is _BGG_HARD_CAP and nothing else. The
        # caller asking for 20 catalog rows is not asking to be shown 20 of the
        # hundreds of things BoardGameGeek has.
        bgg_results = await _bgg_hits(sb, q, include_expansions=include_expansions)

    return UnifiedSearchResponse(
        results=all_hits,
        bgg_results=bgg_results,
        bgg_searched=include_bgg,
    )
