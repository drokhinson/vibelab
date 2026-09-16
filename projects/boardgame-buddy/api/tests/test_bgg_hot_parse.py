"""parse_hot_items must read BGG's /hot shape and skip what it cannot trust.

The hot list is the one catalog read that is not keyed by game, so it never
goes through the /thing parsers. Its shape is attributes all the way down —
`<item id rank>` with `<name value/>`, `<yearpublished value/>` and
`<thumbnail value/>` children — and every child is optional on the wire.

Pure Element -> list function, so no Supabase fake and no network.
"""

import os
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

from routes.bgg_client import parse_hot_items  # noqa: E402


def _items(body: str) -> ET.Element:
    return ET.fromstring(f"<items termsofuse='x'>{body}</items>")


def test_reads_every_field_and_orders_by_rank():
    root = _items(
        "<item id='2' rank='2'><thumbnail value='//cf.geekdo-images.com/b.jpg'/>"
        "<name value='Brass'/><yearpublished value='2018'/></item>"
        "<item id='1' rank='1'><thumbnail value='https://cf.geekdo-images.com/a.jpg'/>"
        "<name value='Ark Nova'/><yearpublished value='2021'/></item>"
    )
    got = parse_hot_items(root)
    assert [i["bgg_id"] for i in got] == [1, 2]
    assert got[0] == {
        "bgg_id": 1, "rank": 1, "name": "Ark Nova", "year_published": 2021,
        "thumbnail_url": "https://cf.geekdo-images.com/a.jpg",
    }
    # Protocol-relative thumbnails come back absolute, as everywhere else.
    assert got[1]["thumbnail_url"] == "https://cf.geekdo-images.com/b.jpg"


def test_missing_children_are_none_not_errors():
    root = _items("<item id='7' rank='3'><name value='Mystery'/></item>")
    got = parse_hot_items(root)
    assert got == [{
        "bgg_id": 7, "rank": 3, "name": "Mystery", "year_published": None, "thumbnail_url": None,
    }]


def test_non_numeric_id_or_rank_is_skipped():
    root = _items(
        "<item id='abc' rank='1'><name value='Bad id'/></item>"
        "<item id='9' rank='n/a'><name value='Bad rank'/></item>"
        "<item id='10' rank='4'><name value='Fine'/></item>"
    )
    assert [i["bgg_id"] for i in parse_hot_items(root)] == [10]


def test_nameless_item_gets_a_placeholder_rather_than_an_empty_tile():
    root = _items("<item id='11' rank='5'></item>")
    assert parse_hot_items(root)[0]["name"] == "BGG #11"
