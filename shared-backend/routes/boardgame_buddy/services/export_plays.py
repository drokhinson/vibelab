"""The plays half of the data export — two datasets over one set of reads.

Split out of services/export_reads.py because it is the only part of the export
that is not a single table read. A user's play history is the plays they logged
UNION the plays somebody else logged them into, which is what GET /plays
returns and therefore what "my plays" means to the person ticking the box.

TWO TICKS, NOT ONE, and the split is the point:

  Plays        one row per play, with the roster folded into it as a
               `|`-delimited `name:score` column plus a `winners` column. This
               is the file somebody opens, sorts by date and reads. It is
               complete on its own — expansions ride along as a column too —
               and it has the same shape for a two-player game and a
               seven-player one.

  Play details the same plays broken back out, one row per seat and one per
               expansion used, joined on `play_id`. This is the file somebody
               pivots: per-player win rates, score distributions, which
               expansion was on the table.

A single file cannot be both. One column per seat breaks at the next
six-player game, and a file that is only seats has no play to read. So the
summary is lossy on purpose and says where the lossless form is, and the
structured form is a separate tick that pairs with it.

Both datasets read the same plays, seats and expansions, so the load happens
once per export and is cached on the build context — see `_bundle`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from supabase import Client

from .export_csv import CsvFile
from .export_reads import chunks, embedded, page_all, profile_names


_PLAY_SELECT = (
    "id, user_id, played_at, created_at, game_id, game_name, play_mode, "
    "notes, photo_url, country_code, bgg_play_id, import_batch_id, "
    "import_group_id, imported_at, boardgamebuddy_games(bgg_id)"
)

# The roster column's two delimiters. `|` separates seats, `:` separates a name
# from its score — both chosen over a comma because the whole thing lives
# inside one CSV cell, and a comma there is a quoting problem for every
# hand-rolled reader that ever opens this file.
SEAT_SEP = "|"
SCORE_SEP = ":"


# ── Reads ─────────────────────────────────────────────────────────────────────

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


# ── The shared load ───────────────────────────────────────────────────────────

@dataclass
class _Bundle:
    """Everything both play datasets read, loaded once."""

    plays: list[dict[str, Any]] = field(default_factory=list)
    play_ids: list[str] = field(default_factory=list)
    players: list[dict[str, Any]] = field(default_factory=list)
    expansions: list[dict[str, Any]] = field(default_factory=list)
    profiles: dict[str, dict[str, Any]] = field(default_factory=dict)
    # play_id -> its seats / its expansions, both already in export order.
    seats: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    used: dict[str, list[dict[str, Any]]] = field(default_factory=dict)


def _bundle(sb: Client, user_id: str, ctx: dict[str, Any]) -> _Bundle:
    """Load the plays, their seats and their expansions once per export.

    Ticking both Plays and Play details is the sheet's default, and they are
    the same rows read two ways — so without this the common export pays for
    the whole history twice, which on a heavy account is dozens of round trips
    for nothing.
    """
    cached = ctx.get("plays_bundle")
    if cached is not None:
        return cached

    plays = _load_plays(sb, user_id)
    play_ids = [p["id"] for p in plays]
    players = _load_players(sb, play_ids)
    expansions = _load_play_expansions(sb, play_ids)
    profiles = profile_names(
        sb,
        [r.get("player_user_id") for r in players] + [p.get("user_id") for p in plays],
    )

    # Children follow their play's order, so both detail files read in the same
    # sequence as plays.csv rather than in whatever order the chunked reads came
    # back — and two exports of an unchanged account agree.
    order = {pid: i for i, pid in enumerate(play_ids)}
    players.sort(key=lambda r: (order.get(r["play_id"], 0), _seat_name(r, profiles).lower()))
    expansions.sort(key=lambda r: (order.get(r["play_id"], 0),
                                   str(embedded(r, "boardgamebuddy_games").get("name") or "")))

    seats: dict[str, list[dict[str, Any]]] = {}
    for row in players:
        seats.setdefault(row["play_id"], []).append(row)
    used: dict[str, list[dict[str, Any]]] = {}
    for row in expansions:
        used.setdefault(row["play_id"], []).append(row)

    bundle = _Bundle(plays, play_ids, players, expansions, profiles, seats, used)
    ctx["plays_bundle"] = bundle
    return bundle


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


def _list_item(value: str) -> str:
    """One item of a `|`-delimited cell, with the separator flattened out.

    Free text can contain the separator, which would make the cell unparseable
    — so it is flattened to a space HERE, in the summary, and nowhere else. The
    Play details files carry every one of these values verbatim in a column of
    its own and are the authoritative form. That is the trade a delimited
    summary column buys, and the README says so out loud.
    """
    return " ".join(value.replace(SEAT_SEP, " ").split())


def _person(name: str) -> str:
    """A person's name inside `roster` or `winners`.

    Flattens the score separator too, which `_list_item` deliberately does not:
    `roster` pairs a name with a score across a colon, so a name containing one
    would split into a bogus pair. The expansions column has no such pairing
    and must NOT lose its colons — half the expansions in the catalog are named
    "<Base game>: <Something>".
    """
    return _list_item(name.replace(SCORE_SEP, " "))


def _roster_cell(roster: list[dict[str, Any]], profiles: dict[str, dict[str, Any]]) -> str:
    """`Alice:84|Bob:71`, or bare names on a play that kept no scores.

    A co-op or a win/lose game has no scores at all, and `Alice:|Bob:` there is
    punctuation pretending to be data — so the score half is written only where
    there is one.
    """
    out = []
    for seat in roster:
        name = _person(_seat_name(seat, profiles))
        if not name:
            continue
        score = seat.get("score")
        out.append(f"{name}{SCORE_SEP}{score}" if score is not None else name)
    return SEAT_SEP.join(out)


# ── Plays: one readable row per play ──────────────────────────────────────────

def build_plays(sb: Client, user_id: str, ctx: dict[str, Any]) -> list[CsvFile]:
    """plays.csv — the whole history as one row per play.

    Complete on its own: the roster, the winners and the expansions used all
    fold into `|`-delimited cells rather than into more columns or more files.
    Per-seat round scores are the one thing that does not fit; they are in
    play_players.csv under the Play details tick.
    """
    b = _bundle(sb, user_id, ctx)

    rows = []
    for p in b.plays:
        roster = b.seats.get(p["id"], [])
        winners = [
            _person(_seat_name(r, b.profiles))
            for r in roster if r.get("is_winner")
        ]
        expansions = [
            _list_item(str(embedded(r, "boardgamebuddy_games").get("name") or ""))
            for r in b.used.get(p["id"], [])
        ]
        logged_by = b.profiles.get(p.get("user_id") or "", {})
        rows.append([
            p.get("played_at"), p.get("game_name"),
            embedded(p, "boardgamebuddy_games").get("bgg_id"),
            p.get("play_mode"), len(roster),
            _roster_cell(roster, b.profiles),
            SEAT_SEP.join(n for n in winners if n),
            SEAT_SEP.join(n for n in expansions if n),
            p.get("notes"), p.get("country_code"), p.get("photo_url"),
            p.get("user_id") == user_id,
            logged_by.get("display_name"), p.get("created_at"),
            p.get("bgg_play_id"), p.get("imported_at"), p.get("import_batch_id"),
            p.get("import_group_id"), p["id"],
        ])

    return [CsvFile(
        "plays.csv",
        ["played_at", "game_name", "game_bgg_id", "play_mode", "player_count",
         "roster", "winners", "expansions", "notes", "country_code", "photo_url",
         "logged_by_you", "logged_by", "logged_at", "bgg_play_id", "imported_at",
         "import_batch_id", "import_group_id", "play_id"],
        rows,
    )]


# ── Play details: the same plays, broken back out ─────────────────────────────

def build_play_details(sb: Client, user_id: str, ctx: dict[str, Any]) -> list[CsvFile]:
    """play_players.csv + play_expansions.csv.

    Deliberately does NOT re-emit plays.csv: that name belongs to the summary
    above, and two ticks writing one filename with different columns is a
    collision waiting for whoever ticks both. Every row here carries the play's
    date and game name beside the `play_id` join key, so both files stay
    readable even when Plays was left unticked.
    """
    b = _bundle(sb, user_id, ctx)
    play_meta = {p["id"]: (p.get("played_at"), p.get("game_name")) for p in b.plays}

    player_rows = []
    for r in b.players:
        played_at, game_name = play_meta.get(r["play_id"], (None, None))
        player_rows.append([
            played_at, game_name, _seat_name(r, b.profiles),
            r.get("player_user_id") == user_id, r.get("is_winner"), r.get("score"),
            r.get("round_scores"), r.get("player_user_id"), r["play_id"],
        ])

    expansion_rows = []
    for r in b.expansions:
        played_at, game_name = play_meta.get(r["play_id"], (None, None))
        game = embedded(r, "boardgamebuddy_games")
        expansion_rows.append([
            played_at, game_name, game.get("name"), game.get("bgg_id"),
            r.get("expansion_game_id"), r["play_id"],
        ])

    return [
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


# ── Counts ────────────────────────────────────────────────────────────────────

def count_plays(sb: Client, user_id: str) -> int:
    """How many plays the export would write, without reading any of them.

    Two head counts, and they cannot double-count: the second is filtered to
    plays somebody ELSE logged (`boardgamebuddy_plays!inner` pushes the filter
    onto the parent row), and a person holds at most one seat per play.

    This is also the number reported for Play details, which is why it says
    PLAYS rather than rows: the sheet's count exists to tell somebody how much
    of their history a tick covers, and "1,847 seats" is not a quantity anybody
    has an intuition for.
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
