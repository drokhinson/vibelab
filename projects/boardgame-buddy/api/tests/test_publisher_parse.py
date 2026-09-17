"""thing_item_publishers must pick the right names off a /thing item.

Three things on the wire that a naive `findall` gets wrong, each pinned here:
BGG mixes every link type into one flat list, so a designer or an artist is one
`link` element away from a publisher; a widely reissued game carries the same
publisher name twice under two different ids; and the list runs to 30+ entries
for anything popular, which is a paragraph of company names in a UI that shows
one.

The empty case matters as much as the full one. `publishers` is nullable with
no default (migration 040) precisely so NULL can mean "never synced", so a game
BGG credits to nobody must come back as [] — which the backfill writes, and the
row leaves the queue — rather than as None, which would leave it there forever.

A pure Element -> list function, so no Supabase fake and no network.
"""

import os
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

from routes.bgg_client import _PUBLISHER_LIMIT, thing_item_publishers  # noqa: E402


def _item(links: str) -> ET.Element:
    return ET.fromstring(f"<item type='boardgame' id='266192'>{links}</item>")


def _pub(name: str, link_id: int = 0) -> str:
    return f"<link type='boardgamepublisher' id='{link_id}' value='{name}'/>"


def test_reads_publishers_in_bggs_own_order():
    item = _item(_pub("Stonemaier Games", 1) + _pub("Feuerland Spiele", 2))
    assert thing_item_publishers(item) == ["Stonemaier Games", "Feuerland Spiele"]


def test_ignores_every_other_link_type():
    # Designer, artist, category and mechanic links sit in the same flat list.
    item = _item(
        "<link type='boardgamedesigner' id='9' value='Jamey Stegmaier'/>"
        "<link type='boardgameartist' id='8' value='Beth Sobel'/>"
        + _pub("Stonemaier Games", 1)
        + "<link type='boardgamecategory' id='1089' value='Animals'/>"
        "<link type='boardgamemechanic' id='2040' value='Hand Management'/>"
    )
    assert thing_item_publishers(item) == ["Stonemaier Games"]


def test_drops_repeated_names_under_different_ids():
    item = _item(_pub("Z-Man Games", 1) + _pub("Z-Man Games", 2) + _pub("Devir", 3))
    assert thing_item_publishers(item) == ["Z-Man Games", "Devir"]


def test_caps_the_list():
    item = _item("".join(_pub(f"Publisher {i}", i) for i in range(30)))
    got = thing_item_publishers(item)
    assert len(got) == _PUBLISHER_LIMIT
    # The cap keeps the FIRST few, which is where the original publisher sits.
    assert got[0] == "Publisher 0"


def test_no_publisher_links_is_an_empty_list_not_none():
    assert thing_item_publishers(_item("")) == []


def test_blank_values_are_skipped_rather_than_stored():
    item = _item(_pub("", 1) + "<link type='boardgamepublisher' id='2'/>" + _pub("Devir", 3))
    assert thing_item_publishers(item) == ["Devir"]


# ── GameDetail's two absences read as one ────────────────────────────────────
# The column is nullable with no default so the backfill can tell "never
# synced" from "synced, nobody credited". A reader has no use for that
# distinction, and Pydantic would reject the None outright — which would 500
# the game page for every row the backfill has not reached yet.

from routes.models import GameDetail  # noqa: E402


def _row(**over) -> dict:
    row = {
        "id": "11111111-1111-1111-1111-111111111111",
        "name": "Wingspan",
        "created_at": "2026-01-01T00:00:00+00:00",
    }
    row.update(over)
    return row


def test_game_detail_reads_a_null_publishers_column_as_empty():
    assert GameDetail(**_row(publishers=None)).publishers == []


def test_game_detail_reads_a_missing_publishers_key_as_empty():
    # A row cached before migration 040 simply has no key.
    assert GameDetail(**_row()).publishers == []


def test_game_detail_passes_real_publishers_through():
    assert GameDetail(**_row(publishers=["Stonemaier Games"])).publishers == ["Stonemaier Games"]
