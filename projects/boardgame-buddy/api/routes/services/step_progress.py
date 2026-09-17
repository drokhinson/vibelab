"""The ledger behind every step-by-step progress checklist in this API.

Three features narrate a long wait the same way: the BGG comparison
(`bgg_progress.py`), the Board Game Arena sweep (`bga_progress.py`) and the
admin catalog runs (`admin_run_progress.py`). Each is a fixed sequence of
phases that a handler walks while a browser polls a GET for the current state.
The mechanics of that ledger — seed every phase up front, mark one active and
the earlier ones done, count within a phase, publish the WHOLE snapshot on
every write — were copied twice before this module existed.

`.claude/rules/ui-object-design.md` §4 says extract at instance #2 and split
along lifecycle versus appearance. That is exactly the seam here:

  • THIS FILE owns the lifecycle. Nothing in it knows what a phase is called,
    what the run is for, or what else the snapshot should carry.
  • EACH CALLER owns the vocabulary — its own phase enum, its own namespace and
    TTL, its own extra fields through `_extra()`, and its own module docstring
    arguing why its ledger is in-process rather than a table.

WHY IN-PROCESS AND NOT A TABLE. Read `bgg_progress.py`'s docstring — the
argument belongs with the caller, because it is different for each one. The
short version for all three: the work is awaited inside a request, so a restart
kills the work, the connection and the record together, and a durable row would
outlive all three and lie about work that no longer exists.

SINGLE WORKER. `cache.py` is per-process and uvicorn runs one worker here
(`railway.toml`, `Procfile`; see the project CLAUDE.md item 8). A poll landing
on a process that never ran the work reads as `RunState.UNKNOWN` — which is a
state every consumer already has to handle, so a second worker would degrade
this to a blind spinner rather than break it. The real fix is the Redis
migration sketched in `cache.py`'s TODO; add each namespace to that list when
it happens.
"""

import logging
import uuid
from datetime import datetime, timezone
from enum import StrEnum

import cache

from ..constants import RunState, RunStepState

logger = logging.getLogger(__name__)


def utc_now() -> datetime:
    """Shared by the subclasses, so `started_at` and `updated_at` agree."""
    return datetime.now(timezone.utc)


class StepLedger:
    """One run's progress, as a dict republished on every change.

    Writes are dict assignments, never I/O. Every mutator ends in `_flush()`,
    which rewrites the whole entry rather than mutating one in place — that is
    what keeps the cached value immutable from a reader's point of view, so a
    poll sees either the previous phase or the next one and never a
    half-updated step list.

    Subclasses set the four class attributes below and may override `_extra()`.
    """

    #: Cache namespace. One per feature, so they age and evict independently.
    NAMESPACE: str = ""
    #: How long an entry outlives its last write. Because `cache.set` recomputes
    #: the expiry on every write (cache.py), a ledger flushed on every step
    #: re-arms this for as long as the run is alive — so the TTL is really
    #: "how long the record survives AFTER the run stops writing".
    TTL_SECONDS: float = 300.0
    #: The phase enum. ITS ORDER IS THE ORDER ON SCREEN — consumers render the
    #: checklist by walking it, so a phase's position here is load-bearing.
    PHASES: type[StrEnum] = RunStepState  # overridden; never used as-is
    #: What the run's id is called on the wire. Historical per feature.
    ID_KEY: str = "run_id"

    def __init__(self, key: str, *, muted: bool = False) -> None:
        self.key = key
        self.muted = muted
        self.run_id = uuid.uuid4().hex
        self.started_at = utc_now()
        self.state: RunState = RunState.RUNNING
        self.error: str | None = None
        self._steps: dict[str, dict] = {}
        self._seed_steps()
        self._flush()

    def _seed_steps(self) -> None:
        """Every phase present from the first paint.

        A row appearing halfway down a running checklist reads worse than one
        that turns out not to have been needed — which is what SKIPPED is for.
        """
        self._steps = {
            phase.value: {
                "key": phase.value,
                "state": RunStepState.IDLE.value,
                "done": None,
                "total": None,
                "detail": None,
                "retry": None,
            }
            for phase in self.PHASES
        }

    # ── Mutators ─────────────────────────────────────────────────────────────

    def begin(
        self,
        phase: StrEnum,
        *,
        total: int | None = None,
        detail: str | None = None,
    ) -> None:
        """Mark `phase` active, and everything before it done.

        Closing the earlier phases here rather than making each caller pair
        every `begin` with an `end` is deliberate: the phases are strictly
        sequential, so "we are on CATALOG" already means SHELF finished. It
        also means a phase that RAISES leaves its own row active — which is
        exactly where the reader should see the failure.
        """
        step = self._steps[phase.value]
        step["state"] = RunStepState.ACTIVE.value
        step["total"] = total
        step["done"] = 0 if total is not None else None
        step["detail"] = detail
        step["retry"] = None
        for earlier in self.PHASES:
            if earlier is phase:
                break
            prior = self._steps[earlier.value]
            if prior["state"] == RunStepState.ACTIVE.value:
                prior["state"] = RunStepState.DONE.value
                prior["retry"] = None
                if prior["total"] is not None:
                    prior["done"] = prior["total"]
        self._flush()

    def tick(self, phase: StrEnum, done: int, *, detail: str | None = None) -> None:
        """Advance the counter on an active phase."""
        step = self._steps[phase.value]
        step["done"] = done
        if detail is not None:
            step["detail"] = detail
        # A tick means whatever was retrying has landed.
        step["retry"] = None
        self._flush()

    def retry(
        self, phase: StrEnum, *, attempt: int, of: int, wait_seconds: float
    ) -> None:
        """The same request is going again after a backoff.

        Represented ON the step rather than as a step of its own, because that
        is what it is. `resume_at` is an absolute epoch second so a client
        counts down against the moment work actually resumes, rather than
        starting its own timer however long after the fact its poll landed.
        """
        self._steps[phase.value]["retry"] = {
            "attempt": attempt,
            "of": of,
            "wait_seconds": wait_seconds,
            "resume_at": utc_now().timestamp() + wait_seconds,
        }
        self._flush()

    def skip(self, phase: StrEnum, *, detail: str | None = None) -> None:
        """This phase was not needed. Reads as done-and-greyed, not as a state
        of its own — it is a thing that did not need doing."""
        step = self._steps[phase.value]
        step["state"] = RunStepState.SKIPPED.value
        step["detail"] = detail
        step["retry"] = None
        self._flush()

    def finish(self) -> None:
        for step in self._steps.values():
            if step["state"] == RunStepState.ACTIVE.value:
                step["state"] = RunStepState.DONE.value
                step["retry"] = None
                if step["total"] is not None:
                    step["done"] = step["total"]
        self.state = RunState.DONE
        self._flush()

    def fail(self, message: str) -> None:
        self.state = RunState.FAILED
        self.error = message[:300]
        self._flush()

    # ── Serialisation ────────────────────────────────────────────────────────

    def _extra(self) -> dict:
        """Fields this feature adds to the snapshot. Merged last, so a subclass
        can also override a common one if it genuinely has to."""
        return {}

    def snapshot(self) -> dict:
        return {
            "state": self.state.value,
            self.ID_KEY: self.run_id,
            "started_at": self.started_at,
            "updated_at": utc_now(),
            "steps": [dict(self._steps[p.value]) for p in self.PHASES],
            "error": self.error,
            **self._extra(),
        }

    def _flush(self) -> None:
        # A muted ledger still keeps its steps in memory — every mutator works,
        # nothing is published. That is what lets a caller's plumbing be
        # unconditional (`progress.tick(...)` with no `if progress`) while its
        # default stays "report nothing", with no per-method no-op overrides to
        # fall out of step with the real class.
        if self.muted:
            return
        try:
            cache.set(
                self.NAMESPACE, self.key, self.snapshot(), ttl_seconds=self.TTL_SECONDS
            )
        except Exception as exc:  # noqa: BLE001 — narration must never fail the work
            logger.warning(
                "%s progress write failed for %s: %s", self.NAMESPACE, self.key, exc
            )

    # ── Reads ────────────────────────────────────────────────────────────────

    @classmethod
    def read(cls, key: str) -> dict | None:
        """The latest snapshot, or None when this process has no record."""
        try:
            return cache.get(cls.NAMESPACE, key)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "%s progress read failed for %s: %s", cls.NAMESPACE, key, exc
            )
            return None

    @classmethod
    def drop(cls, key: str) -> None:
        """Forget a ledger — for work abandoned before it ran."""
        try:
            cache.delete(cls.NAMESPACE, key)
        except Exception:  # noqa: BLE001
            pass
