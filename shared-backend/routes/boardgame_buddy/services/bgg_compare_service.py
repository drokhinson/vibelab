"""Comparing a BoardgameBuddy shelf against a live BoardGameGeek collection.

One sweep, read two ways. `POST /bgg/check` runs this; both sync directions
then act on what it returns, so the user never starts a sync against a state
they have not seen.

  * PUSH (BgB -> BGG): games only in BgB get their flags set, games whose
    status disagrees get overwritten, and games flagged on BGG but absent from
    the BgB shelf get their flags cleared.
  * PULL (BGG -> BgB): games only on BGG become shelf rows, disagreements
    overwrite BgB — except a game the user marked Prev. owned, which
    _hold_prev_owned refuses to resurrect. A pull never removes a shelf row.

STATUSES ARE COMPARED DERIVED, NOT RAW. BgB's importer collapses BGG's
`wanttoplay` into `wishlist`, so a game flagged wanttoplay-but-not-wishlist
derives to `wishlist`, matches a BgB wishlist row, and is correctly left alone.
Comparing raw flags would push `wishlist=1` onto it — a write caused purely by
the import being lossy.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Optional

from supabase import Client

from ..bgg_collection_read import (
    BGG_THROTTLE_SECONDS,
    BggCollectionItem,
    _fetch_collection_items,
    _parse_collection_items,
)
from ..bgg_client import fetch_bgg_as_user
from ..constants import BggCheckPhase, BggPullChange, BggPushChange
from .bgg_progress import BggCheckProgress, NullProgress

logger = logging.getLogger(__name__)

# PostgREST caps an unbounded select server-side. Read the shelf in explicit
# pages and prove we reached the end — see _load_local_collection.
_PAGE = 1000
# BGG's /collection accepts a comma-joined id list. Kept well under any
# plausible URL ceiling; chunks are throttled like every other BGG call.
_COLLID_CHUNK = 100
_COLLID_MAX_CHUNKS = 8


@dataclass
class PlannedPush:
    bgg_id: int
    game_id: Optional[str]
    game_name: str
    thumbnail_url: Optional[str]
    change: BggPushChange
    local_status: Optional[str]
    remote_status: Optional[str]
    collid: Optional[int]
    raw_status: dict
    newly_catalogued: bool = False


@dataclass
class PlannedPull:
    bgg_id: int
    game_name: str
    change: BggPullChange
    local_status: Optional[str]
    remote_status: Optional[str]


@dataclass
class ComparePlan:
    push: list[PlannedPush] = field(default_factory=list)
    pull: list[PlannedPull] = field(default_factory=list)
    unpushable: list[dict] = field(default_factory=list)
    in_sync_count: int = 0
    local_total: int = 0
    remote_total: int = 0
    catalog_missing: list[int] = field(default_factory=list)
    warm_up_failed: bool = False


def _load_local_collection(sb: Client, user_id: str) -> list[dict]:
    """Every collection row for one user, read in explicit pages.

    THIS PAGINATION IS LOAD-BEARING. PostgREST caps an unbounded select at
    1000 rows, and a truncated shelf does not fail — it silently reads as
    "these games are not in BgB", which the push turns into clearing `own` off
    games the user still owns. The loop only stops on a short page, and logs
    loudly if it ever hits the safety bound instead.
    """
    rows: list[dict] = []
    offset = 0
    while True:
        page = (
            sb.table("boardgamebuddy_collections")
            .select("game_id, status, game_name, game_thumbnail_url, game_bgg_id")
            .eq("user_id", user_id)
            .order("game_id")
            .range(offset, offset + _PAGE - 1)
            .execute()
        ).data or []
        rows.extend(page)
        if len(page) < _PAGE:
            return rows
        offset += _PAGE
        if offset > 100_000:
            logger.error(
                "BGG compare: collection paging bound hit for user=%s at %d rows; "
                "refusing to plan against a possibly partial shelf",
                user_id, len(rows),
            )
            raise RuntimeError("collection paging did not terminate")


async def _resolve_collids(
    user_id: str, username: str, bgg_ids: list[int],
    *, progress: Optional[BggCheckProgress] = None,
) -> dict[int, BggCollectionItem]:
    """Look up BGG collection rows for games the status sweep could not see.

    The sweep filters on the four flags BgB tracks, so a game flagged only
    `fortrade` (or `want`, or nothing at all) is invisible to it even though a
    collection row exists. Pushing one of those with no collid risks creating a
    SECOND row and orphaning the user's rating and comment on the first.

    Best-effort: any failure returns what was resolved so far. An unresolved id
    just means the push treats it as a create, which is the status quo.
    """
    prog = progress or NullProgress()
    found: dict[int, BggCollectionItem] = {}
    if not bgg_ids:
        prog.skip(BggCheckPhase.COLLIDS, detail="Nothing new to add to BoardGameGeek")
        return found
    chunks = [
        bgg_ids[i:i + _COLLID_CHUNK]
        for i in range(0, len(bgg_ids), _COLLID_CHUNK)
    ][:_COLLID_MAX_CHUNKS]
    prog.begin(BggCheckPhase.COLLIDS, total=len(chunks))

    for i, chunk in enumerate(chunks):
        if i:
            await asyncio.sleep(BGG_THROTTLE_SECONDS)
        prog.tick(BggCheckPhase.COLLIDS, i)
        try:
            body = await fetch_bgg_as_user(
                user_id, "/collection",
                {
                    "username": username,
                    "id": ",".join(str(b) for b in chunk),
                    "stats": 1,
                    "showprivate": 1,
                },
                timeout=20.0,
                on_warm_up=lambda attempt, of, wait: prog.retry(
                    BggCheckPhase.COLLIDS,
                    attempt=attempt, of=of, wait_seconds=wait,
                ),
            )
        except Exception as exc:  # noqa: BLE001 — incl. BggWarmUpError
            logger.warning("BGG collid resolve failed for %d ids: %s", len(chunk), exc)
            # Best-effort by contract: an unresolved id just becomes a create.
            prog.tick(BggCheckPhase.COLLIDS, len(chunks), detail="Partly matched")
            return found
        for item in _parse_collection_items(body, username=username):
            if item.collid is not None:
                found[item.bgg_id] = item
    prog.tick(BggCheckPhase.COLLIDS, len(chunks))
    return found


def _classify_pull(local_status: str, remote_status: str) -> BggPullChange:
    """What an import would do to a shelf row that disagrees with BGG.

    Mirrors _hold_prev_owned: BGG's `own` flag is not curated the way an in-app
    tap is — people leave a sold game flagged own for years — so an incoming
    `owned` never overwrites a local `prev_owned`.
    """
    if local_status == "prev_owned" and remote_status == "owned":
        return BggPullChange.HELD
    return BggPullChange.UPDATE


async def build_plan(
    sb: Client, user_id: str, username: str,
    *, progress: Optional[BggCheckProgress] = None,
) -> ComparePlan:
    """Sweep BGG, read the shelf, and classify every game in both directions.

    `progress` is optional because this runs unwatched from POST /bgg/push as
    well as under the comparison checklist.
    """
    prog = progress or NullProgress()
    remote_items, warm_up_failed = await _fetch_collection_items(
        user_id, username, progress=prog,
    )
    remote = {it.bgg_id: it for it in remote_items}

    prog.begin(BggCheckPhase.SHELF)
    local_rows = await asyncio.to_thread(_load_local_collection, sb, user_id)
    prog.tick(
        BggCheckPhase.SHELF, 0,
        detail=f"{len(local_rows)} {'game' if len(local_rows) == 1 else 'games'} on your shelf",
    )
    plan = ComparePlan(
        local_total=len(local_rows),
        remote_total=sum(1 for it in remote_items if it.status is not None),
        warm_up_failed=warm_up_failed,
    )

    prog.begin(BggCheckPhase.COMPARE)

    # Rows BgB has that BoardGameGeek has no concept of.
    pushable: dict[int, dict] = {}
    for row in local_rows:
        bgg_id = row.get("game_bgg_id")
        if not bgg_id:
            plan.unpushable.append({
                "game_id": row["game_id"],
                "game_name": row.get("game_name") or "Untitled",
                "reason": "no_bgg_id",
            })
        else:
            pushable[bgg_id] = row

    add_candidates: list[int] = []
    for bgg_id, row in pushable.items():
        local_status = row["status"]
        item = remote.get(bgg_id)
        remote_status = item.status if item else None

        if remote_status is None:
            add_candidates.append(bgg_id)
            plan.push.append(PlannedPush(
                bgg_id=bgg_id, game_id=row["game_id"],
                game_name=row.get("game_name") or "Untitled",
                thumbnail_url=row.get("game_thumbnail_url"),
                change=BggPushChange.ADD,
                local_status=local_status, remote_status=None,
                collid=item.collid if item else None,
                raw_status=dict(item.raw_status) if item else {},
            ))
        elif remote_status != local_status:
            plan.push.append(PlannedPush(
                bgg_id=bgg_id, game_id=row["game_id"],
                game_name=row.get("game_name") or "Untitled",
                thumbnail_url=row.get("game_thumbnail_url"),
                change=BggPushChange.UPDATE,
                local_status=local_status, remote_status=remote_status,
                collid=item.collid, raw_status=dict(item.raw_status),
            ))
            plan.pull.append(PlannedPull(
                bgg_id=bgg_id, game_name=row.get("game_name") or "Untitled",
                change=_classify_pull(local_status, remote_status),
                local_status=local_status, remote_status=remote_status,
            ))
        else:
            plan.in_sync_count += 1

    # Flagged on BGG, absent from the BgB shelf: the push clears it, the pull
    # adds it. Items carrying none of the flags BgB tracks are not a
    # disagreement — they are simply none of our business.
    for bgg_id, item in remote.items():
        if item.status is None or bgg_id in pushable:
            continue
        plan.push.append(PlannedPush(
            bgg_id=bgg_id, game_id=None,
            game_name=item.name or f"BGG #{bgg_id}",
            thumbnail_url=None,
            change=BggPushChange.CLEAR,
            local_status=None, remote_status=item.status,
            collid=item.collid, raw_status=dict(item.raw_status),
        ))
        plan.pull.append(PlannedPull(
            bgg_id=bgg_id, game_name=item.name or f"BGG #{bgg_id}",
            change=BggPullChange.ADD,
            local_status=None, remote_status=item.status,
        ))

    # Games on the BGG shelf that BgB's catalog has never heard of. Queued for
    # a catalog-only import so the comparison can name them; the caller does
    # the queueing, since that is a write.
    prog.begin(BggCheckPhase.CATALOG)
    known = await asyncio.to_thread(_known_catalog_ids, sb, sorted(remote.keys()))
    plan.catalog_missing = sorted(
        bgg_id for bgg_id, item in remote.items()
        if item.status is not None and bgg_id not in known
    )
    for entry in plan.push:
        if entry.bgg_id in plan.catalog_missing:
            entry.newly_catalogued = True
    n_missing = len(plan.catalog_missing)
    prog.tick(
        BggCheckPhase.CATALOG, 0,
        detail=(
            f"{n_missing} {'game' if n_missing == 1 else 'games'} BgB has never seen"
            if n_missing else "Every game was already in the catalog"
        ),
    )

    resolved = await _resolve_collids(
        user_id, username, sorted(add_candidates), progress=prog,
    )
    for entry in plan.push:
        if entry.collid is None and entry.bgg_id in resolved:
            hit = resolved[entry.bgg_id]
            entry.collid = hit.collid
            entry.raw_status = dict(hit.raw_status)

    return plan


def _known_catalog_ids(sb: Client, bgg_ids: list[int]) -> set[int]:
    """Which of these BGG ids already exist in boardgamebuddy_games."""
    known: set[int] = set()
    for i in range(0, len(bgg_ids), 500):
        chunk = bgg_ids[i:i + 500]
        rows = (
            sb.table("boardgamebuddy_games")
            .select("bgg_id")
            .in_("bgg_id", chunk)
            .execute()
        ).data or []
        known.update(r["bgg_id"] for r in rows if r.get("bgg_id"))
    return known
