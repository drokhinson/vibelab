"""Live progress for a Board Game Arena sweep, so the FE can narrate the wait.

The sibling of `bgg_progress.py`, and its reasoning applies here unchanged —
read that module's docstring first. The short version: this is an IN-PROCESS
ledger and not a queue table, because the sweep is in-handler work, so a
restart kills the sweep, the client's connection and the record together. A
durable row would outlive all three and lie about work that no longer exists.

The mechanics are `step_progress.StepLedger`; what stays here is this sweep's
phases, namespace, TTL and its one extra field.

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

from ..constants import BgaFetchPhase
from .step_progress import StepLedger

_NS = "bga.fetch.progress"

# Long enough to outlive the slowest plausible sweep — BGA_SWEEP_BUDGET_SECONDS
# defaults to 90, and the throttle can stretch a capped run past that — and
# short enough that an abandoned record cannot be mistaken for a live one.
_TTL_SECONDS = 600.0


class BgaFetchProgress(StepLedger):
    """The ledger for one sweep, keyed by user. A second fetch 409s while one
    is running, so there is only ever one entry per user in flight."""

    NAMESPACE = _NS
    TTL_SECONDS = _TTL_SECONDS
    PHASES = BgaFetchPhase
    ID_KEY = "fetch_id"

    def __init__(self, user_id: str, *, muted: bool = False) -> None:
        # Set before super(), which flushes a snapshot that reads it.
        self.truncated = False
        super().__init__(user_id, muted=muted)

    @property
    def user_id(self) -> str:
        """The cache key, under the name the sweep's call sites already use."""
        return self.key

    @property
    def fetch_id(self) -> str:
        return self.run_id

    def note_truncated(self) -> None:
        """A cap was hit; there is older history still on BGA."""
        self.truncated = True
        self._flush()

    def _extra(self) -> dict:
        return {"truncated": self.truncated}


class NullProgress(BgaFetchProgress):
    """Publishes nothing, so the sweep's plumbing can be unconditional. Muted
    rather than per-method no-ops — see bgg_progress.NullProgress."""

    def __init__(self) -> None:
        super().__init__("", muted=True)


def read(user_id: str) -> dict | None:
    """The latest snapshot for a user, or None when this process has none."""
    return BgaFetchProgress.read(user_id)


def clear(user_id: str) -> None:
    """Drop a user's ledger — used when a fetch is abandoned before it runs."""
    BgaFetchProgress.drop(user_id)
