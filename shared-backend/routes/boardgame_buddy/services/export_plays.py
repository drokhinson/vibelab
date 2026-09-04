"""The plays half of the data export — three CSVs, one relational shape.

Split out of services/export_reads.py because it is the only dataset that is
not a single table read: a user's play history is the plays they logged UNION
the plays somebody else logged them into, which is exactly what GET /plays
returns and therefore what "my plays" means to the person ticking the box.

Three files rather than one wide one. A play has a roster, and the roster is
where the scores and the winner live — flattening that into one row per play
means either one column per seat (which breaks at the next six-player game) or
losing the seats. plays.csv still carries a readable `players` / `winners`
summary so it is useful on its own.
"""

from __future__ import annotations

from typing import Any

from supabase import Client

from .export_csv import CsvFile
from .export_reads import chunks, embedded, page_all, profile_names


_PLAY_SELECT = (
    "id, user_id, played_at, created_at, game_id, game_name, play_mode, "
    "notes, photo_url, country_code, bgg_play_id, import_batch_id, "
    "import_group_id, imported_at, boardgamebuddy_games(bgg_id)"
)


def _play_ids_seated_in(sb: Client, user_id: str) -> list[str]:
    """Every play the user holds a seat on, whoever logged it."""
    rows = page_all(
        lambda: sb.table("boardgamebuddy_play_players")
        .select("play_id")
        .eq("player_user_id", user_id),
        "play_id", label="seated plays",
    )
    return [r["play_id"] for r in rows if r.get("play_id")]


def _load_plays(sb: Client, user_id: str) -> list[dict[str, Any]]:
    """The union: plays this user logged, plus plays they were seated in.

    Own plays come first as one paged read; the seats contribute only the ids
    the first read did not already cover, fetched in `.in_()` chunks. Doing it
    the other way round — one `or` filter across a join — is not expressible in
    PostgREST without an RPC.
    """
    own = page_all(
        lambda: sb.table("boardgamebuddy_plays")
        .select(_PLAY_SELECT)
        .eq("user_id", user_id),
        "id", label="own plays",
    )
    have = {p["id"] for p in own}
    missing = [pid for pid in _play_ids_seated_in(sb, user_id) if pid not in have]

    others: list[dict[str, Any]] = []
    for chunk in chunks(missing):
        others.extend(
            (
                sb.table("boardgamebuddy_plays")
                .select(_PLAY_SELECT)
                .in_("id", chunk)
                .execute()
            ).data or []
        )

    plays = own + others
    # Newest first, matching the Plays screen. `played_at` is a date and ties
    # are ordinary (a whole games night lands on one date), so created_at and
    # then the id break them — without both, two exports of an unchanged
    # account can order the same day's plays differently.
    plays.sort(
        key=lambda p: (str(p.get("played_at") or ""), str(p.get("created_at") or ""), p["id"]),
        reverse=True,
    )
    return plays


def _load_players(sb: Client, play_ids: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for chunk in chunks(play_ids):
        rows.extend(
            (
                sb.table("boardgamebuddy_play_players")
                .select("play_id, player_user_id, player_display_name, "
                        "is_winner, score, round_scores, linked_at")
                .in_("play_id", chunk)
                .execute()
            ).data or []
        )
    return rows


def _load_play_expansions(sb: Client, play_ids: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for chunk in chunks(play_ids):
        rows.extend(
            (
                sb.table("boardgamebuddy_play_expansions")
                .select("play_id, expansion_game_id, boardgamebuddy_games(name, bgg_id)")
                .in_("play_id", chunk)
                .execute()
            ).data or []
        )
    return rows


def _seat_name(row: dict[str, Any], profiles: dict[str, dict[str, Any]]) -> str:
    """What to call one seat.

    A seat is either a real account or a typed nickname, and the account's
    CURRENT display name is the right answer for the first — `player_display_name`
    on those rows is a snapshot from whenever the seat was filled, so a buddy
    who has since renamed would export under a name the user no longer
    recognises.
    """
    uid = row.get("player_user_id")
    if uid:
        profile = profiles.get(uid, {})
        return profile.get("display_name") or row.get("player_display_name") or ""
    return row.get("player_display_name") or ""


def build_plays(sb: Client, user_id: str) -> list[CsvFile]:
    """plays.csv + play_players.csv + play_expansions.csv."""
    plays = _load_plays(sb, user_id)
    play_ids = [p["id"] for p in plays]
    players = _load_players(sb, play_ids)
    expansions = _load_play_expansions(sb, play_ids)

    profiles = profile_names(
        sb,
        [r.get("player_user_id") for r in players] + [p.get("user_id") for p in plays],
    )

    seats: dict[str, list[dict[str, Any]]] = {}
    for row in players:
        seats.setdefault(row["play_id"], []).append(row)

    play_rows = []
    for p in plays:
        roster = seats.get(p["id"], [])
        names = [_seat_name(r, profiles) for r in roster]
        winners = [_seat_name(r, profiles) for r in roster if r.get("is_winner")]
        logged_by = profiles.get(p.get("user_id") or "", {})
        play_rows.append([
            p.get("played_at"), p.get("game_name"),
            embedded(p, "boardgamebuddy_games").get("bgg_id"),
            p.get("play_mode"), len(roster),
            # Semicolon-joined rather than comma: these land in a CSV cell, and
            # a comma inside one is a quoting problem for every hand-rolled
            # reader that ever opens this file.
            "; ".join(n for n in names if n),
            "; ".join(n for n in winners if n),
            p.get("notes"), p.get("country_code"), p.get("photo_url"),
            p.get("user_id") == user_id,
            logged_by.get("display_name"), p.get("created_at"),
            p.get("bgg_play_id"), p.get("imported_at"), p.get("import_batch_id"),
            p.get("import_group_id"), p["id"],
        ])

    play_dates = {p["id"]: (p.get("played_at"), p.get("game_name")) for p in plays}
    # Seats follow their play's order, so scrolling play_players.csv reads in
    # the same sequence as plays.csv rather than in whatever order the chunked
    # reads came back.
    order = {pid: i for i, pid in enumerate(play_ids)}
    players.sort(key=lambda r: (order.get(r["play_id"], 0), _seat_name(r, profiles).lower()))
    player_rows = []
    for r in players:
        played_at, game_name = play_dates.get(r["play_id"], (None, None))
        player_rows.append([
            played_at, game_name, _seat_name(r, profiles),
            r.get("player_user_id") == user_id, r.get("is_winner"), r.get("score"),
            r.get("round_scores"), r.get("player_user_id"), r["play_id"],
        ])

    expansions.sort(key=lambda r: (order.get(r["play_id"], 0),
                                   str(embedded(r, "boardgamebuddy_games").get("name") or "")))
    expansion_rows = []
    for r in expansions:
        played_at, game_name = play_dates.get(r["play_id"], (None, None))
        game = embedded(r, "boardgamebuddy_games")
        expansion_rows.append([
            played_at, game_name, game.get("name"), game.get("bgg_id"),
            r.get("expansion_game_id"), r["play_id"],
        ])

    return [
        CsvFile(
            "plays.csv",
            ["played_at", "game_name", "game_bgg_id", "play_mode", "player_count",
             "players", "winners", "notes", "country_code", "photo_url",
             "logged_by_you", "logged_by", "logged_at", "bgg_play_id",
             "imported_at", "import_batch_id", "import_group_id", "play_id"],
            play_rows,
        ),
        CsvFile(
            "play_players.csv",
            ["played_at", "game_name", "player_name", "is_you", "is_winner",
             "score", "round_scores", "player_user_id", "play_id"],
            player_rows,
        ),
        CsvFile(
            "play_expansions.csv",
            ["played_at", "game_name", "expansion_name", "expansion_bgg_id",
             "expansion_game_id", "play_id"],
            expansion_rows,
        ),
    ]


def count_plays(sb: Client, user_id: str) -> int:
    """How many plays the export would write, without reading any of them.

    Two head counts, and they cannot double-count: the second is filtered to
    plays somebody ELSE logged (`boardgamebuddy_plays!inner` pushes the filter
    onto the parent row), and a person holds at most one seat per play.
    """
    own = (
        sb.table("boardgamebuddy_plays")
        .select("id", count="exact", head=True)
        .eq("user_id", user_id)
        .execute()
    ).count or 0
    seated_elsewhere = (
        sb.table("boardgamebuddy_play_players")
        .select("play_id, boardgamebuddy_plays!inner(user_id)", count="exact", head=True)
        .eq("player_user_id", user_id)
        .neq("boardgamebuddy_plays.user_id", user_id)
        .execute()
    ).count or 0
    return int(own) + int(seated_elsewhere)
