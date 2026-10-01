"""A rulebook link is a chapter that is gated, and the gate is per reader.

A game's rulebook is a `layout='rulebook_link'` chapter, not an
admin-curated column on the games row. That buys open authoring, and open
authoring on an OUTBOUND LINK is only safe with a gate: `moderation_status` on
the row, and one function deciding who may see a row in which state.

What this file pins is that function and the two write paths that set it,
because every other read path in the API just calls
`chapter_rulebook.filter_visible` and inherits whatever it decides:

  * the VISIBILITY MATRIX — approved is public; pending and denied reach the
    author and admins alone.
  * EVERY LINK A NON-ADMIN WRITES IS PENDING, and an admin's own link is
    approved on write, stamped with that admin.
  * EDITING THE URL RE-OPENS THE GATE. An approval is a decision about a
    destination, not about a row — without this, an author could get an
    innocuous PDF approved and then point the approved row anywhere. An
    unchanged URL leaves the status alone.
  * the URL is validated where a person can read the complaint, and the scheme
    is http(s) only. `javascript:` is not an edge case here, it is the reason
    the CHECK constraint duplicates this test in the database.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from routes import chapter_routes as C  # noqa: E402
from routes import rulebook_admin_routes as A  # noqa: E402
from routes.constants import ChapterLayout, RulebookStatus  # noqa: E402
from routes.dependencies import CurrentUser  # noqa: E402
from routes.models import ChapterCreate, ChapterUpdate  # noqa: E402
from routes.services import chapter_rulebook as R  # noqa: E402


AUTHOR = "user-author"
BUDDY = "user-buddy"
STRANGER = "user-stranger"


def _link(status=RulebookStatus.PENDING, created_by=AUTHOR, **extra):
    row = {
        "id": extra.pop("id", "chapter-1"),
        "layout": str(ChapterLayout.RULEBOOK_LINK),
        "chapter_type": "rulebook",
        "link_url": "https://example.com/rules.pdf",
        "moderation_status": str(status) if status is not None else None,
        "created_by": created_by,
    }
    row.update(extra)
    return row


def _prose():
    return {
        "id": "chapter-prose",
        "layout": "text",
        "chapter_type": "setup",
        "link_url": None,
        "moderation_status": None,
        "created_by": STRANGER,
    }


# ── A fake Supabase, small enough to read ────────────────────────────────────
#
# Same posture as tests/test_play_teams.py: a purpose-built stub per test file
# rather than a shared mock framework, so what a handler returns sits next to
# the assertion about it.

class _Q:
    def __init__(self, sb, table):
        self.sb = sb
        self.table_name = table
        self.op = None
        self.payload = None
        self.filters = {}

    def select(self, *_a, **_k):
        self.op = self.op or "select"
        return self

    def insert(self, row):
        self.op = "insert"
        self.payload = row
        return self

    def update(self, row):
        self.op = "update"
        self.payload = row
        return self

    def eq(self, col, val):
        self.filters[col] = val
        return self

    def in_(self, col, vals):
        self.filters[col] = list(vals)
        return self

    def or_(self, expr):
        self.filters["or"] = expr
        return self

    def limit(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def execute(self):
        self.sb.calls.append((self.table_name, self.op, dict(self.filters), self.payload))
        data = self.sb.handle(self)
        return type("R", (), {"data": data, "count": len(data or [])})()


class _SB:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def table(self, name):
        return _Q(self, name)

    def handle(self, q):
        return self.handler(q) or []

    def hits(self, table, op=None):
        return [c for c in self.calls if c[0] == table and (op is None or c[1] == op)]


# ── The visibility matrix ────────────────────────────────────────────────────

@pytest.mark.parametrize("status, viewer, visible", [
    # Approved reaches everyone, including a signed-out reader.
    (RulebookStatus.APPROVED, STRANGER, True),
    (RulebookStatus.APPROVED, BUDDY, True),
    (RulebookStatus.APPROVED, None, True),
    # Pending reaches its author and nobody else — a buddy included.
    (RulebookStatus.PENDING, AUTHOR, True),
    (RulebookStatus.PENDING, BUDDY, False),
    (RulebookStatus.PENDING, STRANGER, False),
    (RulebookStatus.PENDING, None, False),
    # Denied reaches its author, so they can see it was looked at rather than
    # lost, and nobody else.
    (RulebookStatus.DENIED, AUTHOR, True),
    (RulebookStatus.DENIED, BUDDY, False),
    (RulebookStatus.DENIED, STRANGER, False),
    (RulebookStatus.DENIED, None, False),
])
def test_who_sees_a_rulebook_link(status, viewer, visible):
    assert R.is_visible_to(_link(status), viewer) is visible


def test_a_status_that_cannot_exist_is_read_as_pending():
    """The safe reading of an impossible row is the closed one."""
    row = _link(status=None)
    assert R.is_visible_to(row, STRANGER) is False
    assert R.is_visible_to(row, AUTHOR) is True
    assert R.gate_status(row) is RulebookStatus.PENDING


@pytest.mark.parametrize("raw", ["unlisted", "some-future-state"])
def test_a_status_this_code_does_not_know_is_also_read_as_pending(raw):
    """`RulebookStatus(raw)` raises, and an uncaught raise on a read path every
    guide mount runs is a 500 on the whole scroll. 'unlisted' is the value a
    row holds until the auto-review migration has run."""
    row = _link()
    row["moderation_status"] = raw
    assert R.gate_status(row) is RulebookStatus.PENDING
    assert R.is_visible_to(row, STRANGER) is False
    assert R.is_visible_to(row, AUTHOR) is True


def test_an_admin_sees_every_link_whatever_its_state():
    """A queue that hides its own items is not a queue."""
    for status in (RulebookStatus.PENDING, RulebookStatus.DENIED):
        assert R.is_visible_to(_link(status), STRANGER, is_admin=True) is True


def test_every_other_chapter_passes_through_untouched():
    """The gate is one layout's. Callers hand it mixed lists on purpose."""
    assert R.is_visible_to(_prose(), None) is True


def test_a_row_claiming_the_type_but_not_the_layout_is_still_gated():
    """Read defensively off either column — the mirror of the frontend's own
    isRulebook, and what stops a mismatched row slipping past the gate."""
    row = _link()
    row["layout"] = "text"
    assert R.is_rulebook_row(row) is True
    assert R.is_visible_to(row, STRANGER) is False


# ── filter_visible ───────────────────────────────────────────────────────────

def test_filter_drops_only_what_the_viewer_may_not_see():
    rows = [
        _prose(),
        _link(RulebookStatus.APPROVED, id="approved"),
        _link(RulebookStatus.PENDING, id="pending"),
        _link(RulebookStatus.DENIED, id="denied"),
    ]
    assert {r["id"] for r in R.filter_visible(rows, BUDDY)} == {
        "chapter-prose", "approved",
    }
    assert {r["id"] for r in R.filter_visible(rows, AUTHOR)} == {
        "chapter-prose", "approved", "pending", "denied",
    }


def test_visible_ids_matches_the_filter():
    rows = [_link(RulebookStatus.APPROVED, id="approved"), _link(id="pending")]
    assert R.visible_ids(rows, STRANGER) == {"approved"}
    assert R.visible_ids(rows, STRANGER, is_admin=True) == {"approved", "pending"}


# ── The URL ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw", [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://example.com/rules.pdf",
    "example.com/rules.pdf",
    "",
    "   ",
    None,
])
def test_a_url_that_is_not_http_is_refused(raw):
    with pytest.raises(HTTPException) as e:
        R.clean_url(raw)
    assert e.value.status_code == 400


def test_a_url_longer_than_any_browser_carries_is_refused():
    R.clean_url("https://e.com/" + "a" * (R.MAX_RULEBOOK_URL_CHARS - 14))  # the boundary
    with pytest.raises(HTTPException):
        R.clean_url("https://e.com/" + "a" * R.MAX_RULEBOOK_URL_CHARS)


def test_a_url_is_trimmed_and_otherwise_left_exactly_as_pasted():
    """No lower-casing (paths are case-sensitive), no trailing-slash surgery:
    an app that quietly rewrites a link is one that eventually breaks one."""
    assert R.clean_url("  https://Example.com/Rules.PDF  ") == "https://Example.com/Rules.PDF"


def test_the_title_is_derived_from_the_game_and_never_typed():
    assert R.rulebook_title("Everdell") == "Everdell rulebook"
    assert R.rulebook_title("  Everdell  ") == "Everdell rulebook"
    # The fallback matters: `title` is NOT NULL and the pool searches it.
    assert R.rulebook_title(None) == "Rulebook"
    assert R.rulebook_title("   ") == "Rulebook"


def test_content_mirrors_the_url_as_a_working_link():
    """A client that has never heard of this layout renders `content`, so the
    mirror is a markdown link rather than a bare URL."""
    assert R.url_to_content("https://e.com/r.pdf") == "[Rulebook](https://e.com/r.pdf)"


# ── Layout and type move together ────────────────────────────────────────────

def test_the_layout_and_the_type_must_agree_in_both_directions():
    R.validate_layout_pairing(ChapterLayout.RULEBOOK_LINK, "rulebook")   # fine
    R.validate_layout_pairing(ChapterLayout.TEXT, "setup")               # fine
    with pytest.raises(HTTPException):
        R.validate_layout_pairing(ChapterLayout.RULEBOOK_LINK, "tips")
    with pytest.raises(HTTPException):
        # The half that is easy to forget: a 'rulebook' chapter holding prose
        # carries NO moderation status at all, because the gate hangs off the
        # layout.
        R.validate_layout_pairing(ChapterLayout.TEXT, "rulebook")


def test_the_gate_a_new_link_opens_at_follows_the_writers_role():
    assert R.initial_status(False) is RulebookStatus.PENDING
    assert R.initial_status(True) is RulebookStatus.APPROVED


def test_gate_columns_stamp_an_admin_and_leave_anybody_else_undecided():
    assert R.gate_columns(AUTHOR, False) == {
        "moderation_status": "pending", "moderated_by": None, "moderated_at": None,
    }
    assert R.gate_columns("admin-1", True) == {
        "moderation_status": "approved",
        "moderated_by": "admin-1",
        "moderated_at": "now()",
    }


# ── The create path ──────────────────────────────────────────────────────────

def _create_sb(existing_mine=None):
    """A Supabase that answers the six round trips _create_chapter_sync makes."""
    def handler(q):
        if q.table_name == "boardgamebuddy_games":
            return [{"id": "game-1", "name": "Everdell", "is_expansion": False}]
        if q.table_name == "boardgamebuddy_chapter_types":
            return [{"id": "rulebook"}]
        if q.table_name == "boardgamebuddy_guide_chapters":
            if q.op == "insert":
                return [{"id": "chapter-new"}]
            if "created_by" in q.filters:          # the one-per-author check
                return existing_mine or []
            return [{                              # the read-back
                "id": "chapter-new",
                "game_id": "game-1",
                "chapter_type": "rulebook",
                "title": "Everdell rulebook",
                "layout": str(ChapterLayout.RULEBOOK_LINK),
                "content": "[Rulebook](https://example.com/rules.pdf)",
                "grid": None,
                "link_url": "https://example.com/rules.pdf",
                "moderation_status": str(RulebookStatus.PENDING),
                "created_by": AUTHOR,
                "updated_at": "2026-09-20T00:00:00Z",
                "created_at": "2026-09-20T00:00:00Z",
            }]
        if q.table_name == "boardgamebuddy_user_chapters":
            return [{"created_at": "2026-09-20T00:00:00Z"}]
        return []
    return _SB(handler)


def _body(url="  https://example.com/rules.pdf  ", **extra):
    return ChapterCreate(
        chapter_type="rulebook",
        layout=ChapterLayout.RULEBOOK_LINK,
        link_url=url,
        **extra,
    )


def _user(user_id=AUTHOR, is_admin=False):
    return CurrentUser(
        user_id=user_id, display_name="A", username="a", is_admin=is_admin
    )


def _inserted_chapter(sb):
    return next(
        c[3] for c in sb.calls
        if c[0] == "boardgamebuddy_guide_chapters" and c[1] == "insert"
    )


def test_a_submitted_link_is_stored_pending_with_a_derived_title_and_mirror():
    sb = _create_sb()
    C._create_chapter_sync(sb, "game-1", _body(), _user())
    row = _inserted_chapter(sb)
    assert row["moderation_status"] == str(RulebookStatus.PENDING)
    assert row["moderated_by"] is None and row["moderated_at"] is None
    assert row["link_url"] == "https://example.com/rules.pdf"     # trimmed
    assert row["title"] == "Everdell rulebook"                    # derived
    assert row["content"] == "[Rulebook](https://example.com/rules.pdf)"
    assert row["grid"] is None


def test_an_old_client_still_sending_request_review_is_not_refused():
    """The field is gone from the model, and Pydantic ignores an unknown key
    rather than 422ing — so the link is still submitted, as pending."""
    sb = _create_sb()
    C._create_chapter_sync(sb, "game-1", _body(request_review=False), _user())
    assert _inserted_chapter(sb)["moderation_status"] == str(RulebookStatus.PENDING)
    assert not hasattr(_body(request_review=True), "request_review")


def test_an_admins_own_link_is_approved_and_stamped():
    sb = _create_sb()
    C._create_chapter_sync(sb, "game-1", _body(), _user("admin-1", is_admin=True))
    row = _inserted_chapter(sb)
    assert row["moderation_status"] == str(RulebookStatus.APPROVED)
    assert row["moderated_by"] == "admin-1"
    assert row["moderated_at"] == "now()"


def test_a_prose_chapter_carries_no_gate():
    """bgb_chapters_link_shape requires all three columns NULL off the layout."""
    sb = _create_sb()
    C._create_chapter_sync(
        sb, "game-1",
        ChapterCreate(chapter_type="setup", title="t", content="x"),
        _user(),
    )
    row = _inserted_chapter(sb)
    assert row["moderation_status"] is None
    assert row["moderated_by"] is None and row["moderated_at"] is None


def test_a_second_link_for_the_same_game_is_refused_rather_than_stacked():
    """One link per (game, author) — idx_bgb_chapters_rulebook_author. This is
    what turns that index into a sentence instead of a 500."""
    sb = _create_sb(existing_mine=[{"id": "c0", "moderation_status": "pending"}])
    with pytest.raises(HTTPException) as e:
        C._create_chapter_sync(sb, "game-1", _body(), _user())
    assert e.value.status_code == 409
    assert sb.hits("boardgamebuddy_guide_chapters", "insert") == []


def test_a_denied_link_still_holds_the_slot():
    """A denial is not a delete: re-posting the same link under a new row must
    not be the way around a decision, and the message says what to do instead."""
    sb = _create_sb(existing_mine=[{"id": "c0", "moderation_status": "denied"}])
    with pytest.raises(HTTPException) as e:
        C._create_chapter_sync(sb, "game-1", _body(), _user())
    assert e.value.status_code == 409
    assert "turned down" in e.value.detail


def test_a_bad_url_never_reaches_the_database():
    sb = _create_sb()
    with pytest.raises(HTTPException) as e:
        C._create_chapter_sync(sb, "game-1", _body("javascript:alert(1)"), _user())
    assert e.value.status_code == 400
    assert sb.hits("boardgamebuddy_guide_chapters", "insert") == []


def test_the_model_refuses_a_link_on_any_other_layout():
    """The mirror of the grid rule, and what keeps a stale client from writing a
    URL onto a prose chapter — where nothing would ever gate it."""
    with pytest.raises(Exception):
        ChapterCreate(chapter_type="setup", content="x", title="t",
                      link_url="https://e.com")
    with pytest.raises(Exception):
        ChapterCreate(chapter_type="rulebook",
                      layout=ChapterLayout.RULEBOOK_LINK)  # no link_url


# ── The edit path ────────────────────────────────────────────────────────────

def _update_sb(current_url, status=RulebookStatus.APPROVED):
    def handler(q):
        if q.table_name == "boardgamebuddy_guide_chapters":
            if q.op == "update":
                return [{"id": "chapter-1"}]
            return [{
                "id": "chapter-1",
                "game_id": "game-1",
                "created_by": AUTHOR,
                "chapter_type": "rulebook",
                "layout": str(ChapterLayout.RULEBOOK_LINK),
                "link_url": current_url,
                "moderation_status": str(status),
                "title": "Everdell rulebook",
                "content": f"[Rulebook]({current_url})",
                "grid": None,
                "updated_at": "2026-09-20T00:00:00Z",
                "created_at": "2026-09-20T00:00:00Z",
            }]
        if q.table_name == "boardgamebuddy_games":
            return [{"name": "Everdell", "is_expansion": False}]
        return []
    return _SB(handler)


def _updated(sb):
    return next(
        c[3] for c in sb.calls
        if c[0] == "boardgamebuddy_guide_chapters" and c[1] == "update"
    )


def test_pointing_an_approved_link_somewhere_new_re_opens_the_gate():
    """An approval is a decision about a DESTINATION. Without this, an author
    gets an innocuous PDF approved and then points the approved row anywhere."""
    sb = _update_sb("https://example.com/old.pdf")
    C._update_chapter_sync(
        sb, "chapter-1",
        ChapterUpdate(link_url="https://elsewhere.test/new.pdf"),
        _user(),
    )
    row = _updated(sb)
    assert row["moderation_status"] == str(RulebookStatus.PENDING)
    assert row["link_url"] == "https://elsewhere.test/new.pdf"
    assert row["content"] == "[Rulebook](https://elsewhere.test/new.pdf)"
    assert row["title"] == "Everdell rulebook"      # re-derived on every save


def test_saving_the_same_url_again_leaves_an_approval_alone():
    """Re-submitting the form without changing anything must not send an
    approved link back to the queue."""
    sb = _update_sb("https://example.com/rules.pdf")
    C._update_chapter_sync(
        sb, "chapter-1",
        ChapterUpdate(link_url="  https://example.com/rules.pdf "),
        _user(),
    )
    assert "moderation_status" not in _updated(sb)


def test_an_admin_pointing_a_link_somewhere_new_approves_it_again():
    """An admin's edit is their decision about the new destination, so it is
    stamped with them rather than sent to the queue they would work."""
    sb = _update_sb("https://example.com/old.pdf")
    C._update_chapter_sync(
        sb, "chapter-1",
        ChapterUpdate(link_url="https://elsewhere.test/new.pdf"),
        _user(is_admin=True),
    )
    row = _updated(sb)
    assert row["moderation_status"] == str(RulebookStatus.APPROVED)
    assert row["moderated_by"] == AUTHOR
    assert row["moderated_at"] == "now()"


def test_an_admin_saving_the_same_url_leaves_the_status_alone():
    sb = _update_sb("https://example.com/rules.pdf", status=RulebookStatus.PENDING)
    C._update_chapter_sync(
        sb, "chapter-1",
        ChapterUpdate(link_url="https://example.com/rules.pdf"),
        _user(is_admin=True),
    )
    assert "moderation_status" not in _updated(sb)


def test_re_opening_the_gate_clears_the_last_decisions_author():
    """`moderated_by` names who decided THIS row. Leaving the last admin on a
    link they have not seen is a lie the audit trail cannot tell apart from a
    real decision."""
    sb = _update_sb("https://example.com/old.pdf", status=RulebookStatus.APPROVED)
    C._update_chapter_sync(
        sb, "chapter-1",
        ChapterUpdate(link_url="https://elsewhere.test/new.pdf"),
        _user(),
    )
    row = _updated(sb)
    assert row["moderated_by"] is None
    assert row["moderated_at"] is None


def test_a_denied_link_saved_again_unchanged_stays_denied():
    """The way to answer a denial is a different URL, not the same one again."""
    sb = _update_sb("https://example.com/rules.pdf", status=RulebookStatus.DENIED)
    C._update_chapter_sync(
        sb, "chapter-1",
        ChapterUpdate(link_url="https://example.com/rules.pdf"),
        _user(),
    )
    assert "moderation_status" not in _updated(sb)


def test_a_denied_link_given_a_new_url_goes_back_to_the_queue():
    sb = _update_sb("https://example.com/old.pdf", status=RulebookStatus.DENIED)
    C._update_chapter_sync(
        sb, "chapter-1",
        ChapterUpdate(link_url="https://elsewhere.test/new.pdf"),
        _user(),
    )
    assert _updated(sb)["moderation_status"] == str(RulebookStatus.PENDING)


def test_an_unlisted_row_saved_unchanged_is_rewritten_as_pending():
    """A row the auto-review migration has not reached yet is judged pending,
    and the first save stores it that way."""
    sb = _update_sb("https://example.com/rules.pdf", status="unlisted")
    C._update_chapter_sync(
        sb, "chapter-1",
        ChapterUpdate(link_url="https://example.com/rules.pdf"),
        _user(),
    )
    assert _updated(sb)["moderation_status"] == str(RulebookStatus.PENDING)


def test_an_old_client_still_sending_request_review_on_edit_is_not_refused():
    sb = _update_sb("https://example.com/rules.pdf", status=RulebookStatus.APPROVED)
    C._update_chapter_sync(
        sb, "chapter-1",
        ChapterUpdate(link_url="https://example.com/rules.pdf", request_review=False),
        _user(),
    )
    assert "moderation_status" not in _updated(sb)


# ── The admin queue ──────────────────────────────────────────────────────────

def _moderate_sb(layout=str(ChapterLayout.RULEBOOK_LINK), status=RulebookStatus.PENDING):
    def handler(q):
        if q.table_name == "boardgamebuddy_guide_chapters":
            if q.op == "update":
                return [{"id": "chapter-1"}]
            return [{"id": "chapter-1", "layout": layout,
                     "moderation_status": str(status)}]
        return []
    return _SB(handler)


@pytest.mark.parametrize("decision", [RulebookStatus.APPROVED, RulebookStatus.DENIED])
def test_a_decision_is_stamped_with_the_admin_who_made_it(decision):
    sb = _moderate_sb()
    out = A._moderate_rulebook_link_sync(sb, "chapter-1", decision, "admin-1")
    assert out.moderation_status is decision
    row = _updated(sb)
    assert row["moderation_status"] == str(decision)
    assert row["moderated_by"] == "admin-1"


def test_a_decision_does_not_touch_the_chapters_edit_clock():
    """`updated_at` is what every client cache keys on, and a moderation
    decision does not change what the chapter says. Touching it would
    invalidate every cached guide on every approval."""
    sb = _moderate_sb()
    A._moderate_rulebook_link_sync(sb, "chapter-1", RulebookStatus.APPROVED, "admin-1")
    assert "updated_at" not in _updated(sb)


@pytest.mark.parametrize("current", [RulebookStatus.APPROVED, RulebookStatus.DENIED])
@pytest.mark.parametrize("decision", [RulebookStatus.APPROVED, RulebookStatus.DENIED])
def test_a_decided_link_can_be_decided_again(current, decision):
    """Approve undoes a denial and deny withdraws an approval."""
    sb = _moderate_sb(status=current)
    out = A._moderate_rulebook_link_sync(sb, "chapter-1", decision, "admin-1")
    assert out.moderation_status is decision
    assert _updated(sb)["moderation_status"] == str(decision)


def test_only_a_rulebook_link_can_be_moderated_through_this_queue():
    """Prose is moderated by the reports queue. A 400 is what stops a client
    confusing the two."""
    sb = _moderate_sb(layout="text")
    with pytest.raises(HTTPException) as e:
        A._moderate_rulebook_link_sync(sb, "chapter-1", RulebookStatus.DENIED, "admin-1")
    assert e.value.status_code == 400


def test_the_queue_shows_where_a_link_actually_goes():
    """The host is what an admin decides on, and it is the part a lookalike
    domain hides at the end of a long URL."""
    assert A._link_host("https://boardgamegeek.com/a/b?c=1#d") == "boardgamegeek.com"
    assert A._link_host("http://example.test") == "example.test"
    # Unparseable input falls back to the URL rather than taking the queue down
    # over exactly the rows it exists to show.
    assert A._link_host("nonsense") == "nonsense"
