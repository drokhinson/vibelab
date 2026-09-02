"""bgg_description_text must produce plain text, and unescape exactly once.

BGG double-encodes its <description> text node: the wire carries `&amp;#10;`
and `&amp;quot;`, ElementTree decodes one layer during parse, and the helper
decodes the second. Getting that count wrong is a real bug in both directions
— one pass too few leaves `&#10;` visible in the UI, one pass too many turns a
description that literally reads "&lt;script&gt;" into a live tag.

The helper is a pure Element -> str|None function, so this suite needs no
Supabase fake and no network.
"""

import os
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

from routes.boardgame_buddy.bgg_client import (  # noqa: E402
    _DESCRIPTION_MAX_CHARS,
    bgg_description_text,
)


def _item(description: str) -> ET.Element:
    """Build a /thing <item> the way BGG puts it on the wire."""
    return ET.fromstring(f"<item id='13'><description>{description}</description></item>")


def test_paragraph_breaks_survive():
    # BGG's paragraph break is a doubled &#10;, double-encoded on the wire.
    assert bgg_description_text(_item("Trade.&amp;#10;&amp;#10;Build roads.")) == "Trade.\n\nBuild roads."


def test_entities_decode_exactly_once():
    got = bgg_description_text(_item("The &amp;quot;Settlers&amp;quot; of Catan &amp;amp; friends"))
    assert got == 'The "Settlers" of Catan & friends'


def test_runs_of_newlines_collapse_to_one_break():
    assert bgg_description_text(_item("A&amp;#10;&amp;#10;&amp;#10;&amp;#10;B")) == "A\n\nB"


def test_br_becomes_a_newline():
    assert bgg_description_text(_item("Line one&amp;lt;br/&amp;gt;Line two")) == "Line one\nLine two"


def test_inline_tags_are_stripped_not_rendered():
    assert bgg_description_text(_item("An &amp;lt;i&amp;gt;epic&amp;lt;/i&amp;gt; game")) == "An epic game"


def test_markup_cannot_survive_into_the_column():
    # The frontend renders this column through innerHTML template literals, so
    # a stored tag is one missed escape away from executing. Strip at the door.
    got = bgg_description_text(_item("&amp;lt;img src=x onerror=alert(1)&amp;gt;Real text"))
    assert "<" not in got and "onerror" not in got
    assert got == "Real text"


def test_missing_element_is_none():
    assert bgg_description_text(ET.fromstring("<item id='13'/>")) is None


def test_empty_element_is_none():
    assert bgg_description_text(_item("")) is None


def test_whitespace_only_is_none_not_empty_string():
    # The admin backfill filters on `description IS NULL`. Storing "" here
    # would make those games invisible to the panel forever.
    assert bgg_description_text(_item("   &amp;#10;  &amp;#10; ")) is None


def test_long_description_is_capped_on_a_word_boundary():
    got = bgg_description_text(_item("word " * 2000))
    assert len(got) <= _DESCRIPTION_MAX_CHARS + 1  # +1 for the ellipsis
    assert got.endswith("…")
    assert not got.endswith("wor…")  # cut at a space, not mid-word


def test_short_description_is_not_ellipsised():
    assert bgg_description_text(_item("A short blurb.")) == "A short blurb."
