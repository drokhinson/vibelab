"""The ledger behind /admin/run/:tool — what it records and how long it keeps it.

What is pinned here:
  • every phase present from the first write, so a row never appears halfway
    down a running checklist;
  • `begin` closes the phases before it, and a phase that RAISES is left active
    — that is how the page shows where a run died;
  • a pass boundary resets the checklist and keeps the journal, which is what
    makes a twenty-five-request drain read as one log;
  • the ten-minute expiry is measured from the LAST WRITE, so a long run cannot
    expire underneath itself and a finished one does go away;
  • the journal is bounded, and says how much it dropped rather than quietly
    starting mid-run;
  • the summary read carries no journal — the Settings card polls it.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402

import cache  # noqa: E402
from routes.constants import (  # noqa: E402
    AdminBackfillPhase,
    AdminRunLevel,
    AdminRunTool,
    AdminTrendingPhase,
    RunState,
    RunStepState,
)
from routes.services import admin_run_progress as A  # noqa: E402
from routes.services import step_progress  # noqa: E402


@pytest.fixture(autouse=True)
def clean_ledgers():
    cache.clear(A._NS)
    yield
    cache.clear(A._NS)


def _states(snapshot):
    return {s["key"]: s["state"] for s in snapshot["steps"]}


# ── Shape ────────────────────────────────────────────────────────────────────

def test_every_phase_is_present_before_any_work_happens():
    A.open(AdminRunTool.TRENDING)
    snap = A.read(AdminRunTool.TRENDING)
    assert [s["key"] for s in snap["steps"]] == [p.value for p in AdminTrendingPhase]
    assert set(_states(snap).values()) == {RunStepState.IDLE.value}
    assert snap["state"] == RunState.RUNNING.value


def test_each_tool_gets_its_own_phase_vocabulary():
    A.open(AdminRunTool.BGG_METADATA)
    keys = [s["key"] for s in A.read(AdminRunTool.BGG_METADATA)["steps"]]
    assert keys == [p.value for p in AdminBackfillPhase]


def test_begin_closes_earlier_phases_and_fills_their_counters():
    led = A.open(AdminRunTool.BGG_METADATA)
    led.begin(AdminBackfillPhase.SCAN)
    led.begin(AdminBackfillPhase.FETCH, total=4)
    led.tick(AdminBackfillPhase.FETCH, 2)
    led.begin(AdminBackfillPhase.CACHES)
    snap = A.read(AdminRunTool.BGG_METADATA)
    assert _states(snap) == {
        "scan": RunStepState.DONE.value,
        "fetch": RunStepState.DONE.value,
        "caches": RunStepState.ACTIVE.value,
    }
    fetch = next(s for s in snap["steps"] if s["key"] == "fetch")
    assert (fetch["done"], fetch["total"]) == (4, 4), "a closed counting phase reads as complete"


def test_a_failure_leaves_its_own_phase_active():
    """Where the run died is the one thing the reader is looking for."""
    with pytest.raises(RuntimeError):
        with A.run_pass(AdminRunTool.BGG_IMAGES) as led:
            led.begin(AdminBackfillPhase.SCAN)
            led.begin(AdminBackfillPhase.FETCH, total=9)
            raise RuntimeError("BoardGameGeek timed out")
    snap = A.read(AdminRunTool.BGG_IMAGES)
    assert snap["state"] == RunState.FAILED.value
    assert snap["error"] == "BoardGameGeek timed out"
    assert _states(snap)["fetch"] == RunStepState.ACTIVE.value


def test_run_pass_finishes_a_clean_pass_and_reraises_a_dirty_one():
    with A.run_pass(AdminRunTool.TRENDING) as led:
        led.begin(AdminTrendingPhase.FETCH)
    assert A.read(AdminRunTool.TRENDING)["state"] == RunState.DONE.value


def test_a_skipped_phase_is_not_a_failure():
    led = A.open(AdminRunTool.BGG_METADATA)
    led.skip(AdminBackfillPhase.FETCH, detail="Nothing left to fetch")
    led.finish()
    snap = A.read(AdminRunTool.BGG_METADATA)
    assert _states(snap)["fetch"] == RunStepState.SKIPPED.value
    assert snap["state"] == RunState.DONE.value


# ── Passes ───────────────────────────────────────────────────────────────────

def test_a_later_pass_keeps_the_log_and_resets_the_checklist():
    first = A.open(AdminRunTool.BGG_METADATA, started_by="Dana")
    first.begin(AdminBackfillPhase.FETCH, total=2)
    first.event(AdminBackfillPhase.FETCH, "Batch 1 of 2 — 20 of 20 saved")
    first.add_totals(updated=20, failed=1, remaining=80)
    first.finish()
    before = A.read(AdminRunTool.BGG_METADATA)

    second = A.open(AdminRunTool.BGG_METADATA, started_by="Dana", pass_no=1)
    second.event(AdminBackfillPhase.FETCH, "Batch 1 of 2 — 20 of 20 saved")
    second.add_totals(updated=20, failed=0, remaining=60)
    second.finish()
    after = A.read(AdminRunTool.BGG_METADATA)

    assert after["run_id"] == before["run_id"], "a drain is ONE run"
    assert after["started_at"] == before["started_at"]
    assert after["started_by"] == "Dana"
    assert after["pass_no"] == 1
    assert [e["pass_no"] for e in after["events"]] == [0, 1], "the journal spans passes"
    # updated accumulates; remaining is replaced, because it is the server's
    # current view of the queue rather than a thing that happened.
    assert after["totals"] == {"updated": 40, "failed": 1, "remaining": 60}


def test_pass_zero_starts_a_fresh_log():
    """Pressing Run again is a new run, not a twenty-sixth pass of the old one."""
    first = A.open(AdminRunTool.BGG_METADATA)
    first.event(AdminBackfillPhase.SCAN, "from the run before")
    first.add_totals(updated=5)
    first.finish()
    first_run_id = A.read(AdminRunTool.BGG_METADATA)["run_id"]

    A.open(AdminRunTool.BGG_METADATA)
    snap = A.read(AdminRunTool.BGG_METADATA)
    assert snap["events"] == [] and snap["totals"]["updated"] == 0
    assert snap["pass_no"] == 0
    assert snap["run_id"] != first_run_id


def test_a_continued_pass_with_no_record_left_starts_over_rather_than_failing():
    """A restart mid-drain, or a resumed tab whose ledger has expired. An admin
    who cannot restart their own backfill is worse than a log that starts at
    pass 1."""
    led = A.open(AdminRunTool.BGG_METADATA, pass_no=7)
    snap = led.snapshot()
    assert snap["pass_no"] == 0 and snap["events"] == []


# ── The journal ──────────────────────────────────────────────────────────────

def test_events_carry_level_phase_and_pass():
    led = A.open(AdminRunTool.TRENDING)
    led.event(AdminTrendingPhase.IMPORT, "Imported Gloomhaven (BGG 174430)")
    led.event(AdminTrendingPhase.IMPORT, "Brass — boom", level=AdminRunLevel.ERROR)
    events = A.read(AdminRunTool.TRENDING)["events"]
    assert [e["level"] for e in events] == ["info", "error"]
    assert {e["phase"] for e in events} == {"import"}
    assert all(e["pass_no"] == 0 for e in events)


def test_the_journal_is_bounded_and_says_what_it_dropped():
    led = A.open(AdminRunTool.BGG_IMAGES)
    for n in range(A._MAX_EVENTS + 25):
        led.event(AdminBackfillPhase.FETCH, f"line {n}")
    snap = A.read(AdminRunTool.BGG_IMAGES)
    assert len(snap["events"]) == A._MAX_EVENTS
    assert snap["events_dropped"] == 25
    # The OLDEST go: on a long drain the recent failures are the ones being
    # acted on.
    assert snap["events"][0]["message"] == "line 25"
    assert snap["events"][-1]["message"] == f"line {A._MAX_EVENTS + 24}"


def test_a_long_message_is_truncated_rather_than_dropped():
    led = A.open(AdminRunTool.TRENDING)
    led.event(AdminTrendingPhase.IMPORT, "x" * 5000)
    assert len(A.read(AdminRunTool.TRENDING)["events"][0]["message"]) == 300


# ── Expiry ───────────────────────────────────────────────────────────────────

def test_the_ten_minute_clock_starts_at_the_LAST_write(monkeypatch):
    """A twenty-five-minute drain must not expire underneath itself, and a
    finished run must go away. Both fall out of cache.set re-arming the TTL on
    every write — which is the whole mechanism, so it is pinned."""
    now = [1000.0]
    monkeypatch.setattr(cache.time, "monotonic", lambda: now[0])

    led = A.open(AdminRunTool.BGG_METADATA)
    for _ in range(5):
        now[0] += 500.0          # 41 minutes of work, in 8-minute steps
        led.event(AdminBackfillPhase.FETCH, "still going")
        assert A.read(AdminRunTool.BGG_METADATA) is not None, "a live run must not expire"

    led.finish()
    now[0] += A._TTL_SECONDS - 1
    assert A.read(AdminRunTool.BGG_METADATA) is not None, "readable for ten minutes after"
    now[0] += 2
    assert A.read(AdminRunTool.BGG_METADATA) is None, "and gone after that"


# ── Reads ────────────────────────────────────────────────────────────────────

def test_the_summary_read_drops_the_journal():
    """The Settings card polls every tool at once and is not the log."""
    led = A.open(AdminRunTool.TRENDING)
    led.event(AdminTrendingPhase.IMPORT, "a line")
    rows = A.read_all()
    assert len(rows) == 1
    assert "events" not in rows[0] and "events_dropped" not in rows[0]
    assert rows[0]["tool"] == "trending" and "totals" in rows[0] and "steps" in rows[0]


def test_a_tool_that_has_not_run_is_absent_rather_than_idle():
    """An invented row would make every tool look like it had run and finished
    with nothing to show."""
    A.open(AdminRunTool.TRENDING)
    tools = {r["tool"] for r in A.read_all()}
    assert tools == {"trending"}
    assert A.read(AdminRunTool.BGG_METADATA) is None


def test_a_muted_ledger_publishes_nothing_but_still_accepts_every_call():
    """NullProgress is what lets the services be called without a page behind
    them — a test, or the cron — with no `if progress` at any call site."""
    null = A.NullProgress(AdminRunTool.TRENDING)
    null.begin(AdminTrendingPhase.FETCH, total=3)
    null.tick(AdminTrendingPhase.FETCH, 1, detail="x")
    null.skip(AdminTrendingPhase.IMPORT)
    null.event(AdminTrendingPhase.IMPORT, "ignored")
    null.add_totals(updated=1)
    null.finish()
    assert A.read(AdminRunTool.TRENDING) is None


def test_the_ledger_never_lets_a_cache_failure_break_the_run(monkeypatch):
    """Narration must never fail the work it is narrating."""
    def boom(*_a, **_k):
        raise RuntimeError("cache is gone")
    monkeypatch.setattr(step_progress.cache, "set", boom)
    led = A.AdminRunProgress(AdminRunTool.TRENDING)
    led.begin(AdminTrendingPhase.FETCH)
    led.event(AdminTrendingPhase.FETCH, "still fine")
    led.finish()
