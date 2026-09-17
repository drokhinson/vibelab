"""GET /plays/imports/{batch_id} — one import, collapsed to the runs it wrote.

There is no import object in the database: a batch is a GROUP BY over
`boardgamebuddy_plays.import_batch_id`. So everything this endpoint reports is
derived, and four of those derivations are things a reviewer cannot eyeball:

  1. THE COLLAPSE. Rows group on COALESCE(import_group_id, id), so a run of
     three identical plays is one row of `group_count` 3 and a one-off — which
     the importer leaves with no group id at all — is its own row of 1 rather
     than being folded in with the runs it arrived beside. The representative
     is the LOWEST id in the group, matching the ORDER BY id LIMIT 1 that
     bgb_plays_page and bgb_feed_plays use; pick a different one and the play
     this screen opens is not the play the feed shows, so a `play-changed`
     echo patches the wrong row.
  2. THE SUMMARY ADDS UP. `sum(group_count) == play_count`, and `game_names`
     is capped at four while `game_count` stays exact — the same contract
     bgb_list_imports states, because the spoke's index row and its detail
     header render from one model and must not disagree about one import.
  3. THE OWNER FILTER. The read is scoped with .eq("user_id", …) and nothing
     else stops a caller reading somebody else's plays. A batch with no rows
     is a 404, which is the same answer a foreign batch gets — losing the
     filter would fail no other test.
  4. THE READ STAYS OFF THE EVENT LOOP. The Supabase client is synchronous and
     this service runs ONE uvicorn worker, so a blocking read left on the loop
     stalls every other request in flight.
"""

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import asyncio

import pytest
from fastapi import HTTPException

from routes import import_routes as R
from routes.dependencies import CurrentUser


ME = "user-me"
BATCH = "batch-1"

USER = CurrentUser(user_id=ME, display_name="Me", username="me")


def _play(pid, *, group=None, game="game-1", name="Catan",
          played="2026-03-02", created="2026-03-04T10:00:00+00:00"):
    return {
        "id": pid,
        "game_id": game,
        "game_name": name,
        "game_thumbnail_url": None,
        "played_at": played,
        "notes": None,
        "created_at": created,
        "imported_at": "2026-03-04T10:00:00+00:00",
        "import_group_id": group,
    }


# One paste: a run of three, plus two one-offs on two other games. The run's
# ids are deliberately out of insertion order so "lowest" cannot be read as
# "first".
PLAYS = [
    _play("p-c", group="grp-1"),
    _play("p-a", group="grp-1"),
    _play("p-b", group="grp-1"),
    _play("solo-2", game="game-2", name="Azul", played="2026-03-03"),
    _play("solo-3", game="game-3", name="Wingspan", played="2026-03-01"),
]


# ── Fakes ────────────────────────────────────────────────────────────────────

class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    """A PostgREST builder that records its filters and serves one payload."""

    def __init__(self, table, log, payload, delay=0.0):
        self._table, self._log, self._payload, self._delay = table, log, payload, delay

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        self._log.setdefault(self._table, {})[col] = val
        return self

    def in_(self, col, vals):
        self._log.setdefault(self._table, {})[col] = list(vals)
        return self

    def execute(self):
        # A real Supabase read blocks the calling thread. That is the whole
        # point of the fake — a sleep here is what an await would never be.
        if self._delay:
            time.sleep(self._delay)
        return _Result(self._payload)


class _Supabase:
    def __init__(self, payloads, delay=0.0):
        self._payloads, self._delay = payloads, delay
        self.filters: dict[str, dict] = {}
        self.tables: list[str] = []

    def table(self, name):
        self.tables.append(name)
        # Only the plays read is slowed: it is the one this endpoint owns.
        delay = self._delay if name == "boardgamebuddy_plays" else 0.0
        return _Query(name, self.filters, self._payloads.get(name, []), delay)

    def rpc(self, name, params):
        raise AssertionError(f"unexpected rpc: {name}")


@pytest.fixture
def sb(monkeypatch):
    """Install a fake Supabase and hand the test a setter for its rows."""
    holder = {}

    def install(plays=PLAYS, players=None, profiles=None, delay=0.0):
        holder["sb"] = _Supabase(
            {
                "boardgamebuddy_plays": plays,
                "boardgamebuddy_play_players": players or [],
                "boardgamebuddy_profiles": profiles or [],
            },
            delay,
        )
        monkeypatch.setattr(R, "get_supabase", lambda: holder["sb"])
        return holder["sb"]

    return install


def _get(batch_id=BATCH, user=USER):
    return asyncio.run(R.get_import(batch_id=batch_id, user=user))


# ── Tests ────────────────────────────────────────────────────────────────────

def test_a_run_collapses_and_a_one_off_does_not(sb):
    sb()

    runs = _get().runs

    # Newest first, so the 03-03 one-off leads and the run sits between the
    # other two — the count is per row, not per play.
    assert [r.group_count for r in runs] == [1, 3, 1]
    # The run keeps its group id — it is what the delete acts on — and a
    # one-off carries None rather than being dropped from the list.
    by_count = {r.group_count: r for r in runs}
    assert by_count[3].import_group_id == "grp-1"
    assert [r.import_group_id for r in runs if r.group_count == 1] == [None, None]


def test_the_representative_is_the_lowest_id_in_the_group(sb):
    sb()

    run = next(r for r in _get().runs if r.group_count == 3)

    # p-a, not p-c: the group's members arrive in insertion order and the
    # representative is chosen by id, the same rule the feed and the plays log
    # use, so all three surfaces open the same play.
    assert run.play_id == "p-a"


def test_the_summary_adds_up_to_what_the_runs_hold(sb):
    detail = sb() and _get()

    assert detail.batch.play_count == len(PLAYS)
    assert sum(r.group_count for r in detail.runs) == detail.batch.play_count
    assert detail.batch.game_count == 3
    assert detail.batch.batch_id == BATCH
    assert str(detail.batch.first_played_at) == "2026-03-01"
    assert str(detail.batch.last_played_at) == "2026-03-03"


def test_game_names_are_capped_at_four_while_the_count_stays_exact(sb):
    sb(plays=[
        _play(f"p-{i}", game=f"game-{i}", name=name, played="2026-03-02")
        for i, name in enumerate(["Azul", "Brass", "Catan", "Dune", "Everdell", "Fresco"])
    ])

    detail = _get()

    # Four names, alphabetically, mirroring bgb_list_imports' ARRAY_AGG[1:4] —
    # the index row and this header have to describe one import the same way.
    assert detail.batch.game_names == ["Azul", "Brass", "Catan", "Dune"]
    assert detail.batch.game_count == 6


def test_runs_come_back_newest_first(sb):
    sb()

    assert [str(r.played_at) for r in _get().runs] == [
        "2026-03-03", "2026-03-02", "2026-03-01",
    ]


def test_the_roster_is_hydrated_for_the_representative_only(sb):
    fake = sb(players=[
        {"play_id": "p-a", "player_user_id": None, "player_display_name": "Mick",
         "is_winner": True, "score": 12, "round_scores": None},
        {"play_id": "p-a", "player_user_id": None, "player_display_name": "Sam",
         "is_winner": False, "score": 9, "round_scores": None},
    ])

    run = next(r for r in _get().runs if r.group_count == 3)

    assert [p.name for p in run.players] == ["Mick", "Sam"]
    # Asked for the three representatives, not for all five plays: the members
    # of a run are indistinguishable, so their rosters are the same roster.
    assert sorted(fake.filters["boardgamebuddy_play_players"]["play_id"]) == [
        "p-a", "solo-2", "solo-3",
    ]


def test_a_batch_with_no_rows_is_a_404_and_the_read_is_owner_scoped(sb):
    fake = sb(plays=[])

    with pytest.raises(HTTPException) as exc:
        _get(batch_id="someone-elses-batch")

    assert exc.value.status_code == 404
    # The owner filter is the ONLY thing standing between this route and
    # somebody else's plays, and nothing else here would fail without it.
    assert fake.filters["boardgamebuddy_plays"] == {
        "user_id": ME,
        "import_batch_id": "someone-elses-batch",
    }


def test_the_loop_keeps_running_during_the_read(sb):
    sb(delay=0.25)

    async def main():
        ticks = 0

        async def tick():
            nonlocal ticks
            while True:
                await asyncio.sleep(0.01)
                ticks += 1

        ticker = asyncio.create_task(tick())
        await R.get_import(batch_id=BATCH, user=USER)
        ticker.cancel()
        return ticks

    # ~25 ticks if the read is off the loop; 0 or 1 if it is blocking it.
    assert asyncio.run(main()) > 5
