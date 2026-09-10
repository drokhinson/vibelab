"""Reading a BoardGameGeek collection: the sweep, the parsers, the merge.

Split out of bgg_link_routes.py once the collection read acquired a second
consumer. The import (bgg_link_routes) and the BgB→BGG comparison
(bgg_push_routes) both need the same eight throttled requests; only what they
keep from each `<item>` differs.

`_parse_collection_items` / `_fetch_collection_items` are the only place BGG's
XML is actually parsed, at FULL fidelity: every `<status>` attribute verbatim,
plus `collid` and `<name>`, plus items whose derived status is None. The push
needs all of it — the raw flags to echo back untouched, the collid to edit the
right row rather than create a second one, and the name to label a game that
has no local row at all. `_fetch_collection_batched` is the import's
(bgg_id, status, private) adapter over the same read.
"""

import asyncio
import logging
import os
from dataclasses import dataclass, field


from .bgg_client import BggWarmUpError, fetch_bgg_as_user, parse_bgg_xml
from .constants import BggCheckPhase
from .services.bgg_progress import BggCheckProgress, NullProgress

logger = logging.getLogger(__name__)

# BGG-collection statuses we import. Anything else (want, fortrade, preordered,
# …) is ignored; users can curate those flags on BGG and they won't pollute the
# BoardgameBuddy closet.
#
# ORDER IS LOAD-BEARING: _derive_collection_status walks this dict in insertion
# order after checking `own`, so a game flagged both prevowned and wishlist
# comes in as prev_owned. Each key is also its own (subtype, status) request in
# the batch sweep below, so adding one costs two more BGG calls per sync.
_BGG_STATUSES = {
    "own": "owned",
    "prevowned": "prev_owned",
    "wishlist": "wishlist",
    "wanttoplay": "wishlist",
}

# Subtypes we sweep when batching the /collection request. Each (subtype,
# status) pair is its own xmlapi2 call so BGG can serve a smaller, more
# cacheable subset — large combined requests are what trigger the warm-up
# placeholder response that returns zero items.
_COLLECTION_SUBTYPES: tuple[str, ...] = ("boardgame", "boardgameexpansion")

# What the checklist calls each subtype. The API's own spelling
# ("boardgameexpansion") is not a word anyone says out loud.
_SUBTYPE_LABEL = {"boardgame": "Board games", "boardgameexpansion": "Expansions"}

# Throttle between BGG calls inside the sweep. BGG's public limit is loose
# (a few req/sec) but they 429 aggressively if you blast them. The import
# worker reuses this same value for its per-game /thing fetches.
#
# Env-tunable for the same reason as _PUSH_THROTTLE_SECONDS, plus one more:
# this is what sets the pace of the comparison checklist, and raising it
# locally is the only way to watch the sweep advance a batch at a time without
# a thousand-game BoardGameGeek account.
BGG_THROTTLE_SECONDS = float(os.getenv("BGG_THROTTLE_SECONDS", "1.5"))


def _derive_collection_status(item) -> str | None:
    """Map a BGG <item><status .../></item> to our collection status, or None."""
    status_el = item.find("status")
    if status_el is None:
        return None
    # Priority: own > prevowned > wishlist/wanttoplay (latter two collapse into
    # 'wishlist'). `own` is checked out of band because it wins outright: BGG
    # sets prevowned alongside own for a copy you replaced, and you do have it.
    if status_el.get("own") == "1":
        return "owned"
    for flag, mapped in _BGG_STATUSES.items():
        if flag == "own":
            continue
        if status_el.get(flag) == "1":
            return mapped
    return None


def _parse_private_info(item) -> dict | None:
    """Extract <privateinfo .../> attributes (only present with showprivate=1).

    Returns None when the element is absent — callers should treat that as
    "no private fields to write" rather than nulling existing rows.
    """
    pi = item.find("privateinfo")
    if pi is None:
        return None

    def _num(name: str) -> float | None:
        val = pi.get(name)
        if val in (None, "", "0", "0.0", "0.00"):
            return None
        try:
            return float(val)
        except ValueError:
            return None

    def _int(name: str) -> int | None:
        val = pi.get(name)
        if val in (None, "", "0"):
            return None
        try:
            return int(val)
        except ValueError:
            return None

    acq_date = pi.get("acquisitiondate") or None
    if acq_date == "0000-00-00":
        acq_date = None

    private_comment_el = pi.find("privatecomment")
    private_comment = (
        private_comment_el.text.strip()
        if private_comment_el is not None and private_comment_el.text
        else None
    )

    return {
        "private_comment": private_comment,
        "acquired_from": (pi.get("acquiredfrom") or None) or None,
        "acquisition_date": acq_date,
        "purchase_price": _num("pricepaid"),
        "purchase_currency": (pi.get("pricepaidcurrency") or None) or None,
        "inventory_location": (pi.get("inventorylocation") or None) or None,
        "quantity": _int("quantity"),
    }

def _status_priority(status: str) -> int:
    """Higher means stronger — used to pick a winner when one game shows up
    in multiple per-status batches (e.g. owned AND wishlisted).

    prev_owned sits between the two: a game BGG reports as both prevowned and
    wishlisted is one you had, sold, and want back — the shelf it belongs on is
    the one that says you had it. Mirrors _derive_collection_status's ordering.
    """
    return {"owned": 3, "prev_owned": 2, "wishlist": 1}.get(status, 0)


@dataclass(frozen=True)
class BggCollectionItem:
    """One `<item>` from /collection, with nothing thrown away.

    `status` is the BgB-vocabulary value from _derive_collection_status, and is
    None for an item carrying none of the flags BgB tracks — those are KEPT
    here (the adapter below drops them) because the push needs to know a
    collection row exists before it decides whether to create one.
    """
    bgg_id: int
    collid: int | None
    name: str | None
    subtype: str | None
    status: str | None
    # dict(status_el.attrib), verbatim. Not an enumerated set of keys: a flag
    # BGG adds next year has to survive the round trip rather than be silently
    # dropped by a push that echoes only what we knew about today.
    raw_status: dict = field(default_factory=dict)
    private: dict | None = None


def _int_or_none(raw: str | None) -> int | None:
    try:
        return int(raw) if raw else None
    except (TypeError, ValueError):
        return None


def _parse_collection_items(body: str, *, username: str) -> list[BggCollectionItem]:
    """Parse /collection into full-fidelity items. The ONE parse implementation."""
    root = parse_bgg_xml(body, context=f"collection user={username!r}")
    out: list[BggCollectionItem] = []
    for item in root.findall("item"):
        bgg_id = _int_or_none(item.get("objectid"))
        if not bgg_id:
            continue
        status_el = item.find("status")
        name_el = item.find("name")
        out.append(BggCollectionItem(
            bgg_id=bgg_id,
            collid=_int_or_none(item.get("collid")),
            name=(name_el.text or None) if name_el is not None else None,
            subtype=item.get("subtype"),
            status=_derive_collection_status(item),
            raw_status=dict(status_el.attrib) if status_el is not None else {},
            private=_parse_private_info(item),
        ))
    return out


def _merge_collection_item(
    existing: BggCollectionItem, incoming: BggCollectionItem,
) -> BggCollectionItem:
    """Merge two sightings of the same game across the (subtype, flag) sweep.

    Highest-priority status wins (owned > prev_owned > wishlist),
    non-None private wins — and adds: prefer whichever sighting carried a
    collid, and take raw_status from that same one. The `<status>` element
    should be identical across batches since it is the same collection row, but
    "should be" is not a merge rule.
    """
    status = existing.status
    if _status_priority(incoming.status or "") > _status_priority(existing.status or ""):
        status = incoming.status
    with_collid = existing if existing.collid is not None else incoming
    return BggCollectionItem(
        bgg_id=existing.bgg_id,
        collid=existing.collid if existing.collid is not None else incoming.collid,
        name=existing.name or incoming.name,
        subtype=existing.subtype or incoming.subtype,
        status=status,
        raw_status=with_collid.raw_status or existing.raw_status or incoming.raw_status,
        private=existing.private if existing.private is not None else incoming.private,
    )


async def _fetch_collection_items(
    user_id: str, username: str,
    *, progress: BggCheckProgress | None = None,
) -> tuple[list[BggCollectionItem], bool]:
    """Sweep the linked user's collection at full fidelity.

    BGG's xmlapi2 has no page/limit pagination on /collection; the only way to
    subdivide a huge collection so each request is small enough to be served
    from cache (rather than triggering the warm-up placeholder) is to filter by
    subtype and a single status flag at a time. We sweep the matrix
    _COLLECTION_SUBTYPES x _BGG_STATUSES and dedupe the results.

    Returns (items, warm_up_failed). `warm_up_failed` is True iff at least one
    batch exhausted its warm-up retries — a batch that gave up returned ZERO
    items, which downstream reads as "not on BGG", so a push must refuse to run
    on a partial sweep rather than clear flags off games it simply did not see.
    """
    prog = progress or NullProgress()
    merged: dict[int, BggCollectionItem] = {}
    warm_up_failed = False
    first = True
    total = len(_COLLECTION_SUBTYPES) * len(_BGG_STATUSES)
    done = 0
    prog.begin(BggCheckPhase.COLLECTION, total=total)
    for subtype in _COLLECTION_SUBTYPES:
        for status_flag in _BGG_STATUSES.keys():
            if not first:
                await asyncio.sleep(BGG_THROTTLE_SECONDS)
            first = False
            prog.tick(
                BggCheckPhase.COLLECTION, done,
                detail=f"{_SUBTYPE_LABEL.get(subtype, subtype)} · {status_flag}",
            )
            params = {
                "username": username,
                status_flag: 1,
                "subtype": subtype,
                "stats": 1,
                "showprivate": 1,
            }
            try:
                body = await fetch_bgg_as_user(
                    user_id, "/collection", params, timeout=20.0,
                    on_warm_up=lambda attempt, of, wait: prog.retry(
                        BggCheckPhase.COLLECTION,
                        attempt=attempt, of=of, wait_seconds=wait,
                    ),
                )
            except BggWarmUpError:
                logger.warning(
                    "BGG collection batch warm-up exhausted user=%s subtype=%s status=%s",
                    user_id, subtype, status_flag,
                )
                warm_up_failed = True
                done += 1
                continue
            for item in _parse_collection_items(body, username=username):
                prev = merged.get(item.bgg_id)
                merged[item.bgg_id] = (
                    _merge_collection_item(prev, item) if prev is not None else item
                )
            done += 1
    prog.tick(
        BggCheckPhase.COLLECTION, done,
        detail=f"{len(merged)} {'game' if len(merged) == 1 else 'games'} on BoardGameGeek",
    )
    return list(merged.values()), warm_up_failed


# ── Historical contract ───────────────────────────────────────────────────────
# Both of these are adapters over the full-fidelity layer above. Their
# signatures and return shapes are exactly what they were before the split, so
# _run_sync and the bulk writers in bgg_link_routes are untouched.


def collection_rows_from_items(
    items: list[BggCollectionItem],
) -> list[tuple[int, str, dict | None]]:
    """Reduce full-fidelity items to the (bgg_id, status, private) import rows.

    Named and exported because the import no longer always does its own sweep:
    a comparison from the last few minutes already holds the items, and
    bgg_link_routes reduces those through here rather than re-implementing the
    filter. See services/bgg_check_cache.py.
    """
    return [
        (it.bgg_id, it.status, it.private)
        for it in items
        if it.status is not None
    ]


async def _fetch_collection_batched(
    user_id: str, username: str,
) -> tuple[list[tuple[int, str, dict | None]], bool]:
    """Pull the linked user's collection as N small (subtype, status) requests.

    The import's view of the sweep: same eight requests, same warm-up handling,
    reduced to the (bgg_id, status, private) rows _run_sync consumes.
    """
    items, warm_up_failed = await _fetch_collection_items(user_id, username)
    return collection_rows_from_items(items), warm_up_failed
