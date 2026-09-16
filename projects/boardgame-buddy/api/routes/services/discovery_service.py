"""Discover tab assembly — personal picks, BGG's hot list, this year's
releases, and the viewer's dormant shelf, in one bundle.

Four independent sections, fetched concurrently the way build_feed_page does
it (sync PostgREST calls on worker threads, the async BGG call on the loop)
and cached per viewer for ten minutes. Each section degrades on its own: a
brand-new account gets catalog-rank picks instead of personal ones, and a BGG
outage flags the trending rail rather than failing the tab.

The ten-minute server cache is the accepted staleness contract for a screen
that is a suggestion, not a ledger. The client drops its own copy on any
collection or play write and asks with `refresh=true` on the next mount, so a
game the viewer just shelved off a pick does not come straight back.
"""

import asyncio
import logging
from datetime import date, datetime, timezone
from typing import Any

from supabase import Client

import cache

from ..constants import DiscoverReasonKind
from ..models import (
    DiscoverBundleResponse,
    DiscoverDormantEntry,
    DiscoverPick,
    DiscoverTrendingEntry,
    GameSummary,
)
from ..bgg_client import fetch_hot_games
from ._helpers import fetch_games_by_ids, game_select_clause, game_summary_from_row

logger = logging.getLogger(__name__)

_NS = "discover.bundle"           # viewer id → DiscoverBundleResponse
_TTL_S = 10 * 60
cache.configure(_NS, max_entries=2048)

PICKS_LIMIT = 12
TRENDING_LIMIT = 20
NEW_LIMIT = 12
# "New this year" widens to last year when the current one is thin — January
# would otherwise be an empty rail.
NEW_MIN_ROWS = 6
DORMANT_DAYS = 60
DORMANT_LIMIT = 8


# ── Reasons ───────────────────────────────────────────────────────────────────

def _join_names(names: list[str]) -> str:
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " and " + names[-1]


def format_reason(
    kind: DiscoverReasonKind,
    *,
    reason_game_name: str | None = None,
    shared_mechanics: list[str] | None = None,
    shared_categories: list[str] | None = None,
) -> str:
    """The one line under a pick. Names the reason, never the score
    (web-frontend.md: "label a suggestion by its reason").

    Pure, so it is unit-tested without a database. Falls through to the next
    reason when the data for the labelled one is missing — an RPC row can say
    `because_you_play` with no seed name only if the catalog row vanished
    between the two reads, but a label must never come out empty.
    """
    mechs = [m for m in (shared_mechanics or []) if m]
    cats = [c for c in (shared_categories or []) if c]

    if kind == DiscoverReasonKind.BECAUSE_YOU_PLAY and reason_game_name:
        return f"Because you play {reason_game_name}"
    if kind in (DiscoverReasonKind.BECAUSE_YOU_PLAY, DiscoverReasonKind.SHARED_MECHANICS) and mechs:
        if len(mechs) >= 3:
            return f"Shares {len(mechs)} mechanics with your shelf"
        return f"Shares {_join_names(mechs)} with your shelf"
    if kind in (
        DiscoverReasonKind.BECAUSE_YOU_PLAY,
        DiscoverReasonKind.SHARED_MECHANICS,
        DiscoverReasonKind.SHARED_CATEGORIES,
    ) and cats:
        return f"More {cats[0]} like you play"
    if kind == DiscoverReasonKind.FITS_YOUR_TABLE:
        return "Fits your usual table"
    return "Highly rated on BoardGameGeek"


# ── Sections ──────────────────────────────────────────────────────────────────

def _cold_start_picks(sb: Client) -> list[DiscoverPick]:
    """No shelf, no plays: the best-ranked base games in the catalog.

    Before the stats backfill has run every bgg_rank is NULL and this is
    newest-imported — acceptable, and the section's empty-state copy on the
    client already says "log a few plays and we'll get personal".
    """
    rows = (
        sb.table("boardgamebuddy_games")
        .select(game_select_clause())
        .eq("is_expansion", False)
        .order("bgg_rank", desc=False, nullsfirst=False)
        .order("created_at", desc=True)
        .limit(PICKS_LIMIT)
        .execute()
    ).data or []
    return [
        DiscoverPick(
            game=game_summary_from_row(r),
            reason_kind=DiscoverReasonKind.HIGHLY_RATED,
            reason_label=format_reason(DiscoverReasonKind.HIGHLY_RATED),
            cold_start=True,
        )
        for r in rows
    ]


def fetch_picks(sb: Client, uid: str) -> list[DiscoverPick]:
    """bgb_discover_recommendations → hydrated, labelled picks."""
    rows = sb.rpc(
        "bgb_discover_recommendations",
        {"uid": uid, "lim": PICKS_LIMIT},
    ).execute().data or []
    if not rows:
        return _cold_start_picks(sb)
    games = fetch_games_by_ids(sb, [r["game_id"] for r in rows])
    picks: list[DiscoverPick] = []
    for r in rows:
        g = games.get(r["game_id"])
        if not g:
            continue
        try:
            kind = DiscoverReasonKind(r.get("reason_kind") or "")
        except ValueError:
            kind = DiscoverReasonKind.HIGHLY_RATED
        mechs = list(r.get("shared_mechanics") or [])
        cats = list(r.get("shared_categories") or [])
        picks.append(DiscoverPick(
            game=g,
            reason_kind=kind,
            reason_label=format_reason(
                kind,
                reason_game_name=r.get("reason_game_name"),
                shared_mechanics=mechs,
                shared_categories=cats,
            ),
            reason_game_id=r.get("reason_game_id"),
            shared_mechanics=mechs,
            shared_categories=cats,
        ))
    return picks


def _new_rows(sb: Client, year: int, limit: int) -> list[dict[str, Any]]:
    return (
        sb.table("boardgamebuddy_games")
        .select(game_select_clause())
        .eq("is_expansion", False)
        .eq("year_published", year)
        .order("bgg_rank", desc=False, nullsfirst=False)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    ).data or []


def fetch_new_this_year(sb: Client, *, today: date | None = None) -> tuple[list[GameSummary], int]:
    """This year's catalog releases by rank; widened to last year when thin."""
    year = (today or date.today()).year
    rows = _new_rows(sb, year, NEW_LIMIT)
    if len(rows) < NEW_MIN_ROWS:
        rows = rows + _new_rows(sb, year - 1, NEW_LIMIT - len(rows))
    return [game_summary_from_row(r) for r in rows], year


def fetch_back_on_shelf(sb: Client, uid: str) -> list[DiscoverDormantEntry]:
    """bgb_dormant_collection → owned games that have not hit the table lately."""
    rows = sb.rpc(
        "bgb_dormant_collection",
        {"uid": uid, "days_since": DORMANT_DAYS, "lim": DORMANT_LIMIT},
    ).execute().data or []
    games = fetch_games_by_ids(sb, [r["game_id"] for r in rows])
    out: list[DiscoverDormantEntry] = []
    for r in rows:
        g = games.get(r["game_id"])
        if not g:
            continue
        out.append(DiscoverDormantEntry(game=g, last_played_at=r.get("last_played_at")))
    return out


def _hydrate_trending(sb: Client, items: list[dict]) -> list[DiscoverTrendingEntry]:
    """Attach the catalog row to each hot-list item that has one."""
    bgg_ids = [i["bgg_id"] for i in items]
    by_bgg: dict[int, GameSummary] = {}
    if bgg_ids:
        rows = (
            sb.table("boardgamebuddy_games")
            .select(game_select_clause())
            .in_("bgg_id", bgg_ids)
            .execute()
        ).data or []
        by_bgg = {int(r["bgg_id"]): game_summary_from_row(r) for r in rows if r.get("bgg_id")}
    out: list[DiscoverTrendingEntry] = []
    for i in items:
        g = by_bgg.get(i["bgg_id"])
        # The hot list is type=boardgame but BGG files some expansions under
        # it. Everywhere else in the app an expansion lives under its base
        # game rather than as a tile of its own; same here.
        if g is not None and g.is_expansion:
            continue
        out.append(DiscoverTrendingEntry(
            bgg_id=i["bgg_id"],
            rank=i["rank"],
            name=(g.name if g else i["name"]),
            year_published=(g.year_published if g else i.get("year_published")),
            thumbnail_url=(g.thumbnail_url if g else i.get("thumbnail_url")),
            game=g,
        ))
    return out[:TRENDING_LIMIT]


async def fetch_trending(sb: Client) -> tuple[list[DiscoverTrendingEntry], bool]:
    """BGG's hot list with catalog rows attached; (entries, bgg_failed)."""
    items = await fetch_hot_games()
    if not items:
        return [], True
    entries = await asyncio.to_thread(_hydrate_trending, sb, items)
    return entries, False


# ── The bundle ────────────────────────────────────────────────────────────────

async def build_bundle(sb: Client, uid: str, *, refresh: bool = False) -> DiscoverBundleResponse:
    """Everything the Discover tab paints, in one round trip."""
    if not refresh:
        hit = cache.get(_NS, uid)
        if hit is not None:
            return hit

    picks, (trending, trending_error), (new_games, new_year), dormant = await asyncio.gather(
        asyncio.to_thread(fetch_picks, sb, uid),
        fetch_trending(sb),
        asyncio.to_thread(fetch_new_this_year, sb),
        asyncio.to_thread(fetch_back_on_shelf, sb, uid),
    )
    bundle = DiscoverBundleResponse(
        picks=picks,
        trending=trending,
        trending_error=trending_error,
        new_this_year=new_games,
        new_year=new_year,
        back_on_shelf=dormant,
        dormant_days=DORMANT_DAYS,
        generated_at=datetime.now(timezone.utc),
    )
    # A BGG outage is not worth remembering for ten minutes: the next viewer
    # gets another try at the rail while the picks still come from cache on
    # their own terms. Everything else is.
    if not trending_error:
        cache.set(_NS, uid, bundle, ttl_seconds=_TTL_S)
    return bundle


def invalidate(uid: str) -> None:
    """Drop one viewer's cached bundle."""
    cache.delete(_NS, uid)
