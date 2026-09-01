"""Unit tests for the BGG collection-write payload.

The repo's first tests, and they earn it: `build_status_form` is the only place
BGG's undocumented wire format is expressed, and getting it wrong writes to a
real third-party account. It is a pure function, so all of this runs with no
network and no database.

Run:  python -m pytest shared-backend/tests/test_bgg_write.py
  or: python shared-backend/tests/test_bgg_write.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import httpx
import pytest
from fastapi import HTTPException

from routes.boardgame_buddy.bgg_write import (
    BGB_OWNED_FLAGS,
    BGG_PRESERVED_FLAGS,
    build_status_form,
    interpret_save_response,
)

# A realistic <status> element: the three flags BgB owns, the ones it must not
# touch, and the timestamp BGG stamps on every read.
LIVE_STATUS = {
    "own": "1", "prevowned": "0", "wishlist": "0",
    "want": "0", "wanttobuy": "1", "wanttoplay": "1",
    "fortrade": "1", "preordered": "0", "wishlistpriority": "3",
    "lastmodified": "2024-01-02 03:04:05",
}


def _form(target, collid=88881, raw=None):
    return build_status_form(
        bgg_id=266192, collid=collid, target_status=target,
        raw_status=LIVE_STATUS if raw is None else raw,
    )


# ── The echo: flags BgB does not own must survive the round trip ────────────

@pytest.mark.parametrize("flag", BGG_PRESERVED_FLAGS)
def test_unowned_flags_are_echoed_verbatim(flag):
    """The premise of the whole design: fieldname=status replaces the block."""
    form = _form("wishlist")
    assert form[flag] == LIVE_STATUS[flag]


def test_every_incoming_attribute_survives_except_lastmodified():
    form = _form("owned")
    for key in LIVE_STATUS:
        if key == "lastmodified":
            assert key not in form, "lastmodified is BGG's to set, not ours"
        else:
            assert key in form


def test_unknown_future_flag_survives_without_a_code_change():
    """The echo copies keys, it does not whitelist them."""
    raw = dict(LIVE_STATUS, somenewflag2027="1")
    assert _form("owned", raw=raw)["somenewflag2027"] == "1"


# ── The overwrite: exactly three flags, and never wanttoplay ────────────────

@pytest.mark.parametrize("target,expected", [
    ("owned",      {"own": "1", "prevowned": "0", "wishlist": "0"}),
    ("prev_owned", {"own": "0", "prevowned": "1", "wishlist": "0"}),
    ("wishlist",   {"own": "0", "prevowned": "0", "wishlist": "1"}),
    (None,         {"own": "0", "prevowned": "0", "wishlist": "0"}),
])
def test_target_flags(target, expected):
    form = _form(target)
    for flag, value in expected.items():
        assert form[flag] == value


def test_wanttoplay_untouched_when_targeting_wishlist():
    """BgB's importer collapses wanttoplay into wishlist. Pushing must not
    reverse that collapse and set a flag the user never chose."""
    assert _form("wishlist")["wanttoplay"] == LIVE_STATUS["wanttoplay"] == "1"


def test_only_the_owned_flags_differ_from_the_source():
    changed = {
        k for k, v in _form("prev_owned").items()
        if k in LIVE_STATUS and v != LIVE_STATUS[k]
    }
    assert changed <= set(BGB_OWNED_FLAGS)


def test_wishlist_priority_survives_a_no_op():
    assert _form("wishlist")["wishlistpriority"] == "3"


# ── collid: present means edit, absent means create ─────────────────────────

def test_collid_sent_when_known():
    assert _form("owned", collid=88881)["collid"] == "88881"


def test_collid_key_omitted_entirely_when_unknown():
    """Not an empty string: an ambiguous collid risks a duplicate BGG row,
    which would orphan the user's rating and comment on the original."""
    assert "collid" not in _form("owned", collid=None)


def test_collid_zero_is_still_sent():
    """0 is a value, not a missing one — `if collid is not None`, not falsy."""
    assert _form("owned", collid=0)["collid"] == "0"


# ── The fixed envelope ──────────────────────────────────────────────────────

def test_envelope_fields():
    form = _form("owned")
    assert form["ajax"] == "1"
    assert form["action"] == "savedata"
    assert form["objecttype"] == "thing"
    assert form["objectid"] == "266192"
    assert form["fieldname"] == "status"


def test_all_values_are_strings_for_form_encoding():
    assert all(isinstance(v, str) for v in _form("owned").values())


def test_empty_raw_status_still_produces_a_valid_form():
    """A game with no collection row on BGG yet has no <status> to echo."""
    form = build_status_form(bgg_id=1, collid=None, target_status="owned", raw_status={})
    assert form["own"] == "1" and form["objectid"] == "1"


def test_unknown_target_status_is_a_programming_error():
    with pytest.raises(ValueError):
        build_status_form(bgg_id=1, collid=None, target_status="borrowed", raw_status={})


# ── interpret_save_response: fails closed ───────────────────────────────────

def _resp(text, code=200):
    return httpx.Response(code, text=text, request=httpx.Request("POST", "https://x"))


def test_plain_success_json_passes():
    interpret_save_response(_resp('{"collid": 88881}'))


def test_error_key_is_a_failure():
    with pytest.raises(HTTPException) as e:
        interpret_save_response(_resp('{"error": "Not logged in"}'))
    assert e.value.status_code == 502


def test_login_form_body_asks_for_a_relink():
    body = '<html><form action="/login"><input name="password"></form></html>'
    with pytest.raises(HTTPException) as e:
        interpret_save_response(_resp(body))
    assert e.value.status_code == 409


@pytest.mark.parametrize("body", ["", "OK", "<html>whatever</html>", "[1,2]", "null"])
def test_unrecognised_bodies_fail_closed(body):
    """A queue draining green while nothing landed is the worst failure here."""
    with pytest.raises(HTTPException):
        interpret_save_response(_resp(body))


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
