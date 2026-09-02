"""Live progress for a BGG comparison, so the FE can narrate a 40-second wait.

POST /bgg/check does eight throttled BoardGameGeek calls, two Supabase reads
and up to eight more BGG calls before it can answer. From the browser that is
one promise that resolves in somewhere between ten seconds and two minutes, and
a spinner is indistinguishable from a hang. This module is the ledger the
handler writes as it goes, and GET /bgg/check/progress reads.

WHY THE IN-PROCESS CACHE AND NOT A TABLE. The sweep is *in-handler* work —
`build_plan` is awaited inside `check_bgg` before it can respond — so a restart
kills the sweep, the client's connection and the result together. A record that
died with them is correct. A durable row would outlive all three and sit there
claiming "batch 5 of 8, 4s ago" about work that no longer exists anywhere, and
the FE would need a staleness heuristic to un-lie. Durability is the wrong
property here.

The contrast proves the rule rather than breaking it: the catalog fill and the
push queue ARE BackgroundTasks that outlive the response, and they use DB queue
tables with session anchors precisely because they have to.

SINGLE WORKER. uvicorn runs one process today (shared-backend/Procfile,
railway.toml — neither passes --workers), so the POST that writes and the GET
that reads are the same process. If a second worker is ever added, a poll can
land somewhere that never ran the check: that reads as BggCheckState.UNKNOWN,
which the FE already renders as "still working", so the feature degrades to
today's blind spinner rather than breaking. Fixing it properly is the Redis
migration already sketched in shared-backend/cache.py's module docstring — add
this namespace to that TODO's list when you do it.
"""

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

import cache

from ..constants import BggCheckPhase, BggCheckState, BggCheckStepState

logger = logging.getLogger(__name__)

_NS = "bgg.check.progress"

# Long enough to outlive the slowest plausible check — eight batches each
# burning their full 5+10+20s warm-up backoff is ~4 minutes — and short enough
# that an abandoned record cannot be mistaken for a live one on the next visit.
_TTL_SECONDS = 300.0

# One entry per user in flight. A check 409s while another check, an import or
# a push is running, so a user can only ever have one.
cache.configure(_NS, max_entries=500)


def _now() -> datetime:
    return datetime.now(timezone.utc)


class BggCheckProgress:
    """The ledger for one comparison. Writes are dict assignments, never I/O.

    Every mutator ends in `_flush()`, which republishes the whole snapshot
    under the user's key. Rewriting the entry each time (rather than mutating
    one in place) keeps the cached value immutable from a reader's point of
    view: a poll either sees the previous phase or the next one, never a
    half-updated step list.
    """

    def __init__(self, user_id: str, *, kind: str = "check") -> None:
        self.user_id = user_id
        self.kind = kind
        self.check_id = uuid.uuid4().hex
        self.started_at = _now()
        self.state = BggCheckState.RUNNING
        self.warm_up_failed = False
        self.error: Optional[str] = None
        # Seeded with every phase up front — see BggCheckPhase's docstring.
        self._steps: dict[str, dict] = {
            phase.value: {
                "key": phase.value,
                "state": BggCheckStepState.IDLE.value,
                "done": None,
                "total": None,
                "detail": None,
                "retry": None,
            }
            for phase in BggCheckPhase
        }
        self._flush()

    # ── Mutators ─────────────────────────────────────────────────────────────

    def begin(
        self,
        phase: BggCheckPhase,
        *,
        total: Optional[int] = None,
        detail: Optional[str] = None,
    ) -> None:
        """Mark `phase` active, and everything before it done.

        Closing the earlier phases here rather than making each caller call a
        matching `end()` is deliberate: the phases are strictly sequential, so
        "we are on CATALOG" already means SHELF finished. It also means a phase
        that raises leaves its own row active — which is exactly where the user
        should see the failure.
        """
        step = self._steps[phase.value]
        step["state"] = BggCheckStepState.ACTIVE.value
        step["total"] = total
        step["done"] = 0 if total is not None else None
        step["detail"] = detail
        step["retry"] = None
        for earlier in BggCheckPhase:
            if earlier is phase:
                break
            prior = self._steps[earlier.value]
            if prior["state"] == BggCheckStepState.ACTIVE.value:
                prior["state"] = BggCheckStepState.DONE.value
                prior["retry"] = None
                if prior["total"] is not None:
                    prior["done"] = prior["total"]
        self._flush()

    def tick(
        self, phase: BggCheckPhase, done: int, *, detail: Optional[str] = None
    ) -> None:
        """Advance the counter on an active phase."""
        step = self._steps[phase.value]
        step["done"] = done
        if detail is not None:
            step["detail"] = detail
        # A tick means the request that was retrying has landed.
        step["retry"] = None
        self._flush()

    def retry(
        self, phase: BggCheckPhase, *, attempt: int, of: int, wait_seconds: float
    ) -> None:
        """BoardGameGeek said "still preparing" — the same batch is going again.

        Represented on the step rather than as a step of its own, because that
        is what it is. `resume_at` is sent so the FE counts down against a real
        timestamp instead of starting its own timer a poll-interval late.
        """
        step = self._steps[phase.value]
        step["retry"] = {
            "attempt": attempt,
            "of": of,
            "wait_seconds": wait_seconds,
            "resume_at": _now().timestamp() + wait_seconds,
        }
        self._flush()

    def skip(self, phase: BggCheckPhase, *, detail: Optional[str] = None) -> None:
        """This phase was not needed — a shelf with nothing to add skips COLLIDS."""
        step = self._steps[phase.value]
        step["state"] = BggCheckStepState.SKIPPED.value
        step["detail"] = detail
        step["retry"] = None
        self._flush()

    def finish(self) -> None:
        for step in self._steps.values():
            if step["state"] == BggCheckStepState.ACTIVE.value:
                step["state"] = BggCheckStepState.DONE.value
                step["retry"] = None
                if step["total"] is not None:
                    step["done"] = step["total"]
        self.state = BggCheckState.DONE
        self._flush()

    def fail(self, message: str) -> None:
        self.state = BggCheckState.FAILED
        self.error = message[:300]
        self._flush()

    def note_warm_up_failure(self) -> None:
        """A batch exhausted its retries and returned zero items."""
        self.warm_up_failed = True
        self._flush()

    # ── Serialisation ────────────────────────────────────────────────────────

    def snapshot(self) -> dict:
        return {
            "state": self.state.value,
            "kind": self.kind,
            "check_id": self.check_id,
            "started_at": self.started_at,
            "updated_at": _now(),
            "steps": [dict(self._steps[p.value]) for p in BggCheckPhase],
            "warm_up_failed": self.warm_up_failed,
            "error": self.error,
        }

    def _flush(self) -> None:
        try:
            cache.set(_NS, self.user_id, self.snapshot(), ttl_seconds=_TTL_SECONDS)
        except Exception as exc:  # noqa: BLE001 — narration must never fail a check
            logger.warning("BGG check progress write failed for %s: %s", self.user_id, exc)


class NullProgress(BggCheckProgress):
    """Every method a no-op, for callers that do not want to be watched.

    Exists so the plumbing below can be unconditional — `progress.tick(...)`
    with no `if progress is not None` at four call sites inside a throttled
    loop — while `build_plan`'s default stays "report nothing".
    """

    def __init__(self) -> None:  # noqa: D107 — deliberately does not call super()
        self.user_id = ""
        self.kind = "null"
        self.check_id = ""
        self.started_at = _now()
        self.state = BggCheckState.RUNNING
        self.warm_up_failed = False
        self.error = None
        self._steps = {}

    def begin(self, phase, *, total=None, detail=None) -> None: return None
    def tick(self, phase, done, *, detail=None) -> None: return None
    def retry(self, phase, *, attempt, of, wait_seconds) -> None: return None
    def skip(self, phase, *, detail=None) -> None: return None
    def finish(self) -> None: return None
    def fail(self, message: str) -> None: return None
    def note_warm_up_failure(self) -> None: return None
    def _flush(self) -> None: return None


def read(user_id: str) -> Optional[dict]:
    """The latest snapshot for a user, or None when there is no record."""
    return cache.get(_NS, user_id)


def clear(user_id: str) -> None:
    cache.delete(_NS, user_id)
