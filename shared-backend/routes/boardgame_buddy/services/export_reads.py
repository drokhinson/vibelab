"""The reads behind the data export, one builder per dataset.

Every builder takes (client, user_id) and returns the CsvFiles that dataset
contributes to the archive. They are plain synchronous Supabase calls — the
route runs the whole build in one worker thread rather than making each of
these async, because the Supabase client is synchronous and a build that
touched the event loop between every page would block all ten apps for the
length of the export.

services/export_service.py owns the registry, the counts and the zip;
services/export_csv.py owns the formatting.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable, Optional

from supabase import Client

from ..constants import EXPORT_IN_CHUNK, EXPORT_MAX_ROWS, EXPORT_PAGE_SIZE
from .export_csv import CsvFile

logger = logging.getLogger("vibelab")


# ── Paging ────────────────────────────────────────────────────────────────────

def page_all(build_query, order_by: str, *, label: str) -> list[dict[str, Any]]:
    """Read every row a query matches, in explicit pages.

    THIS PAGINATION IS LOAD-BEARING, for the same reason it is in
    services/bgg_compare_service.py: PostgREST caps an unbounded select at 1000
    rows and a truncated read does not fail. There it silently un-owned games;
    here it silently ships an export that looks complete and is missing the
    user's last decade of plays — which is worse, because nothing downstream
    ever notices.

    `build_query` is a zero-arg callable rather than a query object because a
    PostgREST builder cannot be re-ranged: each page needs a fresh one.
    `order_by` must be unique enough to totally order the rows, or a page
    boundary repeats and skips.
    """
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = (
            build_query()
            .order(order_by)
            .range(offset, offset + EXPORT_PAGE_SIZE - 1)
            .execute()
        ).data or []
        rows.extend(page)
        if len(page) < EXPORT_PAGE_SIZE:
            return rows
        offset += EXPORT_PAGE_SIZE
        if offset > EXPORT_MAX_ROWS:
            logger.error("Export: paging bound hit for %s at %d rows", label, len(rows))
            raise RuntimeError(f"export paging did not terminate for {label}")


def chunks(values: list[str]) -> Iterable[list[str]]:
    """Split ids into `.in_()`-sized batches (see EXPORT_IN_CHUNK)."""
    for i in range(0, len(values), EXPORT_IN_CHUNK):
        yield values[i:i + EXPORT_IN_CHUNK]


def embedded(row: dict[str, Any], table: str) -> dict[str, Any]:
    """One embedded PostgREST row as a dict, whatever shape it came back in.

    A to-one embed is an object, but the same select against a relationship
    PostgREST reads as to-many is a list, and an unmatched one is None. Callers
    only ever want "the joined row or nothing", so normalise here rather than
    at nine call sites.
    """
    value = row.get(table)
    if isinstance(value, list):
        value = value[0] if value else None
    return value if isinstance(value, dict) else {}


def profile_names(sb: Client, user_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
    """Resolve a set of user ids to {id: profile row}.

    A separate read rather than a PostgREST embed because the two tables that
    need it — buddy edges and play rosters — each carry SEVERAL foreign keys
    into boardgamebuddy_profiles, so an embed has to name a constraint
    (`boardgamebuddy_profiles!boardgamebuddy_buddy_edges_user_a_fkey`) and a
    later migration renaming a constraint would break the export silently.
    """
    ids = sorted({uid for uid in user_ids if uid})
    if not ids:
        return {}
    out: dict[str, dict[str, Any]] = {}
    for chunk in chunks(ids):
        rows = (
            sb.table("boardgamebuddy_profiles")
            .select("id, display_name, username")
            .in_("id", chunk)
            .execute()
        ).data or []
        for row in rows:
            out[row["id"]] = row
    return out


# ── Collection ────────────────────────────────────────────────────────────────

_COLLECTION_SELECT = (
    "game_id, status, added_at, played_before_at, game_name, game_bgg_id, "
    "game_year_published, game_min_players, game_max_players, "
    "game_playing_time, game_is_expansion, game_base_game_bgg_id, "
    "game_play_mode, bgg_quantity, bgg_acquired_from, bgg_acquisition_date, "
    "bgg_purchase_price, bgg_purchase_currency, bgg_inventory_location, "
    "bgg_private_comment"
)

_COLLECTION_HEADER = [
    "row_type", "game_name", "status", "bgg_id", "year_published",
    "is_expansion", "base_game_bgg_id", "min_players", "max_players",
    "playing_time", "play_mode", "added_at", "played_before_marked_at",
    "quantity", "acquired_from", "acquisition_date", "purchase_price",
    "purchase_currency", "inventory_location", "private_comment", "game_id",
]


def build_collection(sb: Client, user_id: str, _ctx: dict[str, Any]) -> list[CsvFile]:
    """The shelf and the owned expansions, in one file.

    Two kinds of row under one header, told apart by the leading `row_type`
    column: `shelf` for a boardgamebuddy_collections row — owned, previously
    owned or wishlist — and `expansion` for a boardgamebuddy_user_expansions
    one. They were separate ticks and separate files, which asked a user to
    know that this app keeps owned expansions off the shelf. They do not, and
    it is not a distinction worth a checkbox.

    An expansion carries no shelf status, so `status` is left BLANK on those
    rows rather than invented: `owned_expansion` is not a value the app's own
    shelf ever writes, and putting it in a column somebody will filter on would
    be inventing data to fill a cell.

    The shelf block is emitted first and the expansions after it, each
    alphabetical, rather than interleaved — so a collection.csv from before
    this merge diffs against one after it as purely appended rows.

    Reads the denormalized `game_*` columns rather than joining the catalog —
    they are what the shelf itself is drawn from, and a name frozen on the row
    is the name the user shelved, which is the honest thing to export.
    """
    shelf = page_all(
        lambda: sb.table("boardgamebuddy_collections")
        .select(_COLLECTION_SELECT)
        .eq("user_id", user_id),
        "game_id", label="collection",
    )
    shelf.sort(key=lambda r: ((r.get("game_name") or "").lower(), r.get("game_id") or ""))
    out = [[
        "shelf",
        r.get("game_name"), r.get("status"), r.get("game_bgg_id"),
        r.get("game_year_published"), r.get("game_is_expansion"),
        r.get("game_base_game_bgg_id"), r.get("game_min_players"),
        r.get("game_max_players"), r.get("game_playing_time"),
        r.get("game_play_mode"), r.get("added_at"), r.get("played_before_at"),
        r.get("bgg_quantity"), r.get("bgg_acquired_from"),
        r.get("bgg_acquisition_date"), r.get("bgg_purchase_price"),
        r.get("bgg_purchase_currency"), r.get("bgg_inventory_location"),
        r.get("bgg_private_comment"), r.get("game_id"),
    ] for r in shelf]

    expansions = page_all(
        lambda: sb.table("boardgamebuddy_user_expansions")
        .select("expansion_game_id, boardgamebuddy_games(name, bgg_id, "
                "year_published, base_game_bgg_id)")
        .eq("user_id", user_id),
        "expansion_game_id", label="expansions",
    )
    exp_rows = []
    for r in expansions:
        game = embedded(r, "boardgamebuddy_games")
        exp_rows.append([
            "expansion",
            game.get("name"), None, game.get("bgg_id"),
            game.get("year_published"), True,
            game.get("base_game_bgg_id"), None,
            None, None,
            None, None, None,
            None, None,
            None, None,
            None, None,
            None, r.get("expansion_game_id"),
        ])
    exp_rows.sort(key=lambda row: (str(row[1] or "").lower(), str(row[20] or "")))

    return [CsvFile("collection.csv", _COLLECTION_HEADER, out + exp_rows)]


# ── Reference guides ──────────────────────────────────────────────────────────

_CHAPTER_FIELDS = "title, chapter_type, content, created_by, created_at, updated_at, game_id"


def build_guides(sb: Client, user_id: str, _ctx: dict[str, Any]) -> list[CsvFile]:
    """Rules chapters, as both halves of what "yours" means here.

    A chapter can be in your guide because you wrote it or because you took
    somebody else's from the pool, and you can also have written one you later
    dropped from your own guide. Exporting only the selections loses text the
    user typed, so both reads are unioned on chapter id and the two flags say
    which case each row is.
    """
    selected = page_all(
        lambda: sb.table("boardgamebuddy_user_chapters")
        .select(f"chapter_id, created_at, boardgamebuddy_guide_chapters({_CHAPTER_FIELDS})")
        .eq("user_id", user_id),
        "chapter_id", label="guide selections",
    )
    authored = page_all(
        lambda: sb.table("boardgamebuddy_guide_chapters")
        .select(f"id, {_CHAPTER_FIELDS}")
        .eq("created_by", user_id),
        "id", label="authored chapters",
    )

    merged: dict[str, dict[str, Any]] = {}
    for r in selected:
        chapter = embedded(r, "boardgamebuddy_guide_chapters")
        if not chapter:
            continue
        merged[r["chapter_id"]] = {
            **chapter, "_added_at": r.get("created_at"), "_in_guide": True,
        }
    for chapter in authored:
        entry = merged.setdefault(chapter["id"], {**chapter, "_added_at": None,
                                                 "_in_guide": False})
        entry.update({k: v for k, v in chapter.items() if k != "id"})

    game_names = _game_names(sb, [c.get("game_id") for c in merged.values()])
    out = []
    for chapter_id, c in merged.items():
        out.append([
            game_names.get(c.get("game_id") or "", {}).get("name"),
            c.get("chapter_type"), c.get("title"), c.get("content"),
            c.get("created_by") == user_id, c.get("_in_guide"),
            c.get("created_at"), c.get("updated_at"), c.get("_added_at"),
            chapter_id,
        ])
    out.sort(key=lambda row: (str(row[0] or "").lower(), str(row[2] or "").lower()))
    header = ["game_name", "chapter_type", "title", "content", "written_by_you",
              "in_your_guide", "created_at", "updated_at", "added_to_guide_at",
              "chapter_id"]
    return [CsvFile("guide_chapters.csv", header, out)]


def _game_names(sb: Client, game_ids: Iterable[Optional[str]]) -> dict[str, dict[str, Any]]:
    """Resolve game UUIDs to {id: {name, bgg_id}}."""
    ids = sorted({gid for gid in game_ids if gid})
    if not ids:
        return {}
    out: dict[str, dict[str, Any]] = {}
    for chunk in chunks(ids):
        rows = (
            sb.table("boardgamebuddy_games")
            .select("id, name, bgg_id")
            .in_("id", chunk)
            .execute()
        ).data or []
        for row in rows:
            out[row["id"]] = row
    return out
