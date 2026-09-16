"""thing_item_stats must pick the right numbers off a stats=1 /thing item.

Three traps on the wire, each pinned here: the rating we store is the Bayesian
"geek rating" (<bayesaverage>), not the raw <average> that a ten-vote game
tops; "the" rank is the <rank name="boardgame"> row, never a family rank; and
BGG spells an unranked game as the string "Not Ranked", not as a blank.

Pure Element -> dict functions, so no Supabase fake and no network.
"""

import os
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

from routes.bgg_client import parse_thing_stats, thing_item_stats  # noqa: E402


def _item(bgg_id: int, *, ranks: str, bayes="7.85123", average="8.2", weight="2.4471", owned="12345") -> str:
    return (
        f"<item type='boardgame' id='{bgg_id}'>"
        f"<statistics page='1'><ratings>"
        f"<usersrated value='40000'/><average value='{average}'/>"
        f"<bayesaverage value='{bayes}'/>"
        f"<ranks>{ranks}</ranks>"
        f"<owned value='{owned}'/><averageweight value='{weight}'/>"
        f"</ratings></statistics></item>"
    )


_RANKS = (
    "<rank type='subtype' id='1' name='boardgame' friendlyname='Board Game Rank' value='42' bayesaverage='7.85'/>"
    "<rank type='family' id='5497' name='strategygames' friendlyname='Strategy Game Rank' value='9' bayesaverage='7.9'/>"
)


def test_reads_geek_rating_boardgame_rank_weight_and_owned():
    got = thing_item_stats(ET.fromstring(_item(1, ranks=_RANKS)))
    assert got == {
        "bgg_rating": 7.85,      # bayesaverage, rounded — NOT the 8.2 average
        "bgg_rank": 42,          # the boardgame subtype row, NOT the family's 9
        "bgg_weight": 2.45,
        "bgg_owned_count": 12345,
    }


def test_not_ranked_is_none():
    ranks = "<rank type='subtype' id='1' name='boardgame' value='Not Ranked' bayesaverage='Not Ranked'/>"
    got = thing_item_stats(ET.fromstring(_item(2, ranks=ranks, bayes="0", weight="0")))
    assert got["bgg_rank"] is None
    # A zero bayesaverage / weight is BGG's "no votes yet", which is an
    # absence rather than a rating of 0.
    assert got["bgg_rating"] is None
    assert got["bgg_weight"] is None


def test_item_without_statistics_yields_all_none():
    got = thing_item_stats(ET.fromstring("<item type='boardgame' id='3'><name value='x'/></item>"))
    assert got == {"bgg_rating": None, "bgg_rank": None, "bgg_weight": None, "bgg_owned_count": None}


def test_batched_response_is_keyed_by_bgg_id():
    root = ET.fromstring(
        "<items>" + _item(10, ranks=_RANKS) + _item(11, ranks=_RANKS, bayes="6.5")
        + "<item id='oops'/>" + "</items>"
    )
    got = parse_thing_stats(root)
    assert sorted(got) == [10, 11]
    assert got[11]["bgg_rating"] == 6.5
