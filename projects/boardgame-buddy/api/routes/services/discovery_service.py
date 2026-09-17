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
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from supabase import Client

import cache

from ..constants import AdminRunLevel, AdminRunTool, AdminTrendingPhase, DiscoverReasonKind
from ..models import (
    DiscoverBundleResponse,
    DiscoverDormantEntry,
    DiscoverPick,
    DiscoverTrendingEntry,
    GameSummary,
    HotRefreshResult,
)
from ..bgg_client import _BGG_CACHE_HOT, fetch_hot_games
from ..bgg_collection_read import BGG_THROTTLE_SECONDS
from . import admin_run_progress
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
# The refresh imports hot games the catalog lacks, and each import is one
# /thing?stats=1 plus two R2 uploads on a client with no rate limiter — so a
# run takes at most this many, spaced by the BGG throttle, and reports the rest
# as skipped for tomorrow's run.
HOT_IMPORT_PER_RUN = 10
HOT_RETENTION_DAYS = 30


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
            rank_delta=i.get("rank_delta"),
            is_new=bool(i.get("is_new")),
        ))
    return out[:TRENDING_LIMIT]


def _latest_snapshot(sb: Client) -> list[dict]:
    """bgb_bgg_hot_latest rows, or [] when no run has been written yet."""
    return sb.rpc("bgb_bgg_hot_latest", {}).execute().data or []


async def fetch_trending(sb: Client) -> tuple[list[DiscoverTrendingEntry], bool]:
    """The newest hot-list snapshot with catalog rows attached; (entries, bgg_failed).

    Snapshot first (migration 039): it survives worker restarts and carries
    yesterday's ranks, which is what "climbing" is. Only when no run has ever
    been written — first deploy, cron not yet wired — does this fall back to
    BGG live, exactly as before 039.
    """
    items = await asyncio.to_thread(_latest_snapshot, sb)
    if not items:
        items = await fetch_hot_games()
        if not items:
            return [], True
    entries = await asyncio.to_thread(_hydrate_trending, sb, items)
    return entries, False


def _write_snapshot(sb: Client, items: list[dict], captured_at: datetime) -> tuple[int, int, list[int]]:
    """Insert one run, prune the old ones, and say which bgg_ids the catalog lacks."""
    rows = [{
        "captured_at": captured_at.isoformat(),
        "bgg_id": i["bgg_id"],
        "rank": i["rank"],
        "name": i["name"],
        "year_published": i.get("year_published"),
        "thumbnail_url": i.get("thumbnail_url"),
    } for i in items]
    sb.table("boardgamebuddy_bgg_hot_snapshots").insert(rows).execute()
    cutoff = (captured_at - timedelta(days=HOT_RETENTION_DAYS)).isoformat()
    pruned = (
        sb.table("boardgamebuddy_bgg_hot_snapshots")
        .delete()
        .lt("captured_at", cutoff)
        .execute()
    ).data or []
    bgg_ids = [i["bgg_id"] for i in items]
    have = (
        sb.table("boardgamebuddy_games")
        .select("bgg_id")
        .in_("bgg_id", bgg_ids)
        .execute()
    ).data or []
    present = {int(r["bgg_id"]) for r in have if r.get("bgg_id")}
    missing = [b for b in bgg_ids if b not in present]
    return len(rows), len(pruned), missing


def hot_names(items: list[dict]) -> dict[int, str]:
    """bgg_id → the name BGG gave it on the hot list.

    The import loop has only ids to work with, and a run log that says
    "12333 failed" is a log an admin has to go and decode. BGG already told us
    the name in the same response, so carry it.
    """
    return {i["bgg_id"]: (i.get("name") or f"BGG {i['bgg_id']}") for i in items}


async def refresh_hot_snapshot(sb: Client, *, progress=None) -> HotRefreshResult:
    """Fetch BGG's hot list, keep it as a run, and import what the catalog lacks.

    Straight to BGG (no cache): a refresh that re-wrote the hour-old list
    would be a no-op with a fresh captured_at, and the delta RPC would then
    compare the same list against itself. An empty answer is a 503 rather
    than an empty run — the delta math treats "no run" and "a run with no
    rows" very differently, and only the first one is true.

    Imports are the cap-and-sleep loop the stats backfill uses, for the same
    reason: sequential, spaced, one failure logged and skipped. Both caches
    the rail reads through are dropped at the end so the new run is what the
    next viewer sees.

    `progress` is the admin run ledger (services/admin_run_progress.py). It is
    optional and defaults to a muted one so the cron, a test, or any future
    caller with no page behind it can run this unchanged — the narration below
    is then dict writes that go nowhere, which is why there is no `if progress`
    at any of the eleven call sites.
    """
    # Inside the function: game_routes is a route module that imports this
    # package's services, so a top-level import here is a cycle. Same shape
    # bgg_link_routes' pending-import drain uses.
    from ..game_routes import import_game_from_bgg

    prog = progress or admin_run_progress.NullProgress(AdminRunTool.TRENDING)
    P = AdminTrendingPhase

    prog.begin(P.FETCH)
    items = await fetch_hot_games(use_cache=False)
    if not items:
        # Named as BGG's failure rather than ours: this is the one outcome an
        # operator will want to tell apart from "the import loop broke".
        raise HTTPException(status_code=503, detail="BoardGameGeek did not return a hot list")
    prog.tick(P.FETCH, 0, detail=f"{len(items)} games on the hot list")

    captured_at = datetime.now(timezone.utc)
    names = hot_names(items)
    prog.begin(P.SNAPSHOT, total=len(items))
    written, pruned, missing = await asyncio.to_thread(_write_snapshot, sb, items, captured_at)
    prog.tick(P.SNAPSHOT, written, detail=f"{written} rows written")

    # PRUNE and DIFF both happened inside that one threaded call — the three
    # statements share a connection and a captured_at, and splitting them to
    # give each phase its own await would buy nothing but round trips. They are
    # still three rows, because they are three things an operator asks about.
    prog.begin(P.PRUNE)
    prog.tick(P.PRUNE, 0, detail=(
        f"{pruned} rows older than {HOT_RETENTION_DAYS} days removed" if pruned
        else "nothing old enough to remove"
    ))
    prog.begin(P.DIFF)
    prog.tick(P.DIFF, 0, detail=(
        f"{len(missing)} of {len(items)} not in the catalog" if missing
        else "the catalog already has every hot game"
    ))

    imported = 0
    failed: list[int] = []
    to_import = missing[:HOT_IMPORT_PER_RUN]
    skipped = missing[HOT_IMPORT_PER_RUN:]
    if not to_import:
        prog.skip(P.IMPORT, detail="Nothing new to import")
    else:
        prog.begin(P.IMPORT, total=len(to_import))
    for n, bgg_id in enumerate(to_import):
        if n:
            await asyncio.sleep(BGG_THROTTLE_SECONDS)
        name = names.get(bgg_id, f"BGG {bgg_id}")
        prog.tick(P.IMPORT, n, detail=name)
        try:
            await import_game_from_bgg(sb, bgg_id)
            imported += 1
            prog.event(P.IMPORT, f"Imported {name} (BGG {bgg_id})")
        except Exception as exc:  # noqa: BLE001 — one bad import must not sink the run
            logger.warning("Hot-list import of bgg_id=%s failed", bgg_id, exc_info=True)
            failed.append(bgg_id)
            prog.event(
                P.IMPORT,
                f"{name} (BGG {bgg_id}) — {exc}",
                level=AdminRunLevel.ERROR,
            )
    if to_import:
        prog.tick(P.IMPORT, len(to_import))
    if skipped:
        # A warn rather than an error: the cap is working as designed, and the
        # next run picks these up. It is still the thing an admin wonders about
        # when the counts do not add up.
        prog.event(
            P.IMPORT,
            f"{len(skipped)} more are missing and will import on the next run "
            f"(cap is {HOT_IMPORT_PER_RUN} per run)",
            level=AdminRunLevel.WARN,
        )

    prog.begin(P.CACHES)
    cache.clear(_NS)
    cache.clear(_BGG_CACHE_HOT)
    prog.tick(P.CACHES, 0, detail="Discover rails will rebuild on the next visit")
    prog.add_totals(updated=imported, failed=len(failed), remaining=len(skipped))

    return HotRefreshResult(
        captured_at=captured_at,
        items=written,
        imported=imported,
        skipped=skipped,
        failed=failed,
        pruned=pruned,
    )


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
