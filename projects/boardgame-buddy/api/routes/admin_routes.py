"""Cross-domain admin summary.

Every other admin endpoint lives with the domain it moderates — chapter
reports in chapter_routes, the catalog backfills in game_routes. This module
exists for the one thing that spans them: the review counts behind the
Settings gear's notification dot.

It is deliberately ONE endpoint rather than three. The dot is on the global
header, so it is fetched on every boot for every admin; three round trips to
light one dot is the wrong price, and having the frontend derive counts by
fetching the list endpoints would be worse still — those return full
GameSummary rows (hundreds of them, mid-backfill) to arrive at an integer.

Three counts now, not five: the description, stats and publisher queues became
one metadata queue in migration 045, and collapsing them fixed an over-count as
well as a round trip — a game missing both its blurb and its year used to be
counted twice, so the gear's dot reported more work than existed.

Four since migration 052, which added the rulebook-link queue. That one is
worth reading differently from the other three: the catalog backfills are work
that can wait, where a pending rulebook link is an unreviewed outbound link that
readers can already follow.
"""

import asyncio
from typing import Any

from fastapi import Depends

from supabase import Client

from db import get_supabase

from . import router
from .constants import ChapterLayout, RulebookStatus
from .dependencies import CurrentUser, get_current_admin
from .models import AdminReviewCounts


def _count_query(sb: Client, table: str) -> Any:
    """A builder for PostgREST's exact-count header; the caller narrows it and
    reads `.count` off the result instead of a fetched list."""
    return sb.table(table).select("id", count="exact")


def _get_admin_review_counts_sync(sb: Client) -> AdminReviewCounts:
    # limit(1) rather than fetching the rows: the count rides PostgREST's
    # Content-Range header, so the body is one row we throw away instead of
    # the whole table.
    reports = (
        _count_query(sb, "boardgamebuddy_chapter_reports")
        .eq("status", "open")
        .limit(1)
        .execute()
    )
    missing_images = (
        _count_query(sb, "boardgamebuddy_games")
        .or_("image_url.is.null,thumbnail_url.is.null")
        .limit(1)
        .execute()
    )
    # Short of anything one /thing?stats=1 read would give (migration 045).
    # NULL publishers, not '{}': a game BGG credits to nobody has been answered
    # and has nothing left for an admin to do.
    #
    # ONE query where there were three, and deliberately NOT the backfill's
    # queue predicate. This counts rows that are still INCOMPLETE — including
    # ones BoardGameGeek has nothing more to give, which stay listed in the
    # panel on purpose — so it is not expected to reach zero. The queue that
    # has to terminate is `bgg_meta_synced_at IS NULL`, and it lives with the
    # endpoint that drains it.
    missing_metadata = (
        _count_query(sb, "boardgamebuddy_games")
        .or_(
            "description.is.null,bgg_stats_synced_at.is.null,"
            "publishers.is.null,year_published.is.null"
        )
        .not_.is_("bgg_id", "null")
        .limit(1)
        .execute()
    )

    # Rulebook links still waiting on a decision (migration 052). Unlike the
    # three above, this queue is not tidy-up: a pending link is already live for
    # its author's accepted buddies, so the number here is readers following an
    # unreviewed outbound link. Off the partial index
    # idx_bgb_chapters_rulebook_status, and filtered on the layout as well as
    # the status because moderation_status is NULL on every other chapter and a
    # status filter alone would quietly start counting prose the day that
    # changes.
    #
    # PENDING only, which since migration 053 is narrower than "unreviewed":
    # an `unlisted` link is equally unreviewed and equally live for its
    # author's buddies, and is nobody's work — its author asked for nothing.
    # Counting those would put a number on this badge that no amount of
    # admin work could ever clear.
    rulebook_links = (
        _count_query(sb, "boardgamebuddy_guide_chapters")
        .eq("layout", str(ChapterLayout.RULEBOOK_LINK))
        .eq("moderation_status", str(RulebookStatus.PENDING))
        .limit(1)
        .execute()
    )

    return AdminReviewCounts(
        chapter_reports=reports.count or 0,
        missing_images=missing_images.count or 0,
        missing_metadata=missing_metadata.count or 0,
        rulebook_links=rulebook_links.count or 0,
    )


@router.get(
    "/admin/review-counts",
    response_model=AdminReviewCounts,
    status_code=200,
    summary="Counts of everything awaiting admin review (admin)",
)
async def get_admin_review_counts(
    _admin: CurrentUser = Depends(get_current_admin),
) -> AdminReviewCounts:
    """Admin-only: how many items each admin tool currently has to act on."""
    return await asyncio.to_thread(_get_admin_review_counts_sync, get_supabase())
