"""The admin's rulebook-link queue (migrations 052, 053).

A SEPARATE queue from the chapter reports in chapter_routes.py, and
deliberately not folded into them. Reports are reactive — something is
published, a reader objects, an admin looks — which is the right shape for
prose, where the worst case is a minute wasted. A rulebook link is an outbound
destination, so the first report would already be too late: it gets looked at
on the way IN. Same admin, same screen family, different question, and mixing
the two would make "resolve" mean two things.

A module of its own rather than four more handlers on chapter_routes.py, which
is already 1200 lines against this repo's ~300 guideline. The split is along the
same seam services/chapter_rulebook.py takes: what a READER may see is a filter
every chapter read applies, and lives there; what an ADMIN does about it is this
file, and nothing else imports it.

Every handler runs its Supabase round trips through `asyncio.to_thread`; the
`_<handler>_sync` helper directly above a route is that blocking half — the same
shape chapter_routes.py uses.
"""

import asyncio

from fastapi import Depends, HTTPException, Path, Query
from supabase import Client

from db import get_supabase

from . import router
from .constants import ChapterLayout, RulebookStatus
from .dependencies import CurrentUser, get_current_admin
from .models import RulebookLinkReviewItem, RulebookModerationResponse


def _link_host(url: str) -> str:
    """The host of a URL, for the queue's at-a-glance column.

    Deliberately string surgery rather than urllib.parse: this is presentation
    for an admin who is about to read the whole URL anyway, and a parser that
    raises on a malformed input would take the queue down over exactly the rows
    it exists to show. Anything unparseable falls back to the URL itself.
    """
    rest = url.split("://", 1)[-1]
    host = rest.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    return host or url


def _buddy_reach(sb: Client, author_ids: list[str]) -> dict[str, int]:
    """How many accepted buddies each author has.

    The number that says how urgent a pending row is: it is how many people can
    already follow this link on the strength of a buddy edge. One round trip for
    the whole queue rather than one per row — the queue is small, and the edges
    come back canonical (user_a < user_b) so both columns are tallied.
    """
    if not author_ids:
        return {}
    rows = (
        sb.table("boardgamebuddy_buddy_edges")
        .select("user_a, user_b")
        .eq("status", "accepted")
        .or_(
            f"user_a.in.({','.join(author_ids)}),"
            f"user_b.in.({','.join(author_ids)})"
        )
        .execute()
    ).data or []
    out: dict[str, int] = {a: 0 for a in author_ids}
    wanted = set(author_ids)
    for r in rows:
        for side in (r.get("user_a"), r.get("user_b")):
            if side in wanted:
                out[side] = out.get(side, 0) + 1
    return out


_REVIEW_SELECT = (
    "id, game_id, title, link_url, moderation_status, created_by,"
    " created_at, moderated_at,"
    " boardgamebuddy_games(name),"
    # !created_by for the same reason chapter_routes._CHAPTER_SELECT carries it:
    # moderated_by is a second FK into profiles, so an unhinted embed is
    # ambiguous and the queue 500s.
    " boardgamebuddy_profiles!created_by(display_name)"
)


def _list_rulebook_links_sync(sb: Client, status: str) -> list[RulebookLinkReviewItem]:
    # One equality on moderation_status, off idx_bgb_chapters_rulebook_status.
    # `unlisted` is a legal value here and the UI never asks for it: those are
    # links nobody submitted (migration 053), so they are not queue work, and a
    # tab listing them would be a list of what people chose not to publish.
    # The filter accepts it so an admin chasing a specific link by state can,
    # and the default below stays where the work is.
    rows = (
        sb.table("boardgamebuddy_guide_chapters")
        .select(_REVIEW_SELECT)
        .eq("layout", str(ChapterLayout.RULEBOOK_LINK))
        .eq("moderation_status", status)
        # Oldest first: a pending link is live for its author's buddies the
        # whole time it waits, so the queue is worked from the one that has been
        # unreviewed longest — the same order the chapter reports use.
        .order("created_at", desc=False)
        .limit(500)
        .execute()
    ).data or []

    authors = sorted({r["created_by"] for r in rows if r.get("created_by")})
    reach = _buddy_reach(sb, authors)

    out: list[RulebookLinkReviewItem] = []
    for r in rows:
        game = r.get("boardgamebuddy_games") or {}
        profile = r.get("boardgamebuddy_profiles") or {}
        url = r.get("link_url") or ""
        out.append(RulebookLinkReviewItem(
            chapter_id=r["id"],
            game_id=r.get("game_id") or "",
            game_name=game.get("name") or "(unknown game)",
            title=r.get("title") or "",
            link_url=url,
            link_host=_link_host(url),
            moderation_status=r.get("moderation_status") or RulebookStatus.PENDING,
            created_by=r.get("created_by"),
            # None for the links migration 052 backfilled out of the catalog
            # column — nobody authored those as chapters, and the queue says so
            # rather than inventing a name.
            created_by_name=profile.get("display_name"),
            buddy_reach=reach.get(r.get("created_by") or "", 0),
            created_at=r["created_at"],
            moderated_at=r.get("moderated_at"),
        ))
    return out


@router.get(
    "/admin/rulebook-links",
    response_model=list[RulebookLinkReviewItem],
    status_code=200,
    summary="List rulebook links by moderation status (admin)",
)
async def list_rulebook_links(
    status: RulebookStatus = Query(
        RulebookStatus.PENDING, description="unlisted | pending | approved | denied"
    ),
    _admin: CurrentUser = Depends(get_current_admin),
) -> list[RulebookLinkReviewItem]:
    """Admin-only: the rulebook-link queue.

    `pending` is the work — links whose author ASKED (migration 053). `approved`
    and `denied` are there so a decision can be found again and reversed, which
    is what makes a denial undoable rather than a one-way door. `unlisted` is
    reachable and is not a queue: those authors asked for nothing, and the admin
    UI offers no tab for them.
    """
    sb = get_supabase()
    return await asyncio.to_thread(_list_rulebook_links_sync, sb, str(status))


def _moderate_rulebook_link_sync(
    sb: Client, chapter_id: str, decision: RulebookStatus, admin_id: str
) -> RulebookModerationResponse:
    existing = (
        sb.table("boardgamebuddy_guide_chapters")
        .select("id, layout, moderation_status")
        .eq("id", chapter_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Rulebook link not found")
    row = existing.data[0]
    if row.get("layout") != str(ChapterLayout.RULEBOOK_LINK):
        # The one chapter kind that carries a gate is the only one that can be
        # moderated through it. Prose is moderated by the reports queue above,
        # and a 400 here is what stops the two being confused by a client.
        raise HTTPException(
            status_code=400, detail="That chapter is not a rulebook link"
        )
    if (
        decision is RulebookStatus.APPROVED
        and row.get("moderation_status") == RulebookStatus.UNLISTED
    ):
        # AN APPROVAL IS THE ANSWER TO A QUESTION SOMEBODY ASKED. An unlisted
        # link is one its author deliberately did not submit (migration 053) —
        # the PDF their own table reads from, kept between them and their
        # buddies — and publishing it to everyone on an admin's initiative
        # would make the review toggle a suggestion rather than a choice.
        #
        # DENYING one is still allowed, and the asymmetry is the point: an
        # admin who finds a malicious link spreading through a buddy graph must
        # be able to kill it whether or not anybody asked them to look.
        raise HTTPException(
            status_code=409,
            detail=(
                "That link was never submitted for review — its author is"
                " sharing it with their buddies only."
            ),
        )

    sb.table("boardgamebuddy_guide_chapters").update({
        "moderation_status": str(decision),
        "moderated_by": admin_id,
        "moderated_at": "now()",
        # NOT `updated_at`: that column is the chapter's own edit clock, read by
        # every client cache, and a moderation decision does not change what the
        # chapter says. Touching it would invalidate every cached guide on every
        # approval.
    }).eq("id", chapter_id).execute()

    message = (
        "Rulebook link approved — everyone can see it now"
        if decision is RulebookStatus.APPROVED
        else "Rulebook link denied — hidden from everyone but its author"
    )
    return RulebookModerationResponse(
        chapter_id=chapter_id, moderation_status=decision, message=message
    )


@router.post(
    "/admin/rulebook-links/{chapter_id}/approve",
    response_model=RulebookModerationResponse,
    status_code=200,
    summary="Approve a rulebook link (admin)",
)
async def approve_rulebook_link(
    chapter_id: str = Path(..., description="Chapter UUID"),
    admin: CurrentUser = Depends(get_current_admin),
) -> RulebookModerationResponse:
    """Admin-only: make a rulebook link visible to everyone.

    Takes a link in any SUBMITTED or decided state, so this is also how a
    denial is undone. Refuses an `unlisted` link with a 409: its author never
    asked for it to be published (migration 053), and an approval is the answer
    to a question somebody asked.
    """
    sb = get_supabase()
    return await asyncio.to_thread(
        _moderate_rulebook_link_sync,
        sb,
        chapter_id,
        RulebookStatus.APPROVED,
        admin.user_id,
    )


@router.post(
    "/admin/rulebook-links/{chapter_id}/deny",
    response_model=RulebookModerationResponse,
    status_code=200,
    summary="Deny a rulebook link (admin)",
)
async def deny_rulebook_link(
    chapter_id: str = Path(..., description="Chapter UUID"),
    admin: CurrentUser = Depends(get_current_admin),
) -> RulebookModerationResponse:
    """Admin-only: hide a rulebook link from everyone but its author.

    Takes a link in ANY state, `unlisted` included — deliberately the opposite
    of approve above. An admin who finds a malicious link spreading through a
    buddy graph must be able to kill it whether or not anybody asked them to
    look at it.

    Not a delete, on purpose: the row is what keeps the same author from
    re-posting the same link past idx_bgb_chapters_rulebook_author, and it is
    what lets the author see their link was looked at rather than lost. Deleting
    the chapter outright is still available — DELETE /chapters/{id} — for a link
    that should leave no trace.
    """
    sb = get_supabase()
    return await asyncio.to_thread(
        _moderate_rulebook_link_sync,
        sb,
        chapter_id,
        RulebookStatus.DENIED,
        admin.user_id,
    )
