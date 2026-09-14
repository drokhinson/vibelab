"""An expansion's scoring grid carries a mode; a base game's never does.

Migration 032 gives a `layout='scoring_grid'` chapter written for an EXPANSION
one extra fact: whether its rows are ADDED to the base game's scorepad or
REPLACE it. The distinction only exists for an expansion — a base game's own
grid has nothing to meet — and the client cannot be trusted to know which side
of that line a game falls on, because only the write path has just SELECTed the
row.

So the resolution lives server-side in services/chapter_grid, and this file
pins the four cases plus the two properties that make it safe to be wrong:

  * a pre-032 grid carries no mode at all and must keep working;
  * a mode on a BASE game's grid is dropped rather than stored, because storing
    'add_on' there would make every base grid read as half a scorepad.

`bgb_chapters_grid_mode` (the SQL CHECK) pins the value domain and cannot see
whether the chapter's game is an expansion, which is exactly the half tested
here.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest

from routes.boardgame_buddy.constants import ScoringGridMode
from routes.boardgame_buddy.models import PlayScoringTemplate, ScoringGrid
from routes.boardgame_buddy.services import chapter_grid


def _grid(mode=None):
    return ScoringGrid(rows=[{"label": "Pearls"}], mode=mode)


# ── resolve_grid_mode ────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "mode, is_expansion, expected",
    [
        # An expansion's grid keeps what its author chose...
        (ScoringGridMode.REPLACE, True, ScoringGridMode.REPLACE),
        (ScoringGridMode.ADD_ON, True, ScoringGridMode.ADD_ON),
        # ...and one that names nothing (a pre-032 row, an older client) is an
        # add-on, which is both the commoner shape and the safe one to be wrong
        # about: extra rows on the table beat missing ones.
        (None, True, ScoringGridMode.ADD_ON),
        # A base game's grid never has a mode, whatever it was sent.
        (None, False, None),
        (ScoringGridMode.ADD_ON, False, None),
        (ScoringGridMode.REPLACE, False, None),
    ],
)
def test_mode_resolves_against_the_game(mode, is_expansion, expected):
    assert chapter_grid.resolve_grid_mode(_grid(mode), is_expansion) is expected


def test_no_grid_has_no_mode():
    """A text chapter reaches the same helper with grid=None."""
    assert chapter_grid.resolve_grid_mode(None, True) is None
    assert chapter_grid.resolve_grid_mode(None, False) is None


# ── apply_grid_mode ──────────────────────────────────────────────────────────

def test_stored_document_always_carries_the_key():
    """`mode` is written EXPLICITLY, including as null on a base game's grid.

    Absent and null both read as "no mode" everywhere, so this is not a
    correctness requirement on its own — it is what makes an UPDATE that clears
    a mode actually clear it. A dict that simply omitted the key would leave a
    replace-mode grid replacing after its chapter moved to a base game.
    """
    base = chapter_grid.apply_grid_mode(_grid(ScoringGridMode.REPLACE), False)
    assert "mode" in base and base["mode"] is None
    assert base["rows"][0]["label"] == "Pearls"

    exp = chapter_grid.apply_grid_mode(_grid(ScoringGridMode.REPLACE), True)
    assert exp["mode"] == "replace"


def test_stored_mode_is_a_plain_string():
    """The value goes into JSONB, so it must serialize as the CHECK's literal.

    A StrEnum member survives json.dumps as its value, but supabase-py hands
    the dict to its own encoder — pinning the type here is cheaper than
    discovering it as a 400 from Postgres.
    """
    doc = chapter_grid.apply_grid_mode(_grid(ScoringGridMode.ADD_ON), True)
    assert type(doc["mode"]) is str
    assert doc["mode"] in ("add_on", "replace")


# ── the play snapshot ────────────────────────────────────────────────────────

def test_snapshot_drops_the_inherited_mode():
    """A COMPOSED template has no single mode — its parts do.

    PlayScoringTemplate inherits `mode` from ScoringGrid so a client posting a
    chapter's document straight through is not rejected, but it must not reach
    the stored snapshot as a null that looks like an answer.
    """
    snap = PlayScoringTemplate(
        chapter_id="c1",
        title="Everdell score sheet + Pearlbrook",
        rows=[{"label": "Cards"}, {"label": "Pearls"}],
        mode=ScoringGridMode.ADD_ON,
        parts=[
            {"chapter_id": "c1", "game_id": "g1", "row_count": 1},
            {
                "chapter_id": "c2",
                "game_id": "g2",
                "game_name": "Pearlbrook",
                "mode": ScoringGridMode.ADD_ON,
                "row_count": 1,
            },
        ],
    ).model_dump(mode="json")
    assert "mode" not in snap
    assert [p["mode"] for p in snap["parts"]] == [None, "add_on"]
    assert sum(p["row_count"] for p in snap["parts"]) == len(snap["rows"])


def test_uncomposed_snapshot_is_unchanged_by_032():
    """One grid, no parts — byte-identical to what shipped before the modes.

    Every reader of a pre-032 snapshot keeps reading it, and a play scored on a
    single grid does not grow a one-element seam list.
    """
    snap = PlayScoringTemplate(
        chapter_id="c1", title="Everdell score sheet", rows=[{"label": "Cards"}]
    ).model_dump(mode="json")
    assert snap == {
        "v": 1,
        "chapter_id": "c1",
        "title": "Everdell score sheet",
        "rows": [{"label": "Cards", "color": "neutral", "note": None}],
        "parts": None,
    }
