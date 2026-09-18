"""Live progress for the admin catalog runs, and the log left behind after one.

Two admin tools do slow, throttled work against BoardGameGeek and used to
report it with a spinner and one toast: **Refresh trending** and the two
backfills behind **Missing BGG data**. This is the ledger they write as they
go — `GET /admin/runs/{tool}` reads it, and `GET /admin/runs` reads the compact
form of every tool at once so the Settings card can paint a status pill without
pulling every journal.

The mechanics are `step_progress.StepLedger`. Four things are this module's
own, and each of them is a decision rather than a detail.

KEYED BY TOOL, NOT BY USER — unlike both sibling ledgers.
  • The nightly cron calls refresh-trending with ADMIN_API_KEY and no profile
    (`get_admin_or_service_key` returns None), so there is no user to key on.
    A tool key is what makes that run readable in the morning.
  • Only one run of a given tool should be in flight at a time, so the tool IS
    the identity.
  • A second admin, a second tab, or the same admin after a reload all want the
    run that is happening — not one of their own.

THE TTL IS THE EXPIRY THE FEATURE PROMISES. `cache.set` recomputes the expiry
on every write, so a ledger flushed on every step re-arms this for as long as
the run is alive; the countdown only starts at the last write, which is
`finish()` or `fail()`. Ten minutes therefore means "the log is readable for
ten minutes after the run ends", with no sweeper and no explicit clear, and a
twenty-five-minute drain cannot expire underneath itself.

A PASS IS NOT A RUN. The backfills are bounded server-side so one request
fits inside the platform timeout, and the browser drains them — up to 25 passes
for a cold catalog. `open()` with `pass_no > 0` therefore REHYDRATES: the
phases reset to IDLE (they are about to run again) while `run_id`, `started_at`,
`started_by`, the journal and the cumulative totals carry over. That is what
makes twenty-five requests read as one log.

THE JOURNAL IS THE POINT. A phase checklist says which *step* is running; it
cannot say which game failed and why. `event()` is the per-item record — one
line per import, per failed batch, per unwritable row — and it is what the
operator actually reads when something went wrong. It is bounded because it
lives in a cached dict that a poll re-serialises every second.

SINGLE WORKER: see `step_progress.py`. Here the consequence is softer than for
the check — a poll landing on a process that never ran the tool reads as
UNKNOWN, which this feature renders as "nothing has run recently", i.e. the
idle state, rather than as a lie about a live run.
"""

import logging
from contextlib import contextmanager

import cache

from fastapi import HTTPException

from ..constants import (
    AdminBackfillPhase,
    AdminRunLevel,
    AdminRunTool,
    AdminTrendingPhase,
    RunState,
)
from .step_progress import StepLedger, utc_now

logger = logging.getLogger(__name__)

_NS = "admin.run.progress"

# Ten minutes after the last write — see the module docstring. This is the
# product promise ("the log clears a while after it finishes"), not a cache
# tuning knob; changing it changes what the page offers.
_TTL_SECONDS = 600.0

# The journal rides inside a cached dict that a 1s poll re-serialises, so it is
# bounded. 200 lines is comfortably more than any single pass produces (a pass
# is capped at 200 rows) and the counter below keeps the total honest when a
# long drain runs past it.
_MAX_EVENTS = 200

# Three tools, so the cap only ever evicts entries that have already expired.
cache.configure(_NS, max_entries=16)

# Which phase vocabulary each tool walks. The two backfills are the same job
# with a different noun in it, which is why they share one enum — the same
# argument views/admin-backfill-view.js makes for being one screen.
_PHASES: dict[AdminRunTool, type] = {
    AdminRunTool.TRENDING: AdminTrendingPhase,
    AdminRunTool.BGG_IMAGES: AdminBackfillPhase,
    AdminRunTool.BGG_METADATA: AdminBackfillPhase,
}

# What a snapshot carries that a compact summary does not. `GET /admin/runs`
# strips these so the Settings poll stays small.
_JOURNAL_KEYS = ("events", "events_dropped")


class AdminRunProgress(StepLedger):
    """One admin run's ledger, keyed by its tool slug and spanning its passes."""

    NAMESPACE = _NS
    TTL_SECONDS = _TTL_SECONDS
    ID_KEY = "run_id"

    def __init__(
        self,
        tool: AdminRunTool,
        *,
        started_by: str | None = None,
        muted: bool = False,
    ) -> None:
        self.tool = tool
        # PHASES is a class attribute on the base because the other two ledgers
        # each have exactly one vocabulary; here it varies per instance, and an
        # instance attribute shadows the class one everywhere the base reads it.
        self.PHASES = _PHASES[tool]
        self.started_by = started_by or "Scheduled run"
        self.pass_no = 0
        self.totals: dict[str, int] = {"updated": 0, "failed": 0, "remaining": 0}
        self._events: list[dict] = []
        self._events_dropped = 0
        super().__init__(tool.value, muted=muted)

    # ── The journal ──────────────────────────────────────────────────────────

    def event(
        self,
        phase,
        message: str,
        *,
        level: AdminRunLevel = AdminRunLevel.INFO,
    ) -> None:
        """One line in the run log. Named per item, not per phase.

        Truncated rather than dropped: a BGG traceback repr can run to
        kilobytes, and every poll re-serialises the whole journal.
        """
        self._events.append({
            "at": utc_now(),
            "level": level.value,
            "phase": getattr(phase, "value", phase),
            "pass_no": self.pass_no,
            "message": str(message)[:300],
        })
        if len(self._events) > _MAX_EVENTS:
            # Drop the OLDEST. On a long drain the recent failures are the ones
            # being acted on, and the counter keeps the total honest.
            overflow = len(self._events) - _MAX_EVENTS
            del self._events[:overflow]
            self._events_dropped += overflow
        self._flush()

    def add_totals(self, *, updated: int = 0, failed: int = 0, remaining: int | None = None) -> None:
        """Roll one pass's counts into the run's. `remaining` REPLACES rather
        than accumulates — it is the server's current view of the queue, not a
        thing that happened."""
        self.totals["updated"] += updated
        self.totals["failed"] += failed
        if remaining is not None:
            self.totals["remaining"] = remaining
        self._flush()

    # ── Passes ───────────────────────────────────────────────────────────────

    def _resume_from(self, snapshot: dict) -> None:
        """Carry a previous pass's identity and log into this one."""
        self.run_id = snapshot.get("run_id") or self.run_id
        self.started_at = snapshot.get("started_at") or self.started_at
        self.started_by = snapshot.get("started_by") or self.started_by
        self.pass_no = int(snapshot.get("pass_no") or 0) + 1
        totals = snapshot.get("totals") or {}
        self.totals = {
            "updated": int(totals.get("updated") or 0),
            "failed": int(totals.get("failed") or 0),
            "remaining": int(totals.get("remaining") or 0),
        }
        self._events = list(snapshot.get("events") or [])
        self._events_dropped = int(snapshot.get("events_dropped") or 0)
        self.state = RunState.RUNNING
        self.error = None
        # The phases are about to run again, so they go back to IDLE — the
        # journal below them is what does NOT reset.
        self._seed_steps()
        self._flush()

    # ── Serialisation ────────────────────────────────────────────────────────

    def _extra(self) -> dict:
        return {
            "tool": self.tool.value,
            "pass_no": self.pass_no,
            "started_by": self.started_by,
            "totals": dict(self.totals),
            "events": [dict(e) for e in self._events],
            "events_dropped": self._events_dropped,
        }


class NullProgress(AdminRunProgress):
    """Publishes nothing, so a service can be called without being watched —
    a test, or a future caller that has no page behind it. Muted rather than
    per-method no-ops; see bgg_progress.NullProgress."""

    def __init__(self, tool: AdminRunTool = AdminRunTool.TRENDING) -> None:
        super().__init__(tool, started_by="", muted=True)

    def event(self, phase, message: str, *, level: AdminRunLevel = AdminRunLevel.INFO) -> None:
        return None


def open(  # noqa: A001 — "open a ledger" is the verb this module is about
    tool: AdminRunTool,
    *,
    started_by: str | None = None,
    pass_no: int = 0,
) -> AdminRunProgress:
    """Start a run's ledger, or continue the one a previous pass left.

    `pass_no` is the CLIENT's count, and it is only ever asked one question:
    is this the first request of a drain? A non-zero value with no record to
    resume — a restart mid-drain, or a resumed tab whose ledger has expired —
    starts a fresh ledger rather than failing, because the alternative is an
    admin who cannot restart their own backfill.

    The previous snapshot is read BEFORE the new ledger exists, because
    constructing one flushes it — over the very entry we are about to resume
    from.
    """
    previous = read(tool) if pass_no > 0 else None
    ledger = AdminRunProgress(tool, started_by=started_by)
    if previous:
        ledger._resume_from(previous)
    return ledger


def read(tool: AdminRunTool | str) -> dict | None:
    """One tool's full ledger, journal included, or None when nothing has run
    in the last `_TTL_SECONDS`."""
    key = getattr(tool, "value", tool)
    return AdminRunProgress.read(key)


def read_all() -> list[dict]:
    """Every live-or-recent run, WITHOUT its journal.

    What the Settings admin card polls. Stripping the journal is the whole
    point: that card is not the log, it is five pills, and it should not cost a
    thousand event rows a second to paint one of them.
    """
    out: list[dict] = []
    for tool in AdminRunTool:
        snap = read(tool)
        if not snap:
            continue
        out.append({k: v for k, v in snap.items() if k not in _JOURNAL_KEYS})
    return out


@contextmanager
def run_pass(
    tool: AdminRunTool,
    *,
    started_by: str | None = None,
    pass_no: int = 0,
):
    """Open a ledger for one pass, and close it however the pass ends.

    The five writers all need the same three lines around their work — open
    before the first guard so a refusal is narrated too, `finish()` on the way
    out, `fail(...)` in BOTH except arms so a run that dies leaves a log saying
    where. Written once here because getting it wrong is silent: a missing
    `fail` leaves a ledger stuck at `running` until its TTL, which the page
    then has to guess about.

    Re-raises everything. This narrates a failure; it does not swallow one.
    """
    ledger = open(tool, started_by=started_by, pass_no=pass_no)
    try:
        yield ledger
    except HTTPException as exc:
        ledger.fail(str(exc.detail))
        raise
    except Exception as exc:  # noqa: BLE001 — the ledger must record any failure
        ledger.fail(str(exc))
        raise
    ledger.finish()
