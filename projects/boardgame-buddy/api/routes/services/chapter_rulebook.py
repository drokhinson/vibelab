"""Rulebook-link chapter helpers.

A rulebook link is a `layout='rulebook_link'` chapter whose URL lives in the
typed `link_url` column. `content` is NOT where the URL is stored — it carries a
generated markdown mirror of it, `[Rulebook](https://…)`, for exactly the three
readers services/chapter_grid.py lists for the grid's mirror:

  * the chapter pool ILIKE-searches `content`, so a reader looking for
    "fantasyflight" finds the link that points there;
  * the moderation queue slices `content[:240]` into its preview;
  * three client surfaces feed `content` to renderMarkdown, so a client that has
    never heard of this layout still renders a working link rather than nothing.

The mirror is regenerated on every save and never hand-edited: `link_url` is the
source of truth.

WHAT IS DIFFERENT FROM EVERY OTHER CHAPTER: this is the one chapter body the
app did not write. Following it takes a reader off this origin and onto
somebody else's server, so it carries a gate — `moderation_status` — that no
other chapter has, and the gate is only worth anything if EVERY read path
applies it. That is what `is_visible_to` and `filter_visible` below are for,
and why they take a viewer rather than being a query filter: the author of a
denied link sees it where nobody else does.

Every link a non-admin writes is visible to everyone at once and goes to the
admin queue as `pending`; an admin's own link is approved on write
(`initial_status`, `gate_columns`). A denial hides it from all but its author.
"""

import re
from typing import Any, Iterable, Optional

from fastapi import HTTPException

from ..constants import ChapterLayout, RulebookStatus

# The chapter type a rulebook link must be filed under, seeded in
# boardgamebuddy_chapter_types at display_order 6. The type and the layout are 1:1 and each holds half the
# truth — the type says the chapter IS the rulebook, the layout says its body is
# a URL in `link_url` rather than markdown in `content` — which is what the
# cross-check below exists to keep from drifting. Same pairing rule, and the
# same reasoning, as chapter_grid.SCORING_GRID_CHAPTER_TYPE.
RULEBOOK_CHAPTER_TYPE = "rulebook"

# http(s) and nothing else. The same test the bgb_chapters_link_shape CHECK
# applies, deliberately duplicated: the constraint is the backstop that catches
# any future caller, and this is what turns a bad URL into a 400 a person can
# read instead of a 500 out of Postgres.
_URL_RE = re.compile(r"^https?://[^\s]+$", re.IGNORECASE)

# A link nobody can follow is not a link. 2048 is the length every mainstream
# browser and CDN agrees to carry; past it the row would save and the click
# would not work.
MAX_RULEBOOK_URL_CHARS = 2048


def validate_layout_pairing(
    layout: ChapterLayout | str | None,
    chapter_type: str | None,
) -> None:
    """Require layout and chapter type to agree, in BOTH directions.

    `layout == 'rulebook_link'` if and only if `chapter_type == 'rulebook'`.
    The mirror of chapter_grid.validate_layout_pairing, and it exists for the
    same reason: nothing else stops the two drifting, because the DB constraint
    sees the layout alone and Pydantic sees neither the type lookup table nor
    the row being edited.

    Rejecting only one direction would leave the other half authorable: a
    rulebook link filed under 'tips' renders as a chapter whose whole body is a
    bare markdown link in a section about tips, and a 'rulebook' chapter with a
    markdown body is a section promising the rules that carries somebody's prose
    — and, worse, carries NO moderation status, because the gate hangs off the
    layout.
    """
    if layout is None or chapter_type is None:
        return
    is_link_layout = str(layout) == ChapterLayout.RULEBOOK_LINK
    is_link_type = chapter_type == RULEBOOK_CHAPTER_TYPE
    if is_link_layout == is_link_type:
        return
    if is_link_layout:
        detail = f"A rulebook link must be a '{RULEBOOK_CHAPTER_TYPE}' chapter"
    else:
        detail = f"A '{RULEBOOK_CHAPTER_TYPE}' chapter must carry a rulebook link"
    raise HTTPException(status_code=400, detail=detail)


def clean_url(raw: str | None) -> str:
    """The URL to store, or a 400 naming what is wrong with it.

    Trims, then tests the scheme — and tests it HERE rather than leaving it to
    the CHECK constraint so the author gets "must start with http:// or
    https://" instead of a Postgres constraint violation surfacing as a 500.

    Nothing else is normalised. No lower-casing (paths are case-sensitive), no
    trailing-slash surgery, no unicode folding: this string's only job is to be
    the URL its author pasted, and an app that quietly rewrites a link is an app
    that eventually breaks one.
    """
    url = (raw or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="A rulebook link needs a URL")
    if len(url) > MAX_RULEBOOK_URL_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"That URL is too long (max {MAX_RULEBOOK_URL_CHARS} characters)",
        )
    if not _URL_RE.match(url):
        raise HTTPException(
            status_code=400,
            detail="A rulebook link must start with http:// or https://",
        )
    return url


def rulebook_title(game_name: str | None) -> str:
    """The title a rulebook chapter gets, DERIVED from the game it is for.

    Same argument as chapter_grid.grid_title, and deliberately the same shape:
    a rulebook link has no name of its own and asking for one would only collect
    twenty synonyms for "Everdell rules". The title still has to EXIST — the
    column is NOT NULL, the pool ILIKE-searches it, the moderation queue heads a
    row with it — so it is the game's name plus the thing it points at, which
    reads correctly in all three places and still reads correctly out of
    context.

    Regenerated on every write, so renaming a game re-titles its rulebook link
    the next time one is saved.
    """
    name = (game_name or "").strip()
    return f"{name} rulebook" if name else "Rulebook"


def url_to_content(url: str) -> str:
    """The markdown mirror stored in `content` — see this module's docstring.

    A markdown link rather than a bare URL, so a surface that has not learned
    about this layout renders something a reader can click rather than a string
    they have to copy.
    """
    return f"[Rulebook]({url})"


def initial_status(is_admin: bool) -> RulebookStatus:
    """The gate a newly-written URL opens at: approved for an admin, else pending."""
    return RulebookStatus.APPROVED if is_admin else RulebookStatus.PENDING


def gate_columns(user_id: str, is_admin: bool) -> dict[str, Any]:
    """The three moderation columns for a newly-written URL.

    An admin's write is their decision, so it carries their id and a
    timestamp; anybody else's is undecided and carries neither.
    """
    status = initial_status(is_admin)
    decided = status is RulebookStatus.APPROVED
    return {
        "moderation_status": str(status),
        "moderated_by": user_id if decided else None,
        "moderated_at": "now()" if decided else None,
    }


def gate_status(row: dict[str, Any]) -> RulebookStatus:
    """The status to JUDGE a row by, with the impossible case closed.

    A missing status, or one this code does not know ('unlisted'
    included), is read as PENDING rather than APPROVED.
    """
    try:
        return RulebookStatus(row.get("moderation_status") or RulebookStatus.PENDING)
    except ValueError:
        return RulebookStatus.PENDING


def is_rulebook_row(row: dict[str, Any]) -> bool:
    """Whether a chapter row is a rulebook link.

    Reads the LAYOUT, and falls back to the type for a row written before the
    two were pinned together — the same defensive read the frontend's
    isScoringGrid does, for the same reason: a row that is a rulebook link by
    either column must not slip past the gate because the other column
    disagrees.
    """
    return (
        row.get("layout") == ChapterLayout.RULEBOOK_LINK
        or row.get("chapter_type") == RULEBOOK_CHAPTER_TYPE
    )


def is_visible_to(
    row: dict[str, Any],
    viewer_id: Optional[str],
    is_admin: bool = False,
) -> bool:
    """THE rule. Every read path goes through here, directly or via filter_visible.

    A row that is not a rulebook link is always visible, so callers can hand it
    a mixed list. A rulebook link is visible to everyone, anonymous readers
    included, unless it is denied; a denied one is visible to its author and to
    admins only. Status is read via `gate_status`.
    """
    if not is_rulebook_row(row):
        return True
    if is_admin:
        return True
    if gate_status(row) is not RulebookStatus.DENIED:
        return True
    author = row.get("created_by")
    return bool(author) and author == viewer_id


def filter_visible(
    rows: list[dict[str, Any]],
    viewer_id: Optional[str],
    is_admin: bool = False,
) -> list[dict[str, Any]]:
    """Drop the rulebook links this viewer may not see, in one pass."""
    return [r for r in rows if is_visible_to(r, viewer_id, is_admin)]


def visible_ids(
    rows: Iterable[dict[str, Any]],
    viewer_id: Optional[str],
    is_admin: bool = False,
) -> set[str]:
    """The ids of the rows `filter_visible` would keep, for the count endpoints."""
    return {r["id"] for r in filter_visible(list(rows), viewer_id, is_admin)}
