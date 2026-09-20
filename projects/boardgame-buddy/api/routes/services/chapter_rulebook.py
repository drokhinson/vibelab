"""Rulebook-link chapter helpers (migration 052).

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

WHAT IS DIFFERENT FROM EVERY OTHER CHAPTER, and why this module is bigger than
chapter_grid.py: this is the one chapter body the app did not write. Following
it takes a reader off this origin and onto somebody else's server, so it carries
a gate — `moderation_status` — that no other chapter has, and the gate is only
worth anything if EVERY read path applies it. That is what `is_visible_to` and
`filter_visible` below are for, and why they take a viewer rather than being a
query filter: the answer is per-reader (an author, a buddy, an admin and a
stranger get different answers for the same row) and PostgREST cannot express
"or the author is one of my accepted buddies" without a round trip of its own,
which is `buddy_ids` here.
"""

import re
from typing import Any, Iterable, Optional

from fastapi import HTTPException
from supabase import Client

from ..constants import ChapterLayout, RulebookStatus

# The chapter type a rulebook link must be filed under, seeded by migration 052
# at display_order 6. The type and the layout are 1:1 and each holds half the
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
    """The gate a newly-written link opens at.

    An admin's own link is born approved: the decision this queue exists to
    collect is theirs, and making them approve their own submission afterwards
    would be a queue item that carries no information. Everyone else's starts
    pending, visible to them and to their buddies while it waits.
    """
    return RulebookStatus.APPROVED if is_admin else RulebookStatus.PENDING


def buddy_ids(sb: Client, viewer_id: Optional[str]) -> set[str]:
    """The viewer's ACCEPTED buddies, as a set of profile ids.

    One round trip, and only on a request that has a rulebook link to judge —
    see `filter_visible`, which skips it entirely when the rows it was handed
    carry none. That matters: the chapter pool is fetched on every guide mount.

    Both columns are read because boardgamebuddy_buddy_edges is canonical
    (`user_a < user_b`), so which side the viewer is on says nothing about the
    relationship. Pending and blocked edges are not buddies and are filtered out
    in the query, not here.
    """
    if not viewer_id:
        return set()
    rows = (
        sb.table("boardgamebuddy_buddy_edges")
        .select("user_a, user_b")
        .eq("status", "accepted")
        .or_(f"user_a.eq.{viewer_id},user_b.eq.{viewer_id}")
        .execute()
    ).data or []
    out: set[str] = set()
    for r in rows:
        a, b = r.get("user_a"), r.get("user_b")
        out.add(b if a == viewer_id else a)
    out.discard(viewer_id)
    return out


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
    viewer_buddy_ids: set[str],
    is_admin: bool = False,
) -> bool:
    """THE rule. Every read path goes through here, directly or via filter_visible.

    A row that is not a rulebook link is always visible — this function gates
    one layout and passes everything else through untouched, so callers can hand
    it a mixed list without sorting it first.

    For a rulebook link:

      * approved → everyone, including anonymous readers. An admin's name is on
        it.
      * pending  → its author and their accepted buddies. Vouching is the
        relationship this app is built on, and holding a link back from the
        table that just added it would make the common case useless.
      * denied   → its author (so they can see it was looked at rather than
        lost) and admins. Nobody else, buddies included — that is what "denial
        hides it" means, and it is the half of the rule that would be easy to
        get wrong by only filtering the pool.

    An admin sees every rulebook link whatever its status: they are the ones
    deciding, and a queue that hides its own items is not a queue.

    A row with NO status at all is treated as pending rather than approved. That
    state is unreachable through the constraint, and the safe reading of an
    impossible row is the closed one.
    """
    if not is_rulebook_row(row):
        return True
    if is_admin:
        return True
    status = row.get("moderation_status") or RulebookStatus.PENDING
    if status == RulebookStatus.APPROVED:
        return True
    author = row.get("created_by")
    if author and viewer_id and author == viewer_id:
        return True
    if status == RulebookStatus.DENIED:
        # Author-only above; a denial reaches nobody else, buddy or not.
        return False
    return bool(author) and author in viewer_buddy_ids


def filter_visible(
    sb: Client,
    rows: list[dict[str, Any]],
    viewer_id: Optional[str],
    is_admin: bool = False,
) -> list[dict[str, Any]]:
    """Drop the rulebook links this viewer may not see, in one pass.

    The buddy lookup is paid for ONLY when the list actually contains a rulebook
    link that is neither approved nor the viewer's own — which on the vast
    majority of guide mounts it does not, so the common path costs a `any()`
    over rows already in memory and no round trip at all.
    """
    if not rows:
        return rows
    needs_buddies = any(
        is_rulebook_row(r)
        and (r.get("moderation_status") or RulebookStatus.PENDING) == RulebookStatus.PENDING
        and r.get("created_by")
        and r.get("created_by") != viewer_id
        for r in rows
    )
    ids = buddy_ids(sb, viewer_id) if (needs_buddies and not is_admin) else set()
    return [r for r in rows if is_visible_to(r, viewer_id, ids, is_admin)]


def visible_ids(
    sb: Client,
    rows: Iterable[dict[str, Any]],
    viewer_id: Optional[str],
    is_admin: bool = False,
) -> set[str]:
    """The ids of the rows `filter_visible` would keep.

    For the count endpoints, which need the answer without carrying the bodies.
    """
    return {r["id"] for r in filter_visible(sb, list(rows), viewer_id, is_admin)}
