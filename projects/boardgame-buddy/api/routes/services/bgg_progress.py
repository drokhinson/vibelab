"""Live progress for a BGG comparison, so the FE can narrate a 40-second wait.

POST /bgg/check does eight throttled BoardGameGeek calls, two Supabase reads
and up to eight more BGG calls before it can answer. From the browser that is
one promise that resolves in somewhere between ten seconds and two minutes, and
a spinner is indistinguishable from a hang. This module is the ledger the
handler writes as it goes, and GET /bgg/check/progress reads.

The mechanics live in `step_progress.StepLedger` — seeding, `begin`/`tick`/
`skip`/`finish`/`fail`, and the republish-the-whole-snapshot rule. What stays
here is what is true of THIS run and no other: its phases, its namespace, and
the two things below.

WHY THE IN-PROCESS CACHE AND NOT A TABLE. The sweep is *in-handler* work —
`build_plan` is awaited inside `check_bgg` before it can respond — so a restart
kills the sweep, the client's connection and the result together. A record that
died with them is correct. A durable row would outlive all three and sit there
claiming "batch 5 of 8, 4s ago" about work that no longer exists anywhere, and
the FE would need a staleness heuristic to un-lie. Durability is the wrong
property here.

The contrast proves the rule rather than breaking it: the catalog fill and the
push queue ARE BackgroundTasks that outlive the response, and they use DB queue
tables with session anchors precisely because they have to. So do the admin
catalog runs in `admin_run_progress.py`, which is the same ledger with the
opposite TTL argument — read its docstring before assuming the two agree.

SINGLE WORKER: see `step_progress.py`.
"""

from ..constants import BggCheckPhase
from .step_progress import StepLedger

_NS = "bgg.check.progress"

# Long enough to outlive the slowest plausible check — eight batches each
# burning their full 5+10+20s warm-up backoff is ~4 minutes — and short enough
# that an abandoned record cannot be mistaken for a live one on the next visit.
_TTL_SECONDS = 300.0


class BggCheckProgress(StepLedger):
    """The ledger for one comparison, keyed by user.

    One entry per user in flight: a check 409s while another check, an import
    or a push is running, so a user can only ever have one.
    """

    NAMESPACE = _NS
    TTL_SECONDS = _TTL_SECONDS
    PHASES = BggCheckPhase
    ID_KEY = "check_id"

    def __init__(self, user_id: str, *, kind: str = "check", muted: bool = False) -> None:
        # Set before super(), which flushes a snapshot that reads both.
        self.kind = kind
        self.warm_up_failed = False
        super().__init__(user_id, muted=muted)

    @property
    def user_id(self) -> str:
        """The cache key, under the name four call sites already use."""
        return self.key

    @property
    def check_id(self) -> str:
        return self.run_id

    def note_warm_up_failure(self) -> None:
        """A batch exhausted its retries and returned zero items, so the sweep
        is partial: importing is still safe, pushing is not."""
        self.warm_up_failed = True
        self._flush()

    def _extra(self) -> dict:
        return {"kind": self.kind, "warm_up_failed": self.warm_up_failed}


class NullProgress(BggCheckProgress):
    """A ledger that publishes nothing, for callers that do not want to be
    watched — `build_plan`'s default is "report nothing".

    Muted rather than a pile of no-op overrides: every mutator still runs, so
    this cannot drift out of step with the real class the way an overridden
    `tick(self, phase, done, *, detail=None)` silently did the day the base
    grew a keyword.
    """

    def __init__(self) -> None:
        super().__init__("", kind="null", muted=True)


def read(user_id: str) -> dict | None:
    """The latest snapshot for a user, or None when there is no record."""
    return BggCheckProgress.read(user_id)
