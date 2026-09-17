"""Live progress for a Board Game Arena sweep, so the FE can narrate the wait.

The sibling of `bgg_progress.py`, and its reasoning applies here unchanged —
read that module's docstring first. The short version: this is an IN-PROCESS
ledger and not a queue table, because the sweep is in-handler work, so a
restart kills the sweep, the client's connection and the record together. A
durable row would outlive all three and lie about work that no longer exists.

WHY THE SWEEP IS IN-HANDLER AT ALL, given POST /bgg/sync is a BackgroundTask.
The two are not the same kind of job. `/bgg/sync` defers catalog WRITES — rows
worth having whether or not anyone is watching, idempotent, and still there
after a restart. The BGA sweep writes nothing: its entire output is a draft the
user is about to review in the wizard, held in their browser's localStorage.
Deferring it would produce a durable record of a proposal that died with the
connection.

It is also the answer this feature's terms require. BGA prohibits automated
access, so every request it makes happens inside a request a person is
watching — no cron, no queue, no background re-sync. Do not "improve" this into
a worker; see Docs/BGA_IMPORT.md.

SINGLE WORKER, same caveat as the BGG ledger: a poll landing on a process that
never ran the sweep reads as UNKNOWN, which the FE renders as "still working".
"""

import logging
import uuid
from datetime import datetime, timezone

import cache

from ..constants import BgaFetchPhase, BgaFetchState, BgaFetchStepState

logger = logging.getLogger(__name__)

_NS = "bga.fetch.progress"

# Long enough to outlive the slowest plausible sweep — BGA_SWEEP_BUDGET_SECONDS
# defaults to 90, and the throttle can stretch a capped run past that — and
# short enough that an abandoned record cannot be mistaken for a live one.
_TTL_SECONDS = 600.0

# One entry per user in flight; a second fetch 409s while one is running.
cache.configure(_NS, max_entries=500)


def _now() -> datetime:
    return datetime.now(timezone.utc)


class BgaFetchProgress:
    """The ledger for one sweep. Writes are dict assignments, never I/O.

    Every mutator ends in `_flush()`, which republishes the whole snapshot, so
    a poll sees either the previous phase or the next one and never a
    half-updated step list.
    """

    def __init__(self, user_id: str) -> None:
        self.user_id = user_id
        self.fetch_id = uuid.uuid4().hex
        self.started_at = _now()
        self.state = BgaFetchState.RUNNING
        self.truncated = False
        self.error: str | None = None
        # Every phase seeded up front, so a row never appears halfway down a
        # running checklist. DETAIL is often skipped — see its enum docstring.
        self._steps: dict[str, dict] = {
            phase.value: {
                "key": phase.value,
                "state": BgaFetchStepState.IDLE.value,
                "done": None,
                "total": None,
                "detail": None,
            }
            for phase in BgaFetchPhase
        }
        self._flush()

    # ── Mutators ─────────────────────────────────────────────────────────────

    def begin(
        self, phase: BgaFetchPhase, *, total: int | None = None, detail: str | None = None
    ) -> None:
        """Mark `phase` active, and close everything before it.

        The phases are strictly sequential, so "we are on DETAIL" already means
        HISTORY finished. A phase that raises leaves its own row active, which
        is exactly where the user should see the failure.
        """
        step = self._steps[phase.value]
        step["state"] = BgaFetchStepState.ACTIVE.value
        step["total"] = total
        step["done"] = 0 if total is not None else None
        step["detail"] = detail
        for earlier in BgaFetchPhase:
            if earlier is phase:
                break
            prior = self._steps[earlier.value]
            if prior["state"] == BgaFetchStepState.ACTIVE.value:
                prior["state"] = BgaFetchStepState.DONE.value
                if prior["total"] is not None:
                    prior["done"] = prior["total"]
        self._flush()

    def tick(self, phase: BgaFetchPhase, done: int, *, detail: str | None = None) -> None:
        """Advance the counter on an active phase."""
        step = self._steps[phase.value]
        step["done"] = done
        if detail is not None:
            step["detail"] = detail
        self._flush()

    def skip(self, phase: BgaFetchPhase, *, detail: str | None = None) -> None:
        """This phase was not needed — a history page carrying its own rosters
        skips DETAIL entirely."""
        step = self._steps[phase.value]
        step["state"] = BgaFetchStepState.SKIPPED.value
        step["detail"] = detail
        self._flush()

    def note_truncated(self) -> None:
        """A cap was hit; there is older history still on BGA."""
        self.truncated = True
        self._flush()

    def finish(self) -> None:
        for step in self._steps.values():
            if step["state"] == BgaFetchStepState.ACTIVE.value:
                step["state"] = BgaFetchStepState.DONE.value
                if step["total"] is not None:
                    step["done"] = step["total"]
        self.state = BgaFetchState.DONE
        self._flush()

    def fail(self, message: str) -> None:
        self.state = BgaFetchState.FAILED
        self.error = message[:300]
        self._flush()

    # ── Serialisation ────────────────────────────────────────────────────────

    def snapshot(self) -> dict:
        return {
            "state": self.state.value,
            "fetch_id": self.fetch_id,
            "started_at": self.started_at,
            "updated_at": _now(),
            "steps": [dict(self._steps[p.value]) for p in BgaFetchPhase],
            "truncated": self.truncated,
            "error": self.error,
        }

    def _flush(self) -> None:
        try:
            cache.set(_NS, self.user_id, self.snapshot(), ttl_seconds=_TTL_SECONDS)
        except Exception as exc:  # noqa: BLE001 — narration must never fail a sweep
            logger.warning("BGA fetch progress write failed for %s: %s", self.user_id, exc)


class NullProgress(BgaFetchProgress):
    """Every method a no-op, so the sweep's plumbing can be unconditional."""

    def __init__(self) -> None:  # noqa: D107 — deliberately does not call super()
        self.user_id = ""
        self.fetch_id = ""
        self.started_at = _now()
        self.state = BgaFetchState.RUNNING
        self.truncated = False
        self.error = None
        self._steps = {}

    def begin(self, phase, *, total=None, detail=None) -> None: return None
    def tick(self, phase, done, *, detail=None) -> None: return None
    def skip(self, phase, *, detail=None) -> None: return None
    def note_truncated(self) -> None: return None
    def finish(self) -> None: return None
    def fail(self, message: str) -> None: return None
    def _flush(self) -> None: return None


def read(user_id: str) -> dict | None:
    """The latest snapshot for a user, or None when this process has none."""
    try:
        return cache.get(_NS, user_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("BGA fetch progress read failed for %s: %s", user_id, exc)
        return None


def clear(user_id: str) -> None:
    """Drop a user's ledger — used when a fetch is abandoned before it runs."""
    try:
        cache.delete(_NS, user_id)
    except Exception:  # noqa: BLE001
        pass
