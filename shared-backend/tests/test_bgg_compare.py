"""Tests for the BgB <-> BGG comparison.

Covers the mirror semantics and, first, the one hazard that is entirely ours:
PostgREST caps an unbounded select at 1000 rows, and a truncated shelf does not
fail — it reads as "these games are not in BgB", which the push turns into
clearing `own` off games the user still owns.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import asyncio

import pytest

from routes.boardgame_buddy import constants as K
from routes.boardgame_buddy.bgg_collection_read import BggCollectionItem
from routes.boardgame_buddy.services import bgg_compare_service as S


# ── Fakes ───────────────────────────────────────────────────────────────────

class _Q:
    """Just enough of the PostgREST builder to serve the two reads."""
    def __init__(self, table, store):
        self.table, self.store, self.lo, self.hi, self.ids = table, store, 0, None, None
    def select(self, *_a, **_k): return self
    def eq(self, *_a, **_k): return self
    def order(self, *_a, **_k): return self
    def in_(self, _col, ids): self.ids = ids; return self
    def range(self, lo, hi): self.lo, self.hi = lo, hi; return self
    def execute(self):
        rows = self.store.get(self.table, [])
        if self.ids is not None:
            rows = [r for r in rows if r.get("bgg_id") in self.ids]
        elif self.hi is not None:
            # PostgREST caps a page server-side; mimic that exactly.
            rows = rows[self.lo:self.hi + 1][:S._PAGE]
        return type("R", (), {"data": rows})()


class _SB:
    def __init__(self, store): self.store = store
    def table(self, name): return _Q(name, self.store)


def _item(bgg_id, status, *, name=None, collid=1, raw=None):
    return BggCollectionItem(
        bgg_id=bgg_id, collid=collid, name=name or f"Game {bgg_id}",
        subtype="boardgame", status=status,
        raw_status=raw if raw is not None else {"own": "1"}, private=None,
    )


def _row(bgg_id, status, name=None):
    return {"game_id": f"uuid-{bgg_id}", "status": status,
            "game_name": name or f"Game {bgg_id}", "game_thumbnail_url": None,
            "game_bgg_id": bgg_id}


def _plan(monkeypatch, *, local, remote, catalog=None, warm=False, collids=None):
    store = {
        "boardgamebuddy_collections": local,
        "boardgamebuddy_games": [
            {"bgg_id": b} for b in
            (catalog if catalog is not None else [r["game_bgg_id"] for r in local if r["game_bgg_id"]]
             + [i.bgg_id for i in remote])
        ],
    }
    # Both fakes take **kw because build_plan threads a `progress` ledger into
    # the real ones. A positional-only stub silently stops matching the moment
    # the sweep gains a keyword, which is exactly how this file went red.
    async def fake_sweep(_u, _n, **kw): return remote, warm
    async def fake_collids(_u, _n, ids, **kw): return collids or {}
    monkeypatch.setattr(S, "_fetch_collection_items", fake_sweep)
    monkeypatch.setattr(S, "_resolve_collids", fake_collids)
    return asyncio.run(S.build_plan(_SB(store), "u1", "tester"))


# ── The pagination hazard ───────────────────────────────────────────────────

def test_a_shelf_larger_than_one_page_is_read_in_full(monkeypatch):
    """1200 rows must all come back. A silent 1000-row cap would turn the
    other 200 owned games into phantom clears."""
    local = [_row(1000 + i, "owned") for i in range(1200)]
    plan = _plan(monkeypatch, local=local, remote=[])
    assert plan.local_total == 1200
    assert len(plan.push) == 1200
    assert all(p.change == K.BggPushChange.ADD for p in plan.push)


def test_paging_stops_on_a_short_page(monkeypatch):
    local = [_row(1000 + i, "owned") for i in range(S._PAGE)]
    plan = _plan(monkeypatch, local=local, remote=[])
    assert plan.local_total == S._PAGE


# ── Push classification ─────────────────────────────────────────────────────

def test_only_in_bgb_is_an_add(monkeypatch):
    plan = _plan(monkeypatch, local=[_row(1, "owned")], remote=[])
    assert [p.change for p in plan.push] == [K.BggPushChange.ADD]


def test_disagreement_is_an_update(monkeypatch):
    plan = _plan(monkeypatch, local=[_row(1, "owned")], remote=[_item(1, "wishlist")])
    assert [p.change for p in plan.push] == [K.BggPushChange.UPDATE]
    assert plan.push[0].local_status == "owned"
    assert plan.push[0].remote_status == "wishlist"


def test_only_on_bgg_is_a_clear(monkeypatch):
    plan = _plan(monkeypatch, local=[], remote=[_item(1, "owned", name="Monopoly")])
    assert [p.change for p in plan.push] == [K.BggPushChange.CLEAR]
    assert plan.push[0].game_name == "Monopoly"   # named from BGG, no local row
    assert plan.push[0].game_id is None


def test_agreement_is_counted_not_listed(monkeypatch):
    plan = _plan(monkeypatch, local=[_row(1, "owned")], remote=[_item(1, "owned")])
    assert plan.push == [] and plan.in_sync_count == 1


def test_a_bgg_row_with_no_tracked_flag_is_not_a_clear(monkeypatch):
    """A game flagged only fortrade is none of BgB's business."""
    plan = _plan(monkeypatch, local=[], remote=[_item(1, None)])
    assert plan.push == [] and plan.pull == []


def test_wanttoplay_only_matches_a_bgb_wishlist(monkeypatch):
    """The importer collapses wanttoplay into wishlist, so the derived statuses
    agree and nothing is written. Comparing raw flags would push wishlist=1."""
    remote = [_item(1, "wishlist", raw={"wishlist": "0", "wanttoplay": "1"})]
    plan = _plan(monkeypatch, local=[_row(1, "wishlist")], remote=remote)
    assert plan.push == [] and plan.in_sync_count == 1


# ── Pull classification ─────────────────────────────────────────────────────

def test_pull_adds_games_only_on_bgg(monkeypatch):
    plan = _plan(monkeypatch, local=[], remote=[_item(1, "owned")])
    assert [p.change for p in plan.pull] == [K.BggPullChange.ADD]


def test_pull_overwrites_a_disagreement(monkeypatch):
    plan = _plan(monkeypatch, local=[_row(1, "owned")], remote=[_item(1, "wishlist")])
    assert [p.change for p in plan.pull] == [K.BggPullChange.UPDATE]


def test_pull_holds_prev_owned_against_bggs_stale_own_flag(monkeypatch):
    """_hold_prev_owned: people leave a sold game flagged own for years."""
    plan = _plan(monkeypatch, local=[_row(1, "prev_owned")], remote=[_item(1, "owned")])
    assert [p.change for p in plan.pull] == [K.BggPullChange.HELD]
    # ...and the push still corrects BGG in the other direction.
    assert [p.change for p in plan.push] == [K.BggPushChange.UPDATE]


def test_pull_never_removes(monkeypatch):
    """A game only in BgB is a push add, and nothing at all for the pull."""
    plan = _plan(monkeypatch, local=[_row(1, "owned")], remote=[])
    assert plan.pull == []


# ── Edges ───────────────────────────────────────────────────────────────────

def test_a_game_with_no_bgg_id_is_unpushable_not_dropped(monkeypatch):
    local = [{"game_id": "u-9", "status": "owned", "game_name": "Kitchen-table Yahtzee",
              "game_thumbnail_url": None, "game_bgg_id": None}]
    plan = _plan(monkeypatch, local=local, remote=[])
    assert plan.push == []
    assert plan.unpushable[0]["game_name"] == "Kitchen-table Yahtzee"
    assert plan.unpushable[0]["reason"] == "no_bgg_id"


def test_games_missing_from_the_catalog_are_flagged_for_import(monkeypatch):
    plan = _plan(monkeypatch, local=[], remote=[_item(7, "owned")], catalog=[])
    assert plan.catalog_missing == [7]
    assert plan.push[0].newly_catalogued is True


def test_warm_up_failure_is_carried_so_the_push_can_refuse(monkeypatch):
    plan = _plan(monkeypatch, local=[], remote=[], warm=True)
    assert plan.warm_up_failed is True


def test_resolved_collid_is_attached_to_an_add(monkeypatch):
    """A game invisible to the flag sweep still has a collection row; using it
    avoids creating a duplicate that orphans the user's rating."""
    resolved = {1: _item(1, None, collid=4242, raw={"fortrade": "1"})}
    plan = _plan(monkeypatch, local=[_row(1, "owned")], remote=[], collids=resolved)
    assert plan.push[0].collid == 4242
    assert plan.push[0].raw_status == {"fortrade": "1"}


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
