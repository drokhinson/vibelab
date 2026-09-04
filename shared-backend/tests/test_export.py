"""Tests for the Settings → Data management export.

Two things are worth pinning here and nothing else really is:

  1. The archive's SHAPE — which files a tick produces, what is in them, and
     that a play logged by somebody else still reaches the user's own export.
     That is the contract a person downloads; getting it wrong is silent.
  2. The pagination, for the same reason it is tested in test_bgg_compare.py:
     PostgREST caps an unbounded select at 1000 rows and a truncated read does
     not fail. An export that stops at row 1000 looks complete.

The fake below is just enough PostgREST to serve those reads. Embedded rows are
pre-baked onto the stored dicts — the joins themselves are PostgREST's job, not
this module's.
"""

import csv
import io
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest

from routes.boardgame_buddy.constants import EXPORT_PAGE_SIZE, ExportDataset
from routes.boardgame_buddy.services import export_service as S
from routes.boardgame_buddy.services.export_csv import CsvFile, _cell, render_csv


ME = "user-me"
THEM = "user-them"


# ── Fakes ────────────────────────────────────────────────────────────────────

class _Q:
    """Just enough of the PostgREST builder for the export's reads."""

    def __init__(self, table, store):
        self.table, self.store = table, store
        self.eqs, self.neqs, self.ors, self.ins = [], [], None, None
        self.lo, self.hi = 0, None
        self.head, self.counting = False, False

    def select(self, *_cols, count=None, head=None):
        self.counting = count is not None
        self.head = bool(head)
        return self

    def eq(self, col, val):
        self.eqs.append((col, val))
        return self

    def neq(self, col, val):
        self.neqs.append((col, val))
        return self

    def or_(self, expr):
        # Only shape the export uses: "col.eq.v,col2.eq.v2".
        self.ors = [tuple(part.split(".", 2)) for part in expr.split(",")]
        return self

    def in_(self, col, values):
        self.ins = (col, list(values))
        return self

    def order(self, *_a, **_k):
        return self

    def range(self, lo, hi):
        self.lo, self.hi = lo, hi
        return self

    @staticmethod
    def _read(row, path):
        """Resolve `col` or `embedded_table.col` against one stored row."""
        if "." not in path:
            return row.get(path)
        table, col = path.split(".", 1)
        embedded = row.get(table) or {}
        return embedded.get(col)

    def execute(self):
        rows = list(self.store.get(self.table, []))
        for col, val in self.eqs:
            rows = [r for r in rows if self._read(r, col) == val]
        for col, val in self.neqs:
            rows = [r for r in rows if self._read(r, col) != val]
        if self.ors:
            rows = [
                r for r in rows
                if any(self._read(r, col) == val for col, _op, val in self.ors)
            ]
        if self.ins:
            col, values = self.ins
            rows = [r for r in rows if self._read(r, col) in values]
        count = len(rows)
        if self.head:
            rows = []
        elif self.hi is not None:
            # PostgREST caps a page server-side; mimic that exactly.
            rows = rows[self.lo:self.hi + 1][:EXPORT_PAGE_SIZE]
        return type("R", (), {"data": rows, "count": count})()


class _SB:
    def __init__(self, store):
        self.store = store

    def table(self, name):
        return _Q(name, self.store)


def _store(**overrides):
    """A small but complete account: two plays, one of them somebody else's."""
    store = {
        "boardgamebuddy_profiles": [
            {"id": ME, "username": "me", "display_name": "Me",
             "created_at": "2026-01-01T00:00:00Z", "bgg_username": "mygeek",
             "is_admin": False, "needs_setup": False, "app_installed_at": None,
             "bgg_last_sync_started_at": None},
            {"id": THEM, "username": "them", "display_name": "Them"},
        ],
        "boardgamebuddy_collections": [
            {"user_id": ME, "game_id": "g1", "status": "owned",
             "game_name": "Wingspan", "game_bgg_id": 266192, "added_at": "2026-02-01"},
        ],
        "boardgamebuddy_user_expansions": [
            {"user_id": ME, "expansion_game_id": "g2",
             "boardgamebuddy_games": {"name": "Wingspan: Europe", "bgg_id": 290448,
                                      "year_published": 2019, "base_game_bgg_id": 266192}},
        ],
        "boardgamebuddy_plays": [
            {"id": "p1", "user_id": ME, "played_at": "2026-03-01",
             "created_at": "2026-03-01T20:00:00Z", "game_id": "g1",
             "game_name": "Wingspan", "play_mode": "competitive",
             "boardgamebuddy_games": {"bgg_id": 266192}},
            {"id": "p2", "user_id": THEM, "played_at": "2026-04-01",
             "created_at": "2026-04-01T20:00:00Z", "game_id": "g1",
             "game_name": "Wingspan", "play_mode": "competitive",
             "boardgamebuddy_games": {"bgg_id": 266192}},
        ],
        # The `boardgamebuddy_plays` key on each seat stands in for the
        # `!inner` embed count_plays filters on — it is how "a seat on a play
        # somebody else logged" is expressible without double-counting.
        "boardgamebuddy_play_players": [
            {"play_id": "p1", "player_user_id": ME, "player_display_name": "Old Name",
             "is_winner": True, "score": 84, "round_scores": None,
             "boardgamebuddy_plays": {"user_id": ME}},
            {"play_id": "p1", "player_user_id": None, "player_display_name": "Ghost Pat",
             "is_winner": False, "score": 71, "round_scores": None,
             "boardgamebuddy_plays": {"user_id": ME}},
            {"play_id": "p2", "player_user_id": ME, "player_display_name": "Me",
             "is_winner": False, "score": 60, "round_scores": None,
             "boardgamebuddy_plays": {"user_id": THEM}},
        ],
        "boardgamebuddy_play_expansions": [
            {"play_id": "p1", "expansion_game_id": "g2",
             "boardgamebuddy_games": {"name": "Wingspan: Europe", "bgg_id": 290448}},
        ],
        "boardgamebuddy_buddy_edges": [
            {"id": "e1", "user_a": ME, "user_b": THEM, "status": "accepted",
             "requested_by": ME, "accepted_by": THEM,
             "created_at": "2026-01-05T00:00:00Z", "accepted_at": "2026-01-06T00:00:00Z"},
        ],
        "boardgamebuddy_buddies": [
            {"id": "b1", "owner_id": ME, "name": "Ghost Pat", "created_at": "2026-01-07"},
        ],
        "boardgamebuddy_user_achievements": [
            {"user_id": ME, "achievement_id": "first-page",
             "unlocked_at": "2026-02-02T00:00:00Z",
             "boardgamebuddy_achievements": {"name": "First Page", "tagline": "You wrote one",
                                             "requirement": "Write a chapter",
                                             "group_id": "guides"}},
        ],
        "boardgamebuddy_user_chapters": [
            {"user_id": ME, "chapter_id": "c1", "created_at": "2026-02-02T00:00:00Z",
             "boardgamebuddy_guide_chapters": {
                 "title": "Setup", "chapter_type": "setup", "content": "Deal 8 cards.",
                 "created_by": ME, "created_at": "2026-02-02T00:00:00Z",
                 "updated_at": "2026-02-02T00:00:00Z", "game_id": "g1"}},
        ],
        "boardgamebuddy_guide_chapters": [
            {"id": "c1", "title": "Setup", "chapter_type": "setup",
             "content": "Deal 8 cards.", "created_by": ME,
             "created_at": "2026-02-02T00:00:00Z",
             "updated_at": "2026-02-02T00:00:00Z", "game_id": "g1"},
        ],
        "boardgamebuddy_games": [
            {"id": "g1", "name": "Wingspan", "bgg_id": 266192},
            {"id": "g2", "name": "Wingspan: Europe", "bgg_id": 290448},
        ],
    }
    store.update(overrides)
    return store


def _export(store, datasets):
    payload, filename = S.build_export(
        _SB(store), ME, datasets, display_name="Me", username="me",
    )
    zf = zipfile.ZipFile(io.BytesIO(payload))
    return zf, filename


def _rows(zf, name):
    """One CSV inside the archive, as a list of dicts."""
    text = zf.read(name).decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(text)))


# ── The archive's shape ──────────────────────────────────────────────────────

def test_every_dataset_builds_and_names_the_files_it_promised():
    """SPECS.files is what the sheet shows before the download. It has to be
    what actually lands, or the manifest is describing a different export."""
    zf, filename = _export(_store(), list(S.SPECS))
    names = set(zf.namelist())
    assert "README.txt" in names
    for spec in S.SPECS.values():
        assert set(spec.files) <= names, spec.label
    assert re.fullmatch(r"boardgamebuddy-me-\d{4}-\d{2}-\d{2}\.zip", filename)


def test_only_ticked_datasets_are_written():
    zf, _ = _export(_store(), [ExportDataset.COLLECTION])
    assert sorted(zf.namelist()) == ["README.txt", "collection.csv"]


def test_a_play_someone_else_logged_is_still_in_your_export():
    """The Plays screen shows plays you were seated in; an export that dropped
    them would be missing half of some accounts' history."""
    zf, _ = _export(_store(), [ExportDataset.PLAYS])
    plays = {r["play_id"]: r for r in _rows(zf, "plays.csv")}
    assert set(plays) == {"p1", "p2"}
    assert plays["p1"]["logged_by_you"] == "true"
    assert plays["p2"]["logged_by_you"] == "false"
    assert plays["p2"]["logged_by"] == "Them"


def test_plays_are_newest_first_and_carry_a_readable_roster():
    zf, _ = _export(_store(), [ExportDataset.PLAYS])
    plays = _rows(zf, "plays.csv")
    assert [p["played_at"] for p in plays] == ["2026-04-01", "2026-03-01"]
    p1 = next(p for p in plays if p["play_id"] == "p1")
    assert p1["player_count"] == "2"
    assert p1["winners"] == "Me"
    assert set(p1["players"].split("; ")) == {"Me", "Ghost Pat"}


def test_a_seat_uses_the_accounts_current_name_not_the_frozen_one():
    """player_display_name is a snapshot from when the seat was filled. A buddy
    who has since renamed must not export under a name nobody recognises."""
    zf, _ = _export(_store(), [ExportDataset.PLAYS])
    seats = _rows(zf, "play_players.csv")
    mine = [s for s in seats if s["player_user_id"] == ME]
    assert {s["player_name"] for s in mine} == {"Me"}
    ghost = next(s for s in seats if not s["player_user_id"])
    assert ghost["player_name"] == "Ghost Pat"
    assert ghost["is_you"] == "false"


def test_buddies_and_ghosts_stay_in_separate_files():
    """Merging them would invent an account for every table nickname."""
    zf, _ = _export(_store(), [ExportDataset.BUDDIES])
    buddies = _rows(zf, "buddies.csv")
    assert [b["display_name"] for b in buddies] == ["Them"]
    assert buddies[0]["requested_by_you"] == "true"
    assert [g["name"] for g in _rows(zf, "ghost_players.csv")] == ["Ghost Pat"]


def test_a_chapter_is_exported_once_whether_written_or_borrowed():
    """The builder unions the user's selections with what they authored, so a
    chapter that is both must not appear twice."""
    zf, _ = _export(_store(), [ExportDataset.GUIDES])
    chapters = _rows(zf, "guide_chapters.csv")
    assert len(chapters) == 1
    assert chapters[0]["written_by_you"] == "true"
    assert chapters[0]["in_your_guide"] == "true"
    assert chapters[0]["game_name"] == "Wingspan"
    assert chapters[0]["content"] == "Deal 8 cards."


def test_the_profile_export_never_carries_bgg_credentials():
    """The row this reads also holds an encrypted password and live session
    cookies. A zip that leaves the app must not contain them."""
    store = _store()
    store["boardgamebuddy_profiles"][0].update({
        "bgg_password_enc": "SHOULD-NEVER-SHIP",
        "bgg_session_id": "SHOULD-NEVER-SHIP",
    })
    zf, _ = _export(store, [ExportDataset.PROFILE])
    blob = zf.read("profile.csv").decode("utf-8-sig")
    assert "SHOULD-NEVER-SHIP" not in blob
    assert "mygeek" in blob


def test_the_readme_counts_the_rows_it_shipped():
    zf, _ = _export(_store(), [ExportDataset.PLAYS, ExportDataset.BUDDIES])
    readme = zf.read("README.txt").decode("utf-8")
    assert "plays.csv (2 rows)" in readme
    assert "ghost_players.csv (1 row)" in readme


def test_an_empty_account_still_produces_every_ticked_file():
    """A header-only CSV says "you have none of these". A missing file says
    the export broke."""
    empty = {k: [] for k in _store()}
    empty["boardgamebuddy_profiles"] = []
    zf, _ = _export(empty, list(S.SPECS))
    for spec in S.SPECS.values():
        for name in spec.files:
            assert _rows(zf, name) == []


# ── Pagination ───────────────────────────────────────────────────────────────

def test_a_collection_larger_than_one_page_is_read_in_full():
    store = _store(boardgamebuddy_collections=[
        {"user_id": ME, "game_id": f"g{i:05d}", "status": "owned",
         "game_name": f"Game {i:05d}", "game_bgg_id": i}
        for i in range(EXPORT_PAGE_SIZE + 200)
    ])
    zf, _ = _export(store, [ExportDataset.COLLECTION])
    assert len(_rows(zf, "collection.csv")) == EXPORT_PAGE_SIZE + 200


def test_paging_stops_on_a_short_page():
    store = _store(boardgamebuddy_collections=[
        {"user_id": ME, "game_id": f"g{i:05d}", "status": "owned",
         "game_name": f"Game {i:05d}", "game_bgg_id": i}
        for i in range(EXPORT_PAGE_SIZE)
    ])
    zf, _ = _export(store, [ExportDataset.COLLECTION])
    assert len(_rows(zf, "collection.csv")) == EXPORT_PAGE_SIZE


# ── The manifest ─────────────────────────────────────────────────────────────

# What the sheet's number counts, per dataset: TOP-LEVEL records, not every
# row the tick writes. A play's seats are children of the play, so "Plays · 2"
# has to mean two plays; buddies and ghost players are siblings, so
# "Buddies · 2" means two people across the two files.
_COUNTED_FILES = {
    ExportDataset.PLAYS: ("plays.csv",),
    ExportDataset.BUDDIES: ("buddies.csv", "ghost_players.csv"),
}


def test_the_manifest_counts_match_what_the_export_writes():
    """The count is the whole point of the sheet — a user ticks Plays because
    it says 2, and gets a file with 2 plays in it."""
    store = _store()
    counts = {d.id: d.row_count for d in S.manifest(_SB(store), ME)}
    zf, _ = _export(store, list(S.SPECS))
    for dataset, spec in S.SPECS.items():
        names = _COUNTED_FILES.get(dataset, spec.files)
        assert counts[dataset] == sum(len(_rows(zf, n)) for n in names), dataset


def test_the_manifest_offers_every_dataset_in_registry_order():
    infos = S.manifest(_SB(_store()), ME)
    assert [i.id for i in infos] == list(S.SPECS)
    assert all(i.label and i.blurb and i.files for i in infos)


# ── CSV formatting ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("value,expected", [
    (None, ""),
    (True, "true"),
    (False, "false"),
    (0, "0"),
    ([1, 2], "[1,2]"),
    ({"r": 1}, '{"r":1}'),
    ("plain", "plain"),
    ("-4", "-4"),          # a negative score is not a formula
])
def test_cells_render_predictably(value, expected):
    assert _cell(value) == expected


@pytest.mark.parametrize("payload", ["=1+1", "+1", "@SUM(A1)"])
def test_a_cell_that_would_run_as_a_formula_is_defused(payload):
    """Display names and chapter bodies are written by other people, and this
    file's likely fate is a double-click into Excel."""
    assert _cell(payload) == "\t" + payload


def test_csv_files_open_cleanly_in_excel():
    """A BOM and CRLF line endings — without the BOM Excel reads UTF-8 as the
    system codepage and every accented game name becomes mojibake."""
    blob = render_csv(CsvFile("x.csv", ["name"], [["Café Ambiance"]]))
    assert blob.startswith(b"\xef\xbb\xbf")
    assert blob.endswith(b"\r\n")
    assert blob.decode("utf-8-sig").splitlines()[1] == "Café Ambiance"


# ── The routes ───────────────────────────────────────────────────────────────
#
# Thin, but they cover the two things unit tests on the service cannot: that
# `?dataset=` repeated is what FastAPI parses into a list, and that the response
# carries the headers a cross-origin browser download depends on. Both are
# invisible failures — a wrong header lands as a file called "download" with no
# extension, which nobody will report as a bug in the export.

@pytest.fixture()
def client(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from routes import boardgame_buddy as bb
    from routes.boardgame_buddy import export_routes
    from routes.boardgame_buddy.dependencies import CurrentUser, get_current_user

    app = FastAPI()
    app.include_router(bb.router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        user_id=ME, display_name="Me", username="me",
    )
    monkeypatch.setattr(export_routes, "get_supabase", lambda: _SB(_store()))
    return TestClient(app)


def test_the_manifest_route_answers_with_every_dataset(client):
    res = client.get("/api/v1/boardgame_buddy/export/manifest")
    assert res.status_code == 200
    assert [d["id"] for d in res.json()["datasets"]] == [d.value for d in S.SPECS]


def test_the_export_route_returns_a_zip_the_browser_can_save(client):
    res = client.get(
        "/api/v1/boardgame_buddy/export",
        params=[("dataset", "plays"), ("dataset", "buddies")],
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    assert 'filename="boardgamebuddy-me-' in res.headers["content-disposition"]
    # Personal data built for this one download, and a filename script can only
    # read on a cross-origin response if the header is explicitly exposed.
    assert res.headers["cache-control"] == "no-store"
    assert res.headers["access-control-expose-headers"] == "Content-Disposition"
    assert set(zipfile.ZipFile(io.BytesIO(res.content)).namelist()) == {
        "README.txt", "plays.csv", "play_players.csv", "play_expansions.csv",
        "buddies.csv", "ghost_players.csv",
    }


def test_a_repeated_dataset_is_not_exported_twice(client):
    res = client.get(
        "/api/v1/boardgame_buddy/export",
        params=[("dataset", "plays"), ("dataset", "plays")],
    )
    assert res.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(res.content)).namelist()
    assert len(names) == len(set(names))


@pytest.mark.parametrize("params", [[], [("dataset", "not-a-dataset")]])
def test_the_export_route_refuses_a_request_that_names_nothing_real(client, params):
    assert client.get("/api/v1/boardgame_buddy/export", params=params).status_code == 422
