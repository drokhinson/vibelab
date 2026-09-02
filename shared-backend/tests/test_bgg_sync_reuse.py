"""Two bugs one BoardGameGeek sync ran into, and the code that now prevents them.

1. BOTH SYNC BUTTONS RE-DID THE COMPARISON. `POST /bgg/check` spends ten to
   forty seconds sweeping BGG; pressing either sync button then swept it all
   over again — the push by re-running `build_plan`, the import by re-reading
   the collection inside `_run_sync`. `bgg_check_cache` is where the check's
   result now waits for the button press it was made for, so these tests are
   about what it will and will not hand back.

2. A REFUSED WRITE WAS REPORTED AS A BAD PASSWORD. Eighteen games came back
   saying "BoardGameGeek rejected the stored password" about a password that
   had just successfully logged in — see BggRefusedError. These tests pin the
   classification that produces the honest message instead.

All pure: no network, no database.

Run:  python -m pytest shared-backend/tests/test_bgg_sync_reuse.py
"""

import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import httpx
import pytest

import cache
from routes.boardgame_buddy.bgg_client import (
    BggRefusedError,
    _cloudflare_block,
    _refused,
)
from routes.boardgame_buddy.bgg_collection_read import (
    BggCollectionItem,
    collection_rows_from_items,
)
from routes.boardgame_buddy.services import bgg_check_cache
from routes.boardgame_buddy.services.bgg_compare_service import ComparePlan

USER = "user-1"
STAMP = datetime(2026, 9, 2, 12, 15, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _clean_cache():
    cache.clear("bgg.check.plan")
    yield
    cache.clear("bgg.check.plan")


def _item(bgg_id, status="owned", private=None):
    return BggCollectionItem(
        bgg_id=bgg_id, collid=1000 + bgg_id, name=f"Game {bgg_id}",
        subtype="boardgame", status=status, raw_status={"own": "1"}, private=private,
    )


def _store(*, items=(), warm=False, stamp=STAMP):
    plan = ComparePlan(remote_items=list(items), warm_up_failed=warm)
    bgg_check_cache.store(USER, checked_at=stamp, plan=plan)
    return plan


# ── The push takes the plan it was shown, or none at all ────────────────────


def test_the_reviewed_plan_comes_back():
    plan = _store()
    assert bgg_check_cache.pop_plan(USER, checked_at=STAMP) is plan


def test_a_different_comparison_is_refused_so_the_push_re_plans():
    """The stamp is the whole guarantee that this is the list the user saw."""
    _store()
    assert bgg_check_cache.pop_plan(USER, checked_at=STAMP + timedelta(minutes=2)) is None


def test_sub_second_drift_still_matches():
    """Same value, round-tripped through JSON. Not a different comparison."""
    _store()
    assert bgg_check_cache.pop_plan(
        USER, checked_at=STAMP + timedelta(milliseconds=400),
    ) is not None


def test_a_client_naming_no_comparison_gets_nothing():
    """No stamp is no proof, and a push is a write to somebody's real account."""
    _store()
    assert bgg_check_cache.pop_plan(USER, checked_at=None) is None


def test_nothing_stored_is_not_an_error():
    assert bgg_check_cache.pop_plan(USER, checked_at=STAMP) is None
    assert bgg_check_cache.pop_sweep(USER) is None


def test_acting_on_a_plan_spends_it():
    """A second commit must sweep again — the account has just been written to."""
    _store()
    assert bgg_check_cache.pop_plan(USER, checked_at=STAMP) is not None
    assert bgg_check_cache.pop_plan(USER, checked_at=STAMP) is None


def test_one_users_comparison_is_not_anothers():
    _store()
    assert bgg_check_cache.pop_plan("someone-else", checked_at=STAMP) is None


# ── The import takes the sweep, which needs no stamp but must be whole ──────


def test_the_import_reuses_the_sweep_without_a_stamp():
    """Collection items are data, not a decision. A read from two minutes ago
    is the read _run_sync would go and make."""
    _store(items=[_item(1), _item(2)])
    swept = bgg_check_cache.pop_sweep(USER)
    assert [it.bgg_id for it in swept] == [1, 2]


def test_a_partial_sweep_is_never_handed_to_the_import():
    """A batch that exhausted its warm-up retries returned ZERO items, which an
    import would write as a collection that has shrunk."""
    _store(items=[_item(1)], warm=True)
    assert bgg_check_cache.pop_sweep(USER) is None


def test_reusing_the_sweep_spends_it_too():
    _store(items=[_item(1)])
    assert bgg_check_cache.pop_sweep(USER) is not None
    assert bgg_check_cache.pop_sweep(USER) is None


def test_the_reduced_rows_match_what_the_importer_expects():
    """The reuse path feeds _run_sync through this, so it has to produce the
    same (bgg_id, status, private) shape the sweep adapter always did — and
    drop the items carrying no flag BgB tracks."""
    rows = collection_rows_from_items([
        _item(1, "owned", private={"quantity": 2}),
        _item(2, None),
        _item(3, "wishlist"),
    ])
    assert rows == [(1, "owned", {"quantity": 2}), (3, "wishlist", None)]


def test_invalidate_forgets_a_comparison():
    _store(items=[_item(1)])
    bgg_check_cache.invalidate(USER)
    assert bgg_check_cache.peek(USER) is None


# ── A refused write is not a bad password ───────────────────────────────────


def _resp(code, text="", headers=None):
    return httpx.Response(
        code, text=text, headers=headers or {},
        request=httpx.Request("POST", "https://boardgamegeek.com/geekcollection.php"),
    )


def test_a_cloudflare_block_is_identified_by_its_body():
    assert _cloudflare_block(
        _resp(403, "<html><title>Attention Required! | Cloudflare</title></html>")
    ) is not None


def test_a_cloudflare_block_carries_its_ray_id():
    ray = _cloudflare_block(_resp(403, "just a moment...", {"cf-ray": "8f2c1"}))
    assert ray == "8f2c1"


def test_a_block_with_no_ray_id_is_still_a_block():
    """"" is Cloudflare-unidentified, None is not-Cloudflare. `is not None`."""
    assert _cloudflare_block(_resp(403, "cf-error-details")) == ""


def test_an_ordinary_403_is_not_blamed_on_cloudflare():
    assert _cloudflare_block(_resp(403, '{"error": "no"}')) is None


def test_a_success_is_never_a_block():
    assert _cloudflare_block(_resp(200, "just a moment")) is None


def test_the_message_for_a_blocked_write_never_mentions_the_password():
    """The whole point. login_to_bgg had already minted a session by the time
    this is raised, so the credentials are proven good."""
    err = _refused(
        _resp(403, "attention required", {"cf-ray": "8f2c1"}),
        context="POST geekcollection.php", ray_id="8f2c1", relogged_in=True,
    )
    assert isinstance(err, BggRefusedError)
    detail = str(err.detail).lower()
    assert "password" not in detail
    assert "re-link" not in detail
    assert "8f2c1" in detail
    assert err.ray_id == "8f2c1"


def test_a_plain_refusal_says_the_login_worked():
    err = _refused(
        _resp(401), context="POST geekcollection.php", ray_id=None, relogged_in=True,
    )
    assert "signed in successfully" in str(err.detail)
    assert "401" in str(err.detail)


def test_a_logged_out_200_reads_as_a_session_problem_not_a_credential_one():
    err = _refused(
        _resp(200, "login … password"),
        context="POST geekcollection.php", ray_id=None, relogged_in=True,
    )
    assert "signed out" in str(err.detail)
    assert "password" not in str(err.detail).lower()


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
