"""The shared ledger base must not have changed anyone's wire shape.

`bgg_progress` and `bga_progress` were each a full copy of the same class
before `step_progress.StepLedger` existed. Extracting it is invisible from
outside only if every key each one published still comes out, under the same
name — the BGG check's live page reads `check_id` and `warm_up_failed`, the BGA
wizard reads `fetch_id` and `truncated`, and neither would fail loudly if a key
quietly went missing: the FE would just render a checklist that never finishes.

So this asserts the snapshots against the response models that describe them,
which is the only definition of the contract that the API actually serves.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402

import cache  # noqa: E402
from routes.constants import (  # noqa: E402
    BgaFetchPhase,
    BggCheckPhase,
    BggCheckState,
    BggCheckStepState,
    RunState,
    RunStepState,
)
from routes.models import BgaFetchProgressResponse, BggCheckProgressResponse  # noqa: E402
from routes.services import bga_progress, bgg_progress  # noqa: E402


@pytest.fixture(autouse=True)
def _clean():
    cache.clear(bgg_progress._NS)
    cache.clear(bga_progress._NS)
    yield
    cache.clear(bgg_progress._NS)
    cache.clear(bga_progress._NS)


def test_the_two_state_vocabularies_are_one_vocabulary():
    """Aliases, not a rename: forty-odd call sites import the Bgg* names."""
    assert BggCheckState is RunState
    assert BggCheckStepState is RunStepState


def test_the_bgg_check_snapshot_still_fills_its_response_model():
    prog = bgg_progress.BggCheckProgress("u1")
    prog.begin(BggCheckPhase.COLLECTION, total=8)
    prog.tick(BggCheckPhase.COLLECTION, 3, detail="Owned · 1")
    prog.retry(BggCheckPhase.COLLECTION, attempt=1, of=3, wait_seconds=5.0)
    prog.note_warm_up_failure()

    snap = bgg_progress.read("u1")
    # Every field the model declares, present and of the right shape.
    parsed = BggCheckProgressResponse(**snap)
    assert parsed.check_id == prog.check_id
    assert parsed.kind == "check"
    assert parsed.warm_up_failed is True
    assert parsed.state is RunState.RUNNING
    assert [s.key for s in parsed.steps] == list(BggCheckPhase)
    step = next(s for s in parsed.steps if s.key is BggCheckPhase.COLLECTION)
    assert (step.done, step.total, step.detail) == (3, 8, "Owned · 1")
    assert step.retry is not None and (step.retry.attempt, step.retry.of) == (1, 3)
    # The user's own key is still readable under the name its callers use.
    assert prog.user_id == "u1"


def test_the_bgg_push_plan_ledger_keeps_its_kind():
    prog = bgg_progress.BggCheckProgress("u1", kind="push_plan")
    assert BggCheckProgressResponse(**bgg_progress.read("u1")).kind == "push_plan"


def test_the_bga_sweep_snapshot_still_fills_its_response_model():
    prog = bga_progress.BgaFetchProgress("u2")
    prog.begin(next(iter(BgaFetchPhase)), total=4)
    prog.note_truncated()

    parsed = BgaFetchProgressResponse(**bga_progress.read("u2"))
    assert parsed.fetch_id == prog.fetch_id
    assert parsed.truncated is True
    assert [s.key for s in parsed.steps] == list(BgaFetchPhase)
    assert prog.user_id == "u2"

    bga_progress.clear("u2")
    assert bga_progress.read("u2") is None


def test_a_muted_ledger_publishes_nothing_for_either_feature():
    """`build_plan` and the BGA sweep both default to "report nothing", and
    every call site calls the mutators unconditionally."""
    null = bgg_progress.NullProgress()
    null.begin(BggCheckPhase.GUARDS, total=2)
    null.tick(BggCheckPhase.GUARDS, 1)
    null.retry(BggCheckPhase.GUARDS, attempt=1, of=3, wait_seconds=5.0)
    null.skip(BggCheckPhase.COLLIDS)
    null.note_warm_up_failure()
    null.fail("nope")
    assert bgg_progress.read("") is None

    bga_null = bga_progress.NullProgress()
    bga_null.begin(next(iter(BgaFetchPhase)))
    bga_null.note_truncated()
    bga_null.finish()
    assert bga_progress.read("") is None
