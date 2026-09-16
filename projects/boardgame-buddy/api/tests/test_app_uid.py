"""The app's user id comes from a claim, because `sub` is not always a UUID.

The 23 accounts migrated from Supabase kept their original UUIDs as their
Identity Platform uid, so for a year `sub` WAS the app's user id and the whole
schema is typed `uuid` on that assumption — 35 columns, 58 RPC parameters. The
first brand-new account got a Firebase-generated 28-character uid instead, and
every authenticated endpoint answered 500: `invalid input syntax for type
uuid`, raised deep inside PostgREST and surfaced by main.py's APIError handler
as a server fault.

The blocking function in projects/boardgame-buddy/functions/ now resolves the
id at sign-in into an `app_uid` claim. These pin the reading half — in
particular that an unusable identity is a 401 and never a 500, and that the
transitional `sub` fallback is narrow enough that it cannot accept the very
thing it exists alongside.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest
from fastapi import HTTPException

from jwt_auth import _app_uid

MIGRATED = "22222222-2222-2222-2222-222222222222"
FIREBASE_UID = "kJ8fHs2mNpQr4TvW6XyZaBcDeFg"
DERIVED = "076e625a-5250-58bd-ab52-c7df3a062914"  # uuid5 of the above


def test_the_claim_is_the_answer():
    assert _app_uid({"sub": FIREBASE_UID, "app_uid": DERIVED}) == DERIVED


def test_a_uuid_sub_still_works_while_old_tokens_are_alive():
    """The transitional arm. Tokens minted before the blocking function
    existed carry no claim, and every one of them is a migrated account."""
    assert _app_uid({"sub": MIGRATED}) == MIGRATED


def test_the_claim_wins_over_sub():
    """Both present and disagreeing should not happen, but if it does the
    claim is the considered answer and `sub` is the raw input to it."""
    assert _app_uid({"sub": MIGRATED, "app_uid": DERIVED}) == DERIVED


def test_a_firebase_sub_with_no_claim_is_a_401_not_a_500():
    """The whole point. This is the shape that produced the outage: without
    the claim there is no usable id, and pretending otherwise puts a
    28-character string into a uuid column."""
    with pytest.raises(HTTPException) as caught:
        _app_uid({"sub": FIREBASE_UID})
    assert caught.value.status_code == 401


@pytest.mark.parametrize(
    "payload",
    [
        {},                                      # nothing at all
        {"sub": ""},                             # empty
        {"sub": "   "},                          # whitespace
        {"app_uid": "not-a-uuid", "sub": FIREBASE_UID},
        {"app_uid": "", "sub": FIREBASE_UID},
        # A UUID with a character too many, to prove the anchors are doing work.
        {"sub": MIGRATED + "0"},
        {"sub": "0" + MIGRATED},
    ],
)
def test_every_unusable_identity_is_a_401(payload):
    with pytest.raises(HTTPException) as caught:
        _app_uid(payload)
    assert caught.value.status_code == 401


def test_a_malformed_claim_falls_through_to_a_usable_sub():
    """A claim that is present but junk must not shadow a working `sub`."""
    assert _app_uid({"app_uid": "nonsense", "sub": MIGRATED}) == MIGRATED


def test_ids_are_normalised_to_lower_case():
    """Postgres renders uuid lower-case, and these ids are compared as strings
    in the profile cache (dependencies.py) long before they reach a uuid
    column. Two cases of one id would be two cache entries."""
    upper = MIGRATED.upper()
    assert _app_uid({"sub": upper}) == MIGRATED
    assert _app_uid({"app_uid": DERIVED.upper()}) == DERIVED
