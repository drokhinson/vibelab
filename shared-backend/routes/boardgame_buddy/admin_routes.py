"""Cross-domain admin summary.

Every other admin endpoint lives with the domain it moderates — chapter
reports in chapter_routes, the catalog backfills in game_routes. This module
exists for the one thing that spans them: the review counts behind the
Settings gear's notification dot.

It is deliberately ONE endpoint rather than three. The dot is on the global
header, so it is fetched on every boot for every admin; three round trips to
light one dot is the wrong price, and having the frontend derive counts by
fetching the three list endpoints would be worse still — those return full
GameSummary rows (hundreds of them, mid-backfill) to arrive at an integer.
"""

from fastapi import Depends

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_admin
from .models import AdminReviewCounts


def _count(sb, table: str) -> int:
    """Row count via PostgREST's exact-count header, not a fetched list.

    Returns a builder the caller narrows further; see call sites below.
    """
    return sb.table(table).select("id", count="exact")


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
    sb = get_supabase()

    # limit(1) rather than fetching the rows: the count rides PostgREST's
    # Content-Range header, so the body is one row we throw away instead of
    # the whole table.
    reports = (
        _count(sb, "boardgamebuddy_chapter_reports")
        .eq("status", "open")
        .limit(1)
        .execute()
    )
    missing_images = (
        _count(sb, "boardgamebuddy_games")
        .or_("image_url.is.null,thumbnail_url.is.null")
        .limit(1)
        .execute()
    )
    missing_descriptions = (
        _count(sb, "boardgamebuddy_games")
        .is_("description", "null")
        .limit(1)
        .execute()
    )

    return AdminReviewCounts(
        chapter_reports=reports.count or 0,
        missing_images=missing_images.count or 0,
        missing_descriptions=missing_descriptions.count or 0,
    )
