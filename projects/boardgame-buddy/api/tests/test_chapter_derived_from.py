"""A chapter saved as a copy of someone else's records where it came from.

`derived_from` is what the chapters_inspired achievement counts (see
db/tests/chapter_inspiration.sql). The API's part is to store it when the
source exists, store NULL when it does not, and never fail the save over it.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

from routes import chapter_routes as C  # noqa: E402
from routes.constants import ChapterLayout  # noqa: E402
from routes.dependencies import CurrentUser  # noqa: E402
from routes.models import ChapterCreate  # noqa: E402
from tests.test_rulebook_links import _SB  # noqa: E402

SOURCE = "11111111-1111-4111-8111-111111111111"
AUTHOR = "22222222-2222-4222-8222-222222222222"


def _sb(source_exists=True):
    def handler(q):
        if q.table_name == "boardgamebuddy_games":
            return [{"id": "game-1", "name": "Everdell", "is_expansion": False}]
        if q.table_name == "boardgamebuddy_chapter_types":
            return [{"id": "setup"}]
        if q.table_name == "boardgamebuddy_guide_chapters":
            if q.op == "insert":
                return [{"id": "chapter-new"}]
            if q.filters.get("id") == SOURCE:          # the source lookup
                return [{"id": SOURCE}] if source_exists else []
            return [{                                  # the read-back
                "id": "chapter-new",
                "game_id": "game-1",
                "chapter_type": "setup",
                "title": "My setup",
                "layout": str(ChapterLayout.TEXT),
                "content": "Shuffle.",
                "grid": None,
                "link_url": None,
                "moderation_status": None,
                "created_by": AUTHOR,
                "updated_at": "2026-09-29T00:00:00Z",
                "created_at": "2026-09-29T00:00:00Z",
            }]
        if q.table_name == "boardgamebuddy_user_chapters":
            return [{"created_at": "2026-09-29T00:00:00Z"}]
        return []
    return _SB(handler)


def _body(**extra):
    return ChapterCreate(chapter_type="setup", title="My setup", content="Shuffle.", **extra)


def _user():
    return CurrentUser(user_id=AUTHOR, display_name="A", username="a", is_admin=False)


def _inserted(sb):
    return next(
        c[3] for c in sb.calls
        if c[0] == "boardgamebuddy_guide_chapters" and c[1] == "insert"
    )


def test_a_copy_stores_the_chapter_it_came_from():
    sb = _sb()
    C._create_chapter_sync(sb, "game-1", _body(derived_from=SOURCE), _user())
    assert _inserted(sb)["derived_from"] == SOURCE


def test_a_chapter_written_from_scratch_stores_none_and_looks_nothing_up():
    sb = _sb()
    C._create_chapter_sync(sb, "game-1", _body(), _user())
    assert _inserted(sb)["derived_from"] is None
    assert not [
        c for c in sb.calls
        if c[0] == "boardgamebuddy_guide_chapters" and c[2].get("id") == SOURCE
    ]


def test_a_source_deleted_mid_edit_still_saves_the_copy_without_credit():
    sb = _sb(source_exists=False)
    C._create_chapter_sync(sb, "game-1", _body(derived_from=SOURCE), _user())
    assert _inserted(sb)["derived_from"] is None
