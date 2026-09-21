"""Reference-guide chapter endpoints.

Each user builds their own reference guide for each game by adding
chapters one at a time. Two ways to add: create a new chapter (type +
title + markdown), or browse the pool of existing chapters for that
game and add the ones they want. No curated defaults, and for prose no
review queue — moderation is reactive via per-chapter reports.

ONE chapter kind is different: a rulebook link (layout='rulebook_link',
migration 052) sends a reader off this origin, so it carries a gate of its
own and every read path in this file filters on it. The rule itself, and the
argument for it, live in services/chapter_rulebook.py; here it is one call —
`chapter_rulebook.filter_visible` — that each read passes its rows through,
plus the admin queue at the foot of the file.

The wizard's optional AI head start — the markdown drafter and the scoring-grid
one both — lives next door in `chapter_ai_routes.py`, so the two prompts and
their 502 mapping are not interleaved with the CRUD.

Every handler runs its Supabase round trips through `asyncio.to_thread`; the
`_<handler>_sync` helper directly above a route is that blocking half.
"""

import asyncio
import logging
from typing import Any, Optional

from fastapi import Depends, Header, HTTPException, Path, Query, Response
from supabase import Client

from db import get_supabase

from . import router
from .dependencies import (
    CurrentUser,
    get_current_admin,
    get_current_user,
    maybe_supabase_user,
)
from .constants import ChapterLayout, RulebookStatus
from .models import (
    AddChapterRequest,
    ChapterCreate,
    ChapterPoolCountResponse,
    ChapterPoolItem,
    ChapterReportCreate,
    ChapterReportResponse,
    ChapterResponse,
    ChapterTypeResponse,
    ChapterUpdate,
    MessageResponse,
    MyGuideChapterResponse,
)
from .services import chapter_grid, chapter_rulebook
from .services._helpers import parse_csv_param

logger = logging.getLogger(__name__)


_CHAPTER_SELECT = (
    "id, game_id, chapter_type, title, layout, content, grid,"
    " link_url, moderation_status,"
    " created_by, updated_at, created_at,"
    " boardgamebuddy_chapter_types(label, icon, display_order),"
    # Since migration 052 this table has TWO FKs into profiles — created_by and
    # moderated_by — so an unhinted embed is PGRST201 ("more than one
    # relationship was found") and every read path through this select 500s.
    # !created_by names the one the author's display_name comes from; the JSON
    # key stays `boardgamebuddy_profiles`, which is what _chapter_row_to_response
    # reads.
    " boardgamebuddy_profiles!created_by(display_name)"
)


def _build_source_map(sb, game_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Fetch (name, expansion_color, bgg_id) for a list of game ids in one trip.

    The chapter response uses this to populate source_game_name / source_color
    so the FE can render colored dots tying each chapter to its expansion (or
    leave the dot blank for base-game chapters).

    `bgg_id` rides along for migration 032: when several add-on expansions
    contribute rows to one scorepad, their blocks are ordered by BGG id
    ascending — a stable, publication-ordered key every client agrees on, where
    the order the guide happens to return them in is not.
    """
    if not game_ids:
        return {}
    rows = (
        sb.table("boardgamebuddy_games")
        .select("id, name, expansion_color, is_expansion, bgg_id")
        .in_("id", game_ids)
        .execute()
    ).data or []
    return {
        r["id"]: {
            "name": r.get("name") or "",
            # Base games get None — the FE skips the colored dot.
            "color": r.get("expansion_color") if r.get("is_expansion") else None,
            "bgg_id": r.get("bgg_id"),
        }
        for r in rows
    }


def _chapter_row_to_response(
    row: dict[str, Any],
    source_map: Optional[dict[str, dict[str, Any]]] = None,
) -> ChapterResponse:
    """Flatten a Supabase row with joined chapter_type + profile.

    When `source_map` is supplied, also populate source_game_id /
    source_game_name / source_color so a multi-game merged response can be
    rendered with the right colored dot per chapter.
    """
    type_obj = row.get("boardgamebuddy_chapter_types")
    profile_obj = row.get("boardgamebuddy_profiles")

    label = None
    icon = None
    display_order = 0
    if isinstance(type_obj, dict):
        label = type_obj.get("label")
        icon = type_obj.get("icon")
        display_order = int(type_obj.get("display_order") or 0)

    created_by_name = None
    if isinstance(profile_obj, dict):
        created_by_name = profile_obj.get("display_name")

    source_game_id = None
    source_game_name = None
    source_color = None
    source_bgg_id = None
    if source_map is not None:
        entry = source_map.get(row["game_id"])
        source_game_id = row["game_id"]
        if entry:
            source_game_name = entry.get("name")
            source_color = entry.get("color")
            source_bgg_id = entry.get("bgg_id")

    return ChapterResponse(
        id=row["id"],
        game_id=row["game_id"],
        chapter_type=row["chapter_type"],
        chapter_type_label=label,
        chapter_type_icon=icon,
        chapter_type_order=display_order,
        title=row["title"],
        layout=row.get("layout", "text"),
        content=row["content"],
        # Stale client caches and rows written before 018 can carry a layout
        # with no grid; every reader treats that as plain text rather than
        # throwing, so `grid` is read defensively here too.
        grid=row.get("grid"),
        # Migration 052. Both are NULL on every layout but 'rulebook_link', and
        # a row only reaches this function at all once
        # services/chapter_rulebook has decided the viewer may see it — the
        # response carries the status so the AUTHOR's copy can say it is
        # waiting, or was turned down, not so a client can do the filtering.
        link_url=row.get("link_url"),
        moderation_status=row.get("moderation_status"),
        created_by=row.get("created_by"),
        created_by_name=created_by_name,
        updated_at=row["updated_at"],
        source_game_id=source_game_id,
        source_game_name=source_game_name,
        source_color=source_color,
        source_bgg_id=source_bgg_id,
    )


def _validate_chapter_type(sb, chapter_type: str) -> None:
    """Raise 400 if the supplied chapter_type is not in the lookup table."""
    row = (
        sb.table("boardgamebuddy_chapter_types")
        .select("id")
        .eq("id", chapter_type)
        .execute()
    )
    if not row.data:
        raise HTTPException(status_code=400, detail="Unknown chapter type")


@router.get(
    "/chapter-types",
    response_model=list[ChapterTypeResponse],
    status_code=200,
    summary="List chapter types",
)
async def list_chapter_types() -> list[ChapterTypeResponse]:
    """Return the six fixed chapter-type lookup rows."""
    sb = get_supabase()
    result = await asyncio.to_thread(
        sb.table("boardgamebuddy_chapter_types")
        .select("id, label, icon, display_order")
        .order("display_order")
        .execute
    )
    return [ChapterTypeResponse(**r) for r in (result.data or [])]


def _browse_chapter_pool_sync(
    sb: Client,
    game_id: str,
    viewer_id: Optional[str],
    *,
    q: Optional[str],
    chapter_type: Optional[str],
    layout: Optional[ChapterLayout],
    expansion_ids: Optional[str],
) -> list[ChapterPoolItem]:
    exp_ids = parse_csv_param(expansion_ids)
    all_game_ids = [game_id, *exp_ids]

    pool_q = sb.table("boardgamebuddy_guide_chapters").select(_CHAPTER_SELECT)
    pool_q = pool_q.in_("game_id", all_game_ids) if exp_ids else pool_q.eq("game_id", game_id)
    if chapter_type:
        pool_q = pool_q.eq("chapter_type", chapter_type)
    if layout:
        pool_q = pool_q.eq("layout", str(layout))
    if q:
        # PostgREST's `or` filter combines two ILIKE matches into one query.
        needle = f"%{q}%"
        pool_q = pool_q.or_(f"title.ilike.{needle},content.ilike.{needle}")
    pool_rows = pool_q.limit(1000).execute().data or []

    # THE GATE, applied before anything else looks at these rows (migration
    # 052). A rulebook link the viewer may not see must not reach the sort, the
    # popularity tally or the wire — filtering client-side would ship the URL to
    # the browser that is not allowed to have it, which is not filtering.
    pool_rows = chapter_rulebook.filter_visible(sb, pool_rows, viewer_id)

    if not pool_rows:
        return []

    chapter_ids = [r["id"] for r in pool_rows]
    source_map = _build_source_map(sb, all_game_ids) if exp_ids else {}

    # Popularity: count user_chapters rows per chapter in one round trip.
    # Bounded at 1000 adopter rows until the tally moves to an RPC GROUP BY.
    #
    # `state='kept'` since migration 033: a row can now also mean "this viewer
    # turned it down", and counting those would let a chapter climb the
    # popularity sort on the strength of the people who refused it.
    popularity: dict[str, int] = {cid: 0 for cid in chapter_ids}
    pop_rows = (
        sb.table("boardgamebuddy_user_chapters")
        .select("chapter_id")
        .eq("state", "kept")
        .in_("chapter_id", chapter_ids)
        .limit(1000)
        .execute()
    ).data or []
    for r in pop_rows:
        popularity[r["chapter_id"]] = popularity.get(r["chapter_id"], 0) + 1

    # The viewer's own opinion of each chapter, both signs, from ONE query.
    # `state` is selected rather than filtered so the kept and the disliked
    # sets come back together — they are mutually exclusive by the table's
    # UNIQUE (user_id, chapter_id), so a second round trip would only be
    # re-asking the question this one already answered.
    in_my_guide: set[str] = set()
    disliked: set[str] = set()
    if viewer_id is not None:
        mine = (
            sb.table("boardgamebuddy_user_chapters")
            .select("chapter_id, state")
            .eq("user_id", viewer_id)
            .in_("chapter_id", chapter_ids)
            .execute()
        ).data or []
        in_my_guide = {r["chapter_id"] for r in mine if r.get("state") != "disliked"}
        disliked = {r["chapter_id"] for r in mine if r.get("state") == "disliked"}

    # Two-pass stable sort: secondary key (created_at desc) first, then
    # primary (popularity desc). Python's sort is stable, so popularity
    # ties resolve by created_at desc.
    pool_rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    pool_rows.sort(key=lambda r: popularity.get(r["id"], 0), reverse=True)

    return [
        ChapterPoolItem(
            **_chapter_row_to_response(row, source_map if exp_ids else None).model_dump(),
            popularity=popularity.get(row["id"], 0),
            in_my_guide=row["id"] in in_my_guide,
            disliked=row["id"] in disliked,
        )
        for row in pool_rows
    ]


@router.get(
    "/games/{game_id}/chapter-pool",
    response_model=list[ChapterPoolItem],
    status_code=200,
    summary="Browse the pool of existing chapters for a game",
)
async def browse_chapter_pool(
    game_id: str = Path(..., description="Game UUID"),
    q: Optional[str] = Query(None, description="Keyword search across title + content"),
    chapter_type: Optional[str] = Query(None, description="Optional chapter-type filter"),
    layout: Optional[ChapterLayout] = Query(
        None,
        description=(
            "Optional body-layout filter. `scoring_grid` is how the reference"
            " guide asks 'does this game have scoring templates?' — each row"
            " already carries in_my_guide, so the client needs no other"
            " endpoint to answer '…that I haven't added'."
        ),
    ),
    expansion_ids: Optional[str] = Query(
        None,
        description=(
            "Comma-separated expansion game UUIDs to also include in the pool."
            " When set, the pool merges chapters from the base game plus these"
            " expansions, each row tagged with source_game_id/source_color."
        ),
    ),
    authorization: Optional[str] = Header(None),
) -> list[ChapterPoolItem]:
    """Browse every chapter that exists for this game (optionally + expansions).

    Sorted by `popularity DESC, created_at DESC`. Each row includes
    a `popularity` count (how many users have it in their guide),
    `in_my_guide` (whether the caller already has it) and `disliked`
    (whether the caller has turned it down).
    """
    sb = get_supabase()
    su_user = await maybe_supabase_user(authorization)
    return await asyncio.to_thread(
        _browse_chapter_pool_sync,
        sb,
        game_id,
        su_user.sub if su_user is not None else None,
        q=q,
        chapter_type=chapter_type,
        layout=layout,
        expansion_ids=expansion_ids,
    )


def _chapter_pool_count_sync(
    sb: Client, game_id: str, viewer_id: Optional[str], expansion_ids: Optional[str]
) -> int:
    exp_ids = parse_csv_param(expansion_ids)
    all_game_ids = [game_id, *exp_ids]
    # head=True asks Postgrest for the tally and none of the rows — the whole
    # reason this is not just `len()` of the pool, whose rows each carry a full
    # markdown body.
    count_q = sb.table("boardgamebuddy_guide_chapters").select(
        "id", count="exact", head=True
    )
    count_q = (
        count_q.in_("game_id", all_game_ids) if exp_ids else count_q.eq("game_id", game_id)
    )
    total = count_q.execute().count or 0

    if not total:
        return total

    # Migration 033: a chapter this viewer has turned down is not one their
    # guide is missing, so it comes off the denominator of the guide's
    # "N of M" — which is the whole point of the dislike. Counted, not
    # fetched, for the same reason the total above is.
    #
    # Scoped by game rather than by chapter id: this endpoint deliberately
    # never pulls the chapter rows, so it has no id list to filter on, and
    # game_id is on the dislike row anyway. The partial index from 033 serves
    # exactly this shape.
    #
    # Anonymous callers skip this and NOT the rulebook pass below: a signed-out
    # reader has no dislikes, but they are the strictest case there is for the
    # gate — approved links and nothing else.
    disliked = 0
    if viewer_id is not None:
        dis_q = (
            sb.table("boardgamebuddy_user_chapters")
            .select("chapter_id", count="exact", head=True)
            .eq("user_id", viewer_id)
            .eq("state", "disliked")
        )
        dis_q = (
            dis_q.in_("game_id", all_game_ids) if exp_ids else dis_q.eq("game_id", game_id)
        )
        disliked = dis_q.execute().count or 0

    # The rulebook gate's share of the denominator (migration 052). The count
    # endpoints are the one read path that cannot filter rows it never fetched,
    # so the links are fetched — id, author and status only, no bodies, off the
    # partial index idx_bgb_chapters_rulebook_status — and the ones this viewer
    # may not see come off the total. Without this a guide reads "2 of 3" with
    # nothing anywhere to be the third.
    link_q = (
        sb.table("boardgamebuddy_guide_chapters")
        .select("id, game_id, layout, chapter_type, created_by, moderation_status")
        .eq("layout", str(ChapterLayout.RULEBOOK_LINK))
    )
    link_q = link_q.in_("game_id", all_game_ids) if exp_ids else link_q.eq("game_id", game_id)
    link_rows = link_q.execute().data or []
    visible = chapter_rulebook.visible_ids(sb, link_rows, viewer_id)
    hidden = {r["id"] for r in link_rows if r["id"] not in visible}

    if hidden:
        # A hidden link the viewer had also DISLIKED is already off the total by
        # way of `disliked` above, and subtracting it twice would put the
        # denominator below the number of chapters actually on their screen. The
        # id list is tiny by construction, so this is a cheap intersection
        # rather than a second full query.
        dupes = (
            sb.table("boardgamebuddy_user_chapters")
            .select("chapter_id")
            .eq("user_id", viewer_id)
            .eq("state", "disliked")
            .in_("chapter_id", list(hidden))
            .execute()
        ).data or [] if viewer_id else []
        hidden -= {r["chapter_id"] for r in dupes}

    # A dislike row can outlive nothing here — it cascades with its chapter —
    # but clamp anyway: a negative total would render as "3 of -1".
    return max(total - disliked - len(hidden), 0)


@router.get(
    "/games/{game_id}/chapter-pool/count",
    response_model=ChapterPoolCountResponse,
    status_code=200,
    summary="How many chapters exist for a game",
)
async def count_chapter_pool(
    game_id: str = Path(..., description="Game UUID"),
    expansion_ids: Optional[str] = Query(
        None,
        description=(
            "Comma-separated expansion game UUIDs to also count, matching the"
            " scope `GET /games/{game_id}/chapter-pool` would return for the"
            " same parameters."
        ),
    ),
    authorization: Optional[str] = Header(None),
) -> ChapterPoolCountResponse:
    """Count the chapters written for this game (optionally + expansions) that
    the caller has not turned down.

    The same number `GET /games/{game_id}/chapter-pool` would return the length
    of once its disliked rows are dropped, without the chapter bodies. Auth is
    OPTIONAL and viewer-scoping is the only thing it buys: since migration 033
    the caller's own dislikes come off the total, because a chapter they have
    refused is not one their guide is missing. An anonymous caller gets the
    unfiltered pool size, as this endpoint always returned. The caller's own
    guide is still counted client-side from `my-chapters`.
    """
    sb = get_supabase()
    su_user = await maybe_supabase_user(authorization)
    total = await asyncio.to_thread(
        _chapter_pool_count_sync,
        sb,
        game_id,
        su_user.sub if su_user is not None else None,
        expansion_ids,
    )
    return ChapterPoolCountResponse(total=total)


def _create_chapter_sync(
    sb: Client, game_id: str, body: ChapterCreate, user: CurrentUser
) -> MyGuideChapterResponse:
    game = (
        sb.table("boardgamebuddy_games")
        # is_expansion decides a scoring grid's MODE (migration 032) — an
        # expansion's rows either join the base game's grid or stand in for it,
        # and a base game's own grid is in neither mode. Selected here beside
        # the name the title is derived from, so the mode costs no extra
        # round-trip.
        .select("id, name, is_expansion")
        .eq("id", game_id)
        .execute()
    )
    if not game.data:
        raise HTTPException(status_code=404, detail="Game not found")

    user_id = user.user_id

    _validate_chapter_type(sb, body.chapter_type)
    chapter_grid.validate_layout_pairing(body.layout, body.chapter_type)
    chapter_rulebook.validate_layout_pairing(body.layout, body.chapter_type)

    # For a scoring grid the rows ARE the chapter, and for a rulebook link the
    # URL is: in both cases `content` and `title` are generated rather than
    # anything the author typed — see services/chapter_grid.py and
    # services/chapter_rulebook.py for why neither is a field on those forms.
    is_grid = body.layout is ChapterLayout.SCORING_GRID and body.grid is not None
    is_link = body.layout is ChapterLayout.RULEBOOK_LINK
    link_url = chapter_rulebook.clean_url(body.link_url) if is_link else None

    if is_link:
        # One rulebook link per (game, author) — idx_bgb_chapters_rulebook_author
        # says so, and this check is what turns that into a sentence rather than
        # a Postgres unique violation surfacing as a 500. Checked against the
        # author's row WHATEVER its status: a denied link still occupies the
        # slot, deliberately, so re-posting the same URL under a new row is not
        # a way around a decision. Editing the existing one is the way to change
        # it, and that re-opens the gate.
        mine = (
            sb.table("boardgamebuddy_guide_chapters")
            .select("id, moderation_status")
            .eq("game_id", game_id)
            .eq("layout", str(ChapterLayout.RULEBOOK_LINK))
            .eq("created_by", user_id)
            .execute()
        )
        if mine.data:
            denied = mine.data[0].get("moderation_status") == RulebookStatus.DENIED
            raise HTTPException(
                status_code=409,
                detail=(
                    "An admin turned down your rulebook link for this game. Edit that"
                    " one to submit a different URL."
                    if denied
                    else "You already have a rulebook link for this game — edit it instead."
                ),
            )

    content = body.content
    title = body.title
    if is_grid:
        content = chapter_grid.grid_to_content(body.grid)
        title = chapter_grid.grid_title(game.data[0].get("name"))
    elif is_link:
        content = chapter_rulebook.url_to_content(link_url)
        title = chapter_rulebook.rulebook_title(game.data[0].get("name"))

    insert = (
        sb.table("boardgamebuddy_guide_chapters")
        .insert({
            "game_id": game_id,
            "chapter_type": body.chapter_type,
            "title": title,
            "content": content,
            "layout": str(body.layout),
            "grid": (
                chapter_grid.apply_grid_mode(
                    body.grid, bool(game.data[0].get("is_expansion"))
                )
                if body.grid
                else None
            ),
            "link_url": link_url,
            # The gate the author chose, not the one their role would give them
            # (migration 053): `request_review` picks pending or unlisted, and
            # both are live for the author's buddies either way. Nobody's link
            # is born approved any more, an admin's included — so no row leaves
            # here carrying a decision, and `moderated_by`/`moderated_at` stay
            # NULL until somebody actually makes one. NULL on every other
            # layout, which bgb_chapters_link_shape requires.
            "moderation_status": (
                str(chapter_rulebook.initial_status(body.request_review))
                if is_link
                else None
            ),
            "moderated_by": None,
            "moderated_at": None,
            "created_by": user_id,
        })
        .execute()
    )
    if not insert.data:
        raise HTTPException(status_code=500, detail="Chapter insert returned no row")
    new_id = insert.data[0]["id"]

    # Auto-add to creator's guide. `state` is written out rather than left to
    # the column default (migration 033) because this row is the one place the
    # table is populated by something other than a deliberate add/dislike, and
    # a reader working out what a row means should not have to go and look up
    # what the default is.
    sel = (
        sb.table("boardgamebuddy_user_chapters")
        .insert({
            "user_id": user_id,
            "game_id": game_id,
            "chapter_id": new_id,
            "state": "kept",
        })
        .execute()
    )
    added_at = sel.data[0]["created_at"] if sel.data else None

    fetched = (
        sb.table("boardgamebuddy_guide_chapters")
        .select(_CHAPTER_SELECT)
        .eq("id", new_id)
        .execute()
    )
    base = _chapter_row_to_response(fetched.data[0])
    return MyGuideChapterResponse(
        **base.model_dump(),
        added_at=added_at or base.updated_at,
    )


@router.post(
    "/games/{game_id}/chapters",
    response_model=MyGuideChapterResponse,
    status_code=201,
    summary="Create a chapter and add it to my guide",
)
async def create_chapter(
    body: ChapterCreate,
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MyGuideChapterResponse:
    """Create a new chapter attached to a game and immediately add it to the creator's guide.

    A rulebook link written by an admin is live immediately; anyone else's is
    visible to them and their accepted buddies while it waits in the admin queue
    (migration 052).
    """
    sb = get_supabase()
    return await asyncio.to_thread(_create_chapter_sync, sb, game_id, body, user)


def _update_chapter_sync(
    sb: Client, chapter_id: str, body: ChapterUpdate, user: CurrentUser
) -> ChapterResponse:
    user_id = user.user_id
    existing = (
        sb.table("boardgamebuddy_guide_chapters")
        .select(
            "id, game_id, created_by, layout, chapter_type, link_url,"
            " moderation_status"
        )
        .eq("id", chapter_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Chapter not found")
    row = existing.data[0]
    if row["created_by"] != user_id:
        raise HTTPException(status_code=403, detail="You can only edit chapters you created")

    # Check the pairing the edit would LEAVE BEHIND, not just the fields it
    # carries. A PATCH that only moves chapter_type to 'tips' names no layout at
    # all, so validating the body alone would happily strand a scoring grid
    # under a type the guide scroll files elsewhere.
    layout = body.layout if body.layout is not None else row.get("layout")
    chapter_type = (
        body.chapter_type if body.chapter_type is not None else row.get("chapter_type")
    )
    chapter_grid.validate_layout_pairing(layout, chapter_type)
    chapter_rulebook.validate_layout_pairing(layout, chapter_type)

    updates: dict[str, Any] = {"updated_at": "now()"}
    if body.chapter_type is not None:
        _validate_chapter_type(sb, body.chapter_type)
        updates["chapter_type"] = body.chapter_type
    if body.title is not None:
        updates["title"] = body.title
    if body.content is not None:
        updates["content"] = body.content
    if body.layout is not None:
        updates["layout"] = str(body.layout)
    # A grid's title is derived, so it is rewritten on every edit whatever the
    # body said — which is also how a grid authored before the title field was
    # retired, or one whose game has since been renamed, picks up the current
    # form. Costs one lookup, and only on a grid edit.
    is_expansion = False
    if str(layout) == str(ChapterLayout.SCORING_GRID):
        game = (
            sb.table("boardgamebuddy_games")
            # is_expansion rides along for the mode below, same one lookup.
            .select("name, is_expansion")
            .eq("id", row["game_id"])
            .execute()
        )
        updates["title"] = chapter_grid.grid_title(
            game.data[0].get("name") if game.data else None
        )
        is_expansion = bool(game.data[0].get("is_expansion")) if game.data else False
    # A None grid means "not supplied", so this endpoint cannot CLEAR one. That
    # is deliberate: a chapter never changes layout in practice, and the editor
    # sends layout and grid together or neither.
    if body.grid is not None:
        updates["grid"] = chapter_grid.apply_grid_mode(body.grid, is_expansion)
        # Keep the derived mirror in step with the rows it mirrors, whether or
        # not the caller also sent `content`.
        updates["content"] = chapter_grid.grid_to_content(body.grid)

    # ── A rulebook link's URL, and its gate ──────────────────────────────────
    #
    # Editing the URL RE-OPENS the gate, which is the whole reason this branch
    # is not three lines. An approval is a decision about a destination, not
    # about a row: without this, an author could get an innocuous PDF approved
    # and then point the same approved row anywhere, and every reader following
    # the app's own "approved" badge would go there. So a changed URL drops the
    # badge it had and goes back through the gate — whoever is editing, admins
    # included, since migration 053 (an admin approves it from the queue, which
    # is one tap and leaves an audit trail a self-approval never did).
    #
    # Unchanged URL, unchanged status: re-submitting the same link by saving the
    # form again must not send an approved link back to the queue.
    if str(layout) == str(ChapterLayout.RULEBOOK_LINK) and body.link_url is not None:
        link_url = chapter_rulebook.clean_url(body.link_url)
        updates["link_url"] = link_url
        updates["content"] = chapter_rulebook.url_to_content(link_url)
        # Derived on every save, exactly as a grid's is above and for the same
        # reason — a renamed game re-titles its rulebook link the next time one
        # is edited. Its own lookup rather than the grid branch's, because the
        # two branches are mutually exclusive and neither pays for the other.
        link_game = (
            sb.table("boardgamebuddy_games")
            .select("name")
            .eq("id", row["game_id"])
            .execute()
        )
        updates["title"] = chapter_rulebook.rulebook_title(
            link_game.data[0].get("name") if link_game.data else None
        )
        # The review toggle (migration 053). None means the caller did not send
        # one — a pre-053 client, or an edit that is not about the gate — and
        # then the row's current state answers for it: still submitted if it
        # was pending, still not if it was unlisted, and True for anything else,
        # since a decided link that is about to be re-opened by a changed URL
        # was one somebody had asked about.
        current = chapter_rulebook.gate_status(row)
        wants_review = (
            body.request_review
            if body.request_review is not None
            else current is not RulebookStatus.UNLISTED
        )
        url_changed = link_url != (row.get("link_url") or "")
        # A DECISION STANDS UNTIL THE DESTINATION CHANGES. The toggle moves a
        # link that is still waiting — submit it, or withdraw it from the queue
        # — and moves nothing once an admin has ruled on it. Flipping it on an
        # approved link would let its author quietly un-publish an admin's
        # decision; flipping it on a denied one would re-queue the same URL an
        # admin just turned down, which is exactly what the create path's 409
        # exists to prevent. Changing the URL is how both are re-opened, and
        # that is the branch above.
        reopen = url_changed or current in (RulebookStatus.UNLISTED, RulebookStatus.PENDING)
        new_status = (
            chapter_rulebook.initial_status(wants_review) if reopen else current
        )
        # Written only when it MOVES. A pending link saved again is still
        # pending, and a no-op write here would be three columns of churn on
        # every keystroke-free re-save.
        if new_status is not current:
            updates["moderation_status"] = str(new_status)
            # Nobody has decided the row this save produces, so the audit
            # columns say so rather than keeping the last decision's author on
            # a link that no longer carries their decision.
            updates["moderated_by"] = None
            updates["moderated_at"] = None

    sb.table("boardgamebuddy_guide_chapters").update(updates).eq("id", chapter_id).execute()

    fetched = (
        sb.table("boardgamebuddy_guide_chapters")
        .select(_CHAPTER_SELECT)
        .eq("id", chapter_id)
        .execute()
    )
    if not fetched.data:
        raise HTTPException(status_code=404, detail="Chapter not found")
    return _chapter_row_to_response(fetched.data[0])


@router.patch(
    "/chapters/{chapter_id}",
    response_model=ChapterResponse,
    status_code=200,
    summary="Edit a chapter",
)
async def update_chapter(
    body: ChapterUpdate,
    chapter_id: str = Path(..., description="Chapter UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ChapterResponse:
    """Edit an existing chapter. Creator-only (admins can edit by deleting + recreating).

    Changing a rulebook link's URL sends it back to the admin queue — an
    approval is a decision about a destination, not about a row (migration 052).
    """
    sb = get_supabase()
    return await asyncio.to_thread(_update_chapter_sync, sb, chapter_id, body, user)


def _delete_chapter_sync(sb: Client, chapter_id: str, user: CurrentUser) -> MessageResponse:
    existing = (
        sb.table("boardgamebuddy_guide_chapters")
        .select("id, created_by")
        .eq("id", chapter_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Chapter not found")
    if existing.data[0]["created_by"] != user.user_id and not user.is_admin:
        raise HTTPException(status_code=403, detail="You can only delete chapters you created")

    sb.table("boardgamebuddy_guide_chapters").delete().eq("id", chapter_id).execute()
    return MessageResponse(message="Chapter deleted")


@router.delete(
    "/chapters/{chapter_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete a chapter from the pool",
)
async def delete_chapter(
    chapter_id: str = Path(..., description="Chapter UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Delete a chapter from the pool. Creator or admin only. Cascades to user_chapters + reports."""
    sb = get_supabase()
    return await asyncio.to_thread(_delete_chapter_sync, sb, chapter_id, user)


def _report_chapter_sync(
    sb: Client, chapter_id: str, body: ChapterReportCreate, user_id: str
) -> MessageResponse:
    chapter = (
        sb.table("boardgamebuddy_guide_chapters")
        .select("id")
        .eq("id", chapter_id)
        .execute()
    )
    if not chapter.data:
        raise HTTPException(status_code=404, detail="Chapter not found")

    existing = (
        sb.table("boardgamebuddy_chapter_reports")
        .select("id, status")
        .eq("chapter_id", chapter_id)
        .eq("reporter_id", user_id)
        .execute()
    )
    if existing.data:
        return MessageResponse(message="Already reported — thanks for flagging")

    sb.table("boardgamebuddy_chapter_reports").insert({
        "chapter_id": chapter_id,
        "reporter_id": user_id,
        "reason": body.reason,
    }).execute()
    return MessageResponse(message="Reported — an admin will review shortly")


@router.post(
    "/chapters/{chapter_id}/report",
    response_model=MessageResponse,
    status_code=201,
    summary="Report a chapter for admin review",
)
async def report_chapter(
    body: ChapterReportCreate,
    chapter_id: str = Path(..., description="Chapter UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Flag a chapter for admin moderation. Idempotent per (chapter, reporter)."""
    sb = get_supabase()
    return await asyncio.to_thread(_report_chapter_sync, sb, chapter_id, body, user.user_id)


def _get_my_chapters_sync(
    sb: Client, game_id: str, expansion_ids: Optional[str], user_id: str
) -> list[MyGuideChapterResponse]:
    exp_ids = parse_csv_param(expansion_ids)
    all_game_ids = [game_id, *exp_ids]

    # `state='kept'` (migration 033): the guide is the kept half of this table.
    # Its disliked half is the builder's Disliked section, which reads it off
    # the chapter pool rather than from here — this endpoint answers "what is
    # in my guide", and a chapter turned down is the opposite of that.
    sel_q = (
        sb.table("boardgamebuddy_user_chapters")
        .select("chapter_id, game_id, created_at")
        .eq("user_id", user_id)
        .eq("state", "kept")
        .order("created_at")
    )
    sel_q = sel_q.in_("game_id", all_game_ids) if exp_ids else sel_q.eq("game_id", game_id)
    sel_rows = sel_q.execute().data or []

    if not sel_rows:
        return []

    chapter_ids = [r["chapter_id"] for r in sel_rows]
    added_at_map = {r["chapter_id"]: r["created_at"] for r in sel_rows}

    chapters = (
        sb.table("boardgamebuddy_guide_chapters")
        .select(_CHAPTER_SELECT)
        .in_("id", chapter_ids)
        .execute()
    ).data or []

    # The gate again, and this is the half that would be easy to forget: a
    # rulebook link ADOPTED while it was pending, and denied afterwards, is in
    # this viewer's guide and must stop being served to them. "Denial hides it
    # for everyone else" is only true if the guide filters too. The author's own
    # copy survives — see services/chapter_rulebook.is_visible_to.
    chapters = chapter_rulebook.filter_visible(sb, chapters, user_id)

    source_map = _build_source_map(sb, all_game_ids) if exp_ids else {}

    # Preserve insertion order (added_at ascending).
    by_id = {r["id"]: r for r in chapters}
    ordered_rows = [by_id[cid] for cid in chapter_ids if cid in by_id]

    out: list[MyGuideChapterResponse] = []
    for row in ordered_rows:
        base = _chapter_row_to_response(row, source_map if exp_ids else None)
        out.append(MyGuideChapterResponse(
            **base.model_dump(),
            added_at=added_at_map[row["id"]],
        ))
    return out


@router.get(
    "/games/{game_id}/my-chapters",
    response_model=list[MyGuideChapterResponse],
    status_code=200,
    summary="My reference guide for a game",
)
async def get_my_chapters(
    game_id: str = Path(..., description="Game UUID"),
    expansion_ids: Optional[str] = Query(
        None,
        description=(
            "Comma-separated expansion game UUIDs to also include. When set,"
            " the response merges the caller's chapters across the base game"
            " and these expansions, each tagged with source_game_id/source_color."
        ),
    ),
    user: CurrentUser = Depends(get_current_user),
) -> list[MyGuideChapterResponse]:
    """Return the chapters the caller has added to their guide for this game
    (and optionally for the listed expansions, merged into one response)."""
    sb = get_supabase()
    return await asyncio.to_thread(
        _get_my_chapters_sync, sb, game_id, expansion_ids, user.user_id
    )


def _add_chapter_to_my_guide_sync(
    sb: Client, game_id: str, body: AddChapterRequest, user_id: str
) -> MyGuideChapterResponse:
    chapter = (
        sb.table("boardgamebuddy_guide_chapters")
        .select(_CHAPTER_SELECT)
        .eq("id", body.chapter_id)
        .eq("game_id", game_id)
        .execute()
    )
    if not chapter.data:
        raise HTTPException(status_code=404, detail="Chapter not found for this game")

    # A chapter the caller cannot see is a chapter they cannot adopt. 404 rather
    # than 403 for the reason the pool never ships the row in the first place:
    # "this link exists but is not for you" is itself something a stranger does
    # not get to learn, and adopting by id would otherwise be the way around
    # every filter above.
    if not chapter_rulebook.filter_visible(sb, chapter.data, user_id):
        raise HTTPException(status_code=404, detail="Chapter not found for this game")

    existing = (
        sb.table("boardgamebuddy_user_chapters")
        .select("created_at, state")
        .eq("user_id", user_id)
        .eq("chapter_id", body.chapter_id)
        .execute()
    )
    if existing.data and existing.data[0].get("state") != "disliked":
        added_at = existing.data[0]["created_at"]
    elif existing.data:
        # The row is a DISLIKE and the caller is adding the chapter. Adding is
        # the act that contradicts the dislike, so it clears it rather than
        # colliding with it — the same rule as
        # boardgamebuddy_buddy_suggestion_dismissals, where sending somebody a
        # buddy request undoes having dismissed them. Without this the UNIQUE
        # (user_id, chapter_id) would make the add a 409 on a chapter the user
        # is looking at and asking for.
        #
        # `created_at` is deliberately left alone: the guide orders by it, and
        # the dislike row's timestamp is when this viewer first had an opinion
        # about the chapter, which is a truer "added" than now would be for a
        # chapter they had adopted, disliked and re-adopted.
        upd = (
            sb.table("boardgamebuddy_user_chapters")
            .update({"state": "kept", "game_id": game_id})
            .eq("user_id", user_id)
            .eq("chapter_id", body.chapter_id)
            .execute()
        )
        added_at = (
            upd.data[0]["created_at"] if upd.data else existing.data[0]["created_at"]
        )
    else:
        ins = (
            sb.table("boardgamebuddy_user_chapters")
            .insert({
                "user_id": user_id,
                "game_id": game_id,
                "chapter_id": body.chapter_id,
                "state": "kept",
            })
            .execute()
        )
        added_at = ins.data[0]["created_at"] if ins.data else None

    base = _chapter_row_to_response(chapter.data[0])
    return MyGuideChapterResponse(
        **base.model_dump(),
        added_at=added_at or base.updated_at,
    )


@router.post(
    "/games/{game_id}/my-chapters",
    response_model=MyGuideChapterResponse,
    status_code=201,
    summary="Add an existing chapter to my guide",
)
async def add_chapter_to_my_guide(
    body: AddChapterRequest,
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MyGuideChapterResponse:
    """Add a chapter from the pool to the caller's guide. Idempotent."""
    sb = get_supabase()
    return await asyncio.to_thread(
        _add_chapter_to_my_guide_sync, sb, game_id, body, user.user_id
    )


@router.delete(
    "/games/{game_id}/my-chapters/{chapter_id}",
    status_code=204,
    summary="Remove a chapter from my guide",
)
async def remove_chapter_from_my_guide(
    game_id: str = Path(..., description="Game UUID"),
    chapter_id: str = Path(..., description="Chapter UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    """Drop a chapter from the caller's guide. Does NOT delete the chapter itself. Idempotent."""
    sb = get_supabase()
    await asyncio.to_thread(
        sb.table("boardgamebuddy_user_chapters")
        .delete()
        .eq("user_id", user.user_id)
        .eq("game_id", game_id)
        .eq("chapter_id", chapter_id)
        # Scoped to the kept half (migration 033). Removing a chapter from the
        # guide is not un-disliking one, and without this filter the two
        # endpoints would share a delete: a client that fired both would clear
        # a dislike the user had not touched.
        .eq("state", "kept")
        .execute
    )
    return Response(status_code=204)


# ── Dislikes ──────────────────────────────────────────────────────────────────
#
# The inverse of the my-chapters pair above, on the same table and against the
# same UNIQUE (user_id, chapter_id) — see migration 033 for why a dislike is a
# state on that row rather than a table of its own.
#
# Only the two writes live here. There is no GET: a disliked chapter comes back
# tagged on the chapter pool the builder already fetches, so a third endpoint
# would be a second round trip for rows that are already on the wire.


def _dislike_chapter_sync(
    sb: Client, game_id: str, body: AddChapterRequest, user_id: str
) -> MessageResponse:
    chapter = (
        sb.table("boardgamebuddy_guide_chapters")
        .select("id")
        .eq("id", body.chapter_id)
        .eq("game_id", game_id)
        .execute()
    )
    if not chapter.data:
        raise HTTPException(status_code=404, detail="Chapter not found for this game")

    existing = (
        sb.table("boardgamebuddy_user_chapters")
        .select("state")
        .eq("user_id", user_id)
        .eq("chapter_id", body.chapter_id)
        .execute()
    )
    if existing.data:
        # Either it is already disliked — in which case this is the idempotent
        # second tap and the UPDATE is a no-op — or it is in the caller's guide
        # and the dislike takes it out, which is one write rather than a delete
        # and an insert precisely because the row is the opinion.
        (
            sb.table("boardgamebuddy_user_chapters")
            .update({"state": "disliked", "game_id": game_id})
            .eq("user_id", user_id)
            .eq("chapter_id", body.chapter_id)
            .execute()
        )
    else:
        (
            sb.table("boardgamebuddy_user_chapters")
            .insert({
                "user_id": user_id,
                "game_id": game_id,
                "chapter_id": body.chapter_id,
                "state": "disliked",
            })
            .execute()
        )
    return MessageResponse(message="Chapter disliked")


@router.post(
    "/games/{game_id}/disliked-chapters",
    response_model=MessageResponse,
    status_code=200,
    summary="Turn down a chapter so it stops being recommended",
)
async def dislike_chapter(
    body: AddChapterRequest,
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Hide a chapter from the caller's pool, pool count and template offers, and
    drop it from their guide if it was in it. Per-viewer, never shown to the
    author, and not a report. Idempotent."""
    # 200 rather than 201: the write is idempotent and a second tap creates
    # nothing, so "Created" would be a lie half the time — the same call made
    # by POST /plays/reactions.
    sb = get_supabase()
    return await asyncio.to_thread(
        _dislike_chapter_sync, sb, game_id, body, user.user_id
    )


@router.delete(
    "/games/{game_id}/disliked-chapters/{chapter_id}",
    status_code=204,
    summary="Un-dislike a chapter",
)
async def undislike_chapter(
    game_id: str = Path(..., description="Game UUID"),
    chapter_id: str = Path(..., description="Chapter UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    """Undo a dislike: the chapter returns to the caller's pool and counts, and
    is NOT added to their guide. Idempotent."""
    sb = get_supabase()
    await asyncio.to_thread(
        sb.table("boardgamebuddy_user_chapters")
        .delete()
        .eq("user_id", user.user_id)
        .eq("game_id", game_id)
        .eq("chapter_id", chapter_id)
        # Deleting the row is what un-dislikes, so the state filter is load
        # bearing rather than defensive: without it this endpoint would drop a
        # chapter out of the caller's guide.
        .eq("state", "disliked")
        .execute
    )
    return Response(status_code=204)


# ── Admin moderation ──────────────────────────────────────────────────────────

@router.get(
    "/admin/chapter-reports",
    response_model=list[ChapterReportResponse],
    status_code=200,
    summary="List chapter reports (admin)",
)
async def list_chapter_reports(
    status: str = Query("open", description="Filter: open | resolved"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> list[ChapterReportResponse]:
    """Admin-only: list chapter reports for moderation."""
    if status not in ("open", "resolved"):
        raise HTTPException(status_code=400, detail="status must be 'open' or 'resolved'")
    sb = get_supabase()

    rows_q = (
        sb.table("boardgamebuddy_chapter_reports")
        .select(
            "id, chapter_id, reporter_id, reason, status, created_at, resolved_at,"
            " boardgamebuddy_guide_chapters(title, content, chapter_type, game_id,"
            " boardgamebuddy_chapter_types(label),"
            " boardgamebuddy_games(name)),"
            # boardgamebuddy_chapter_reports has TWO FKs into profiles
            # (reporter_id + resolved_by). PostgREST can't pick a default
            # relationship, so disambiguate via !reporter_id and alias the
            # joined object as `reporter` for a stable JSON key.
            " reporter:boardgamebuddy_profiles!reporter_id(display_name)"
        )
        .eq("status", status)
        .order("created_at", desc=False)
    )
    rows = (await asyncio.to_thread(rows_q.execute)).data or []

    out: list[ChapterReportResponse] = []
    for r in rows:
        chapter = r.get("boardgamebuddy_guide_chapters") or {}
        type_obj = chapter.get("boardgamebuddy_chapter_types") or {}
        game_obj = chapter.get("boardgamebuddy_games") or {}
        reporter = r.get("reporter") or {}
        # Safe for a scoring-grid chapter too, and only because `content` holds
        # a generated plain-text mirror of its rows (services/chapter_grid.py).
        # Do not "fix" this to read `grid` — the whole point of the mirror is
        # that this line, and the pool's ILIKE search, need no branch.
        content = chapter.get("content") or ""
        preview = content[:240] + ("…" if len(content) > 240 else "")
        out.append(ChapterReportResponse(
            id=r["id"],
            chapter_id=r["chapter_id"],
            chapter_title=chapter.get("title") or "(deleted)",
            chapter_content_preview=preview,
            chapter_type=chapter.get("chapter_type") or "",
            chapter_type_label=type_obj.get("label"),
            game_id=chapter.get("game_id") or "",
            game_name=game_obj.get("name") or "(unknown game)",
            reporter_id=r["reporter_id"],
            reporter_name=reporter.get("display_name"),
            reason=r.get("reason"),
            status=r["status"],
            created_at=r["created_at"],
            resolved_at=r.get("resolved_at"),
        ))
    return out


def _resolve_chapter_report_sync(sb: Client, report_id: str, admin_id: str) -> MessageResponse:
    existing = (
        sb.table("boardgamebuddy_chapter_reports")
        .select("id, status")
        .eq("id", report_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Report not found")
    if existing.data[0]["status"] != "open":
        raise HTTPException(status_code=400, detail="Report is already resolved")

    sb.table("boardgamebuddy_chapter_reports").update({
        "status": "resolved",
        "resolved_by": admin_id,
        "resolved_at": "now()",
    }).eq("id", report_id).execute()
    return MessageResponse(message="Report resolved")


@router.post(
    "/admin/chapter-reports/{report_id}/resolve",
    response_model=MessageResponse,
    status_code=200,
    summary="Resolve a chapter report without deleting the chapter (admin)",
)
async def resolve_chapter_report(
    report_id: str = Path(..., description="Report UUID"),
    admin: CurrentUser = Depends(get_current_admin),
) -> MessageResponse:
    """Admin-only: mark a report as resolved with no further action."""
    sb = get_supabase()
    return await asyncio.to_thread(
        _resolve_chapter_report_sync, sb, report_id, admin.user_id
    )
