"""The data export: what a user can tick, and the zip those ticks produce.

This module is the registry — one `_Spec` per checkbox on the Settings sheet,
tying the wire value to its label, its row count and the builder that turns it
into CSVs. `services/export_reads.py` and `services/export_plays.py` own the
reads; `services/export_csv.py` owns the formatting.

Everything here is synchronous. The route calls it once inside
`asyncio.to_thread` — the Supabase client blocks, and an export is dozens of
round trips, so running it on the event loop would stall every request in the
service (all ten apps) for the length of the download.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Sequence

from supabase import Client

from ..constants import ExportDataset
from ..models import ExportDatasetInfo
from . import export_reads
from .export_csv import CsvFile, build_zip
from .export_plays import build_play_details, build_plays, count_plays


def _count(sb: Client, table: str, column: str, value: str) -> int:
    """A `head=True` count — the row total with none of the rows."""
    res = (
        sb.table(table).select(column, count="exact", head=True).eq(column, value).execute()
    )
    return int(res.count or 0)


def _count_collection(sb: Client, user_id: str) -> int:
    """Shelf rows plus owned expansions — both live in `collection.csv`.

    Summed rather than reported for the shelf alone because the tick covers
    both: an account with forty games and eleven expansions must not read
    "Collection · 40" and then hand over a file with fifty-one rows in it.
    """
    return (
        _count(sb, "boardgamebuddy_collections", "user_id", user_id)
        + _count(sb, "boardgamebuddy_user_expansions", "user_id", user_id)
    )


def _count_guides(sb: Client, user_id: str) -> int:
    """Chapters in the user's guide, plus any they wrote and later dropped.

    The third count is the overlap — chapters they wrote that ARE still in
    their guide — subtracted so the number matches the unioned file rather than
    counting an authored-and-kept chapter twice.
    """
    selected = _count(sb, "boardgamebuddy_user_chapters", "user_id", user_id)
    authored = _count(sb, "boardgamebuddy_guide_chapters", "created_by", user_id)
    both = (
        sb.table("boardgamebuddy_user_chapters")
        .select("chapter_id, boardgamebuddy_guide_chapters!inner(created_by)",
                count="exact", head=True)
        .eq("user_id", user_id)
        .eq("boardgamebuddy_guide_chapters.created_by", user_id)
        .execute()
    ).count or 0
    return selected + authored - int(both)


@dataclass(frozen=True)
class _Spec:
    """One checkbox on the export sheet.

    `build` takes the shared build context as its third argument. Most datasets
    ignore it; the two play datasets read the same plays, seats and expansions
    two different ways and use it to load them once (see export_plays._bundle).
    """

    label: str
    blurb: str
    files: tuple[str, ...]
    count: Callable[[Client, str], int]
    build: Callable[[Client, str, dict[str, Any]], list[CsvFile]]


# Order is the order the sheet lists them and the order they are built, so the
# two read the same way: what is on the shelf, then what was played with it in
# both of its forms, then the writing around that.
SPECS: dict[ExportDataset, _Spec] = {
    ExportDataset.COLLECTION: _Spec(
        label="Collection",
        blurb="Every shelf row — owned, previously owned and wishlist — plus "
              "the expansions you own, with the BGG purchase details where you "
              "have them.",
        files=("collection.csv",),
        count=_count_collection,
        build=export_reads.build_collection,
    ),
    ExportDataset.PLAYS: _Spec(
        label="Plays",
        blurb="One row per play — date, game, and who scored what, as a single "
              "readable line. Plays you logged and plays you were seated in.",
        files=("plays.csv",),
        count=count_plays,
        build=build_plays,
    ),
    ExportDataset.PLAYS_DETAIL: _Spec(
        label="Plays - detailed",
        blurb="The same plays split out one row per player and per expansion "
              "used, for pivoting. Joins back to plays.csv on play_id.",
        files=("play_players.csv", "play_expansions.csv"),
        count=count_plays,
        build=build_play_details,
    ),
    ExportDataset.GUIDES: _Spec(
        label="Reference guides",
        blurb="Rules chapters you wrote or added to a game's guide, full text "
              "included.",
        files=("guide_chapters.csv",),
        count=_count_guides,
        build=export_reads.build_guides,
    ),
}


def manifest(sb: Client, user_id: str) -> list[ExportDatasetInfo]:
    """Every dataset with its live row count, for the export sheet."""
    return [
        ExportDatasetInfo(
            id=dataset,
            label=spec.label,
            blurb=spec.blurb,
            row_count=spec.count(sb, user_id),
            files=list(spec.files),
        )
        for dataset, spec in SPECS.items()
    ]


_README = """BoardgameBuddy — your data export
=================================

Exported {generated}
Account: {display_name} (@{username})

This archive contains:

{contents}

Notes
-----
* Every file is UTF-8 CSV with a byte-order mark, so a double-click opens it in
  Excel with accented game names intact. Fields are comma-separated and quoted
  per RFC 4180.
* collection.csv is one file holding two kinds of row, told apart by its first
  column: `row_type = shelf` is a game on your shelf — owned, previously owned
  or wishlist, per the `status` column — and `row_type = expansion` is an
  expansion you own. An expansion has no shelf status, so `status` is blank on
  those rows and the purchase columns are empty.
* plays.csv holds both the plays you logged and the plays somebody else logged
  you into — the same history the Plays screen shows. `logged_by_you` tells the
  two apart.
* plays.csv is one row per play, and three of its columns pack a list into a
  single cell, separated by a vertical bar:

      roster       Alice:84|Bob:71    a name, then ":" and the score
      winners      Alice|Bob
      expansions   Wingspan: Europe

  A player with no score (a co-op, a plain win/lose game) appears as the bare
  name. A person's name containing a bar or a colon has it replaced with a
  space in `roster` and `winners`, so the pairs stay readable; `expansions`
  keeps its colons, since half the catalog is named "<Base game>: <Something>"
  and nothing there is a pair. That flattening is confined to these three
  columns.
* play_players.csv, if you exported it, is the lossless form of the same thing:
  one row per seat, names verbatim, plus the per-round scores, joined back to
  plays.csv on `play_id`. play_expansions.csv is one row per expansion used.
  Both carry the play's date and game name so they read on their own.
* A JSON value in a cell (a seat's round_scores) is JSON, not a bar-separated
  list — it has structure a flat list cannot carry.
* A handful of cells begin with a tab character. That is deliberate: a value
  starting with =, + or @ is treated as a formula by spreadsheet apps, and the
  tab makes them read it as the text it is.
* Nothing off your account row is in this export — not your linked
  BoardGameGeek username, and emphatically not the encrypted BGG password and
  session cookies stored beside it. The account line at the top of this file is
  the whole of it.

This file was generated by BoardgameBuddy. Nothing here is sent anywhere — the
archive was built for this download and not stored.
"""


def _readme(
    datasets: Sequence[ExportDataset],
    files: Sequence[CsvFile],
    *,
    display_name: str,
    username: str,
    generated_at: datetime,
) -> str:
    counts = {f.name: len(f.rows) for f in files}
    lines = []
    for dataset in datasets:
        spec = SPECS[dataset]
        lines.append(f"  {spec.label}")
        for name in spec.files:
            n = counts.get(name, 0)
            lines.append(f"    - {name} ({n} row{'' if n == 1 else 's'})")
    return _README.format(
        generated=generated_at.strftime("%Y-%m-%d %H:%M UTC"),
        display_name=display_name,
        username=username,
        contents="\n".join(lines),
    )


def build_export(
    sb: Client,
    user_id: str,
    datasets: Sequence[ExportDataset],
    *,
    display_name: str,
    username: str,
) -> tuple[bytes, str]:
    """Build the archive for one set of ticks. Returns (zip bytes, filename).

    Datasets are built in SPECS order rather than in the order the caller sent
    them, so two exports of the same ticks produce the same archive whatever
    order the checkboxes happened to be read in.
    """
    generated_at = datetime.now(timezone.utc)
    ordered = [d for d in SPECS if d in set(datasets)]

    # One dict threaded through every builder, so datasets reading the same
    # rows (Plays and Play details) load them once rather than once each.
    ctx: dict[str, Any] = {}
    files: list[CsvFile] = []
    for dataset in ordered:
        files.extend(SPECS[dataset].build(sb, user_id, ctx))

    readme = _readme(
        ordered, files,
        display_name=display_name, username=username, generated_at=generated_at,
    )
    filename = f"boardgamebuddy-{username}-{generated_at.strftime('%Y-%m-%d')}.zip"
    return build_zip(files, readme, generated_at), filename
