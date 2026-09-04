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


# ── Profile ───────────────────────────────────────────────────────────────────

def build_profile(sb: Client, user_id: str, _ctx: dict[str, Any]) -> list[CsvFile]:
    """The account row itself — one line, and deliberately not all of it.

    The BGG columns beside `bgg_username` on this table are an encrypted
    password and live session cookies. They are this account's data in the
    narrow sense and exporting them would hand a plaintext-ish credential to
    whatever the zip is later emailed through, so only the handle ships.
    """
    rows = (
        sb.table("boardgamebuddy_profiles")
        .select("id, username, display_name, created_at, bgg_username, "
                "is_admin, needs_setup, app_installed_at, bgg_last_sync_started_at")
        .eq("id", user_id)
        .execute()
    ).data or []
    row = rows[0] if rows else {}
    header = [
        "user_id", "username", "display_name", "joined_at", "bgg_username",
        "is_admin", "onboarding_pending", "app_installed_at", "bgg_last_sync_at",
    ]
    return [CsvFile("profile.csv", header, [[
        row.get("id"), row.get("username"), row.get("display_name"),
        row.get("created_at"), row.get("bgg_username"), row.get("is_admin"),
        row.get("needs_setup"), row.get("app_installed_at"),
        row.get("bgg_last_sync_started_at"),
    ]] if row else [])]


# ── Collection ────────────────────────────────────────────────────────────────

_COLLECTION_SELECT = (
    "game_id, status, added_at, played_before_at, game_name, game_bgg_id, "
    "game_year_published, game_min_players, game_max_players, "
    "game_playing_time, game_is_expansion, game_base_game_bgg_id, "
    "game_play_mode, bgg_quantity, bgg_acquired_from, bgg_acquisition_date, "
    "bgg_purchase_price, bgg_purchase_currency, bgg_inventory_location, "
    "bgg_private_comment"
)


def build_collection(sb: Client, user_id: str, _ctx: dict[str, Any]) -> list[CsvFile]:
    """Every shelf row: owned, previously owned and wishlist in one file.

    Reads the denormalized `game_*` columns rather than joining the catalog —
    they are what the shelf itself is drawn from, and a name frozen on the row
    is the name the user shelved, which is the honest thing to export.
    """
    rows = page_all(
        lambda: sb.table("boardgamebuddy_collections")
        .select(_COLLECTION_SELECT)
        .eq("user_id", user_id),
        "game_id", label="collection",
    )
    rows.sort(key=lambda r: ((r.get("game_name") or "").lower(), r.get("game_id") or ""))
    header = [
        "game_name", "status", "bgg_id", "year_published", "is_expansion",
        "base_game_bgg_id", "min_players", "max_players", "playing_time",
        "play_mode", "added_at", "played_before_marked_at", "quantity",
        "acquired_from", "acquisition_date", "purchase_price",
        "purchase_currency", "inventory_location", "private_comment", "game_id",
    ]
    return [CsvFile("collection.csv", header, [[
        r.get("game_name"), r.get("status"), r.get("game_bgg_id"),
        r.get("game_year_published"), r.get("game_is_expansion"),
        r.get("game_base_game_bgg_id"), r.get("game_min_players"),
        r.get("game_max_players"), r.get("game_playing_time"),
        r.get("game_play_mode"), r.get("added_at"), r.get("played_before_at"),
        r.get("bgg_quantity"), r.get("bgg_acquired_from"),
        r.get("bgg_acquisition_date"), r.get("bgg_purchase_price"),
        r.get("bgg_purchase_currency"), r.get("bgg_inventory_location"),
        r.get("bgg_private_comment"), r.get("game_id"),
    ] for r in rows])]


# ── Owned expansions ──────────────────────────────────────────────────────────

def build_expansions(sb: Client, user_id: str, _ctx: dict[str, Any]) -> list[CsvFile]:
    """Expansions the user owns, which live apart from the shelf by design."""
    rows = page_all(
        lambda: sb.table("boardgamebuddy_user_expansions")
        .select("expansion_game_id, boardgamebuddy_games(name, bgg_id, "
                "year_published, base_game_bgg_id)")
        .eq("user_id", user_id),
        "expansion_game_id", label="expansions",
    )
    out = []
    for r in rows:
        game = embedded(r, "boardgamebuddy_games")
        out.append([
            game.get("name"), game.get("bgg_id"), game.get("year_published"),
            game.get("base_game_bgg_id"), r.get("expansion_game_id"),
        ])
    out.sort(key=lambda row: (str(row[0] or "").lower(), str(row[4] or "")))
    header = ["expansion_name", "bgg_id", "year_published",
              "base_game_bgg_id", "expansion_game_id"]
    return [CsvFile("expansions.csv", header, out)]


# ── Buddies ───────────────────────────────────────────────────────────────────

def build_buddies(sb: Client, user_id: str, _ctx: dict[str, Any]) -> list[CsvFile]:
    """Two files, because the app has two unrelated kinds of "buddy".

    `buddies.csv` is the mutual graph — real accounts, with the request still
    pending or already accepted. `ghost_players.csv` is the free-text nicknames
    the user types at the table for people who have no account. Merging them
    would invent a person for every nickname.
    """
    edges = page_all(
        lambda: sb.table("boardgamebuddy_buddy_edges")
        .select("id, user_a, user_b, status, requested_by, accepted_by, "
                "created_at, accepted_at")
        .or_(f"user_a.eq.{user_id},user_b.eq.{user_id}"),
        "id", label="buddy edges",
    )
    others = [
        (e["user_b"] if e.get("user_a") == user_id else e.get("user_a"))
        for e in edges
    ]
    profiles = profile_names(sb, others)

    edge_rows = []
    for e in edges:
        other_id = e["user_b"] if e.get("user_a") == user_id else e.get("user_a")
        p = profiles.get(other_id or "", {})
        edge_rows.append([
            p.get("display_name"), p.get("username"), e.get("status"),
            e.get("requested_by") == user_id, e.get("created_at"),
            e.get("accepted_at"), other_id,
        ])
    edge_rows.sort(key=lambda row: (str(row[0] or "").lower(), str(row[6] or "")))

    ghosts = page_all(
        lambda: sb.table("boardgamebuddy_buddies")
        .select("id, name, created_at")
        .eq("owner_id", user_id),
        "id", label="ghost buddies",
    )
    ghosts.sort(key=lambda r: ((r.get("name") or "").lower(), r.get("id") or ""))

    return [
        CsvFile(
            "buddies.csv",
            ["display_name", "username", "status", "requested_by_you",
             "requested_at", "accepted_at", "user_id"],
            edge_rows,
        ),
        CsvFile(
            "ghost_players.csv",
            ["name", "added_at", "ghost_id"],
            [[g.get("name"), g.get("created_at"), g.get("id")] for g in ghosts],
        ),
    ]


# ── Achievements ──────────────────────────────────────────────────────────────

def build_achievements(sb: Client, user_id: str, _ctx: dict[str, Any]) -> list[CsvFile]:
    """Unlocked badges, with the catalog text joined so the file reads alone.

    An export of `("century-club", "2026-02-11")` is a row nobody can use two
    years from now; the name and the requirement are what make it a record.
    """
    rows = page_all(
        lambda: sb.table("boardgamebuddy_user_achievements")
        .select("achievement_id, unlocked_at, "
                "boardgamebuddy_achievements(name, tagline, requirement, group_id)")
        .eq("user_id", user_id),
        "achievement_id", label="achievements",
    )
    rows.sort(key=lambda r: (str(r.get("unlocked_at") or ""), r.get("achievement_id") or ""))
    out = []
    for r in rows:
        a = embedded(r, "boardgamebuddy_achievements")
        out.append([
            a.get("name"), a.get("group_id"), a.get("tagline"),
            a.get("requirement"), r.get("unlocked_at"), r.get("achievement_id"),
        ])
    header = ["name", "group", "tagline", "requirement", "unlocked_at",
              "achievement_id"]
    return [CsvFile("achievements.csv", header, out)]


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
