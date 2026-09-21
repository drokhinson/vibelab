"""An embed of profiles from the chapters table must name which FK it means.

Migration 052 gave boardgamebuddy_guide_chapters a SECOND foreign key into
boardgamebuddy_profiles — `moderated_by`, alongside the `created_by` that has
always been there. The moment it landed, every PostgREST embed written as a bare
`boardgamebuddy_profiles(display_name)` stopped resolving: with two candidate
relationships and no hint, PostgREST refuses to guess and returns PGRST201
("Could not embed because more than one relationship was found"), which this API
surfaces as a 500. That took out the whole reference guide — /my-chapters and
every /chapter-pool read, i.e. opening the editor at all — with nothing in the
chapter code changed and nothing in the test suite red, because the suite's
Supabase stand-ins never parse a select string.

So this file reads the two things the stubs can't: the SCHEMA, for how many FKs
actually point at profiles, and the SELECT STRINGS, for whether they say which
one they mean. The requirement is derived rather than hardcoded — drop back to
one FK some day and these tests stop demanding a hint instead of failing for a
rule that no longer applies.

Why the hint is the column and not the constraint name: PostgREST accepts
either, and `created_by` says what it means. The constraint is still called
`boardgamebuddy_guide_chunks_created_by_fkey` — a name from before archive/018
renamed the tables — and a select that quoted it would read as though it joined
some other table entirely.
"""

import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402

from routes.chapter_routes import _CHAPTER_SELECT  # noqa: E402
from routes.rulebook_admin_routes import _REVIEW_SELECT  # noqa: E402


_SCHEMA = os.path.join(
    os.path.dirname(__file__), "..", "..", "db", "schema", "boardgamebuddy.sql"
)

CHAPTERS = "boardgamebuddy_guide_chapters"
PROFILES = "boardgamebuddy_profiles"

# Every select in the API that embeds profiles from the chapters table. Both
# are module-level constants precisely so this file can reach them; keep it
# that way when adding a third.
SELECTS = {
    "chapter_routes._CHAPTER_SELECT": _CHAPTER_SELECT,
    "rulebook_admin_routes._REVIEW_SELECT": _REVIEW_SELECT,
}


def _fk_columns_into_profiles() -> set[str]:
    """Columns on the chapters table that reference profiles, per db/schema/."""
    sql = open(_SCHEMA, encoding="utf-8").read()
    start = sql.index(f"CREATE TABLE IF NOT EXISTS public.{CHAPTERS}")
    # The table body ends at the next CREATE — good enough, and it keeps the
    # other tables' FKs into profiles (there are many) out of the count.
    end = sql.index("CREATE ", start + 1)
    return set(
        re.findall(
            rf"FOREIGN KEY \((\w+)\) REFERENCES {PROFILES}\(", sql[start:end]
        )
    )


def test_chapters_has_several_fks_into_profiles():
    """The premise. If this ever fails, read the module docstring before the
    tests below — a single FK would make the hints optional, not wrong."""
    assert _fk_columns_into_profiles() >= {"created_by", "moderated_by"}


@pytest.mark.parametrize("name", sorted(SELECTS))
def test_profile_embed_names_its_foreign_key(name):
    select = SELECTS[name]
    if len(_fk_columns_into_profiles()) < 2:
        pytest.skip("only one FK into profiles — PostgREST needs no hint")

    # A bare `boardgamebuddy_profiles(` — no `!column` between the table and the
    # paren — is the PGRST201 shape. `profiles!created_by(` is what we want.
    assert not re.search(rf"{PROFILES}\(", select), (
        f"{name} embeds {PROFILES} without saying which FK it means. "
        f"{CHAPTERS} has {len(_fk_columns_into_profiles())} of them, so "
        "PostgREST returns PGRST201 and the request 500s. "
        f"Write `{PROFILES}!created_by(...)`."
    )
    assert f"{PROFILES}!created_by(" in select


@pytest.mark.parametrize("name", sorted(SELECTS))
def test_hint_points_at_a_real_column(name):
    """A hint PostgREST can't resolve fails exactly as loudly as no hint."""
    hints = set(re.findall(rf"{PROFILES}!(\w+)\(", SELECTS[name]))
    assert hints <= _fk_columns_into_profiles()


def test_hinted_embed_keeps_the_plain_table_name_as_its_key():
    """Why neither response mapper needed touching: the `!col` hint disambiguates
    the relationship, it does not alias the result. The JSON key stays
    `boardgamebuddy_profiles`, which is what _chapter_row_to_response and
    _list_rulebook_links_sync read. (An explicit `author:` prefix WOULD rename
    it — that's the form the chapter-reports select uses, and it has a mapper
    reading `reporter` to match.)"""
    for select in SELECTS.values():
        assert not re.search(rf"\w+:{PROFILES}!", select)
