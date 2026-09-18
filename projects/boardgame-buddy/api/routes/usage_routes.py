"""App-wide usage stats for admins — the Usage spoke's two reads.

Kept apart from admin_routes (the review-count dot) and admin_run_routes (the
catalog run logs) because this is the one admin surface that moderates nothing:
it answers "how is the app being used", which is a different question from
"what is waiting for me".

TWO ENDPOINTS RATHER THAN ONE, and the split is about latency, not tidiness.
Everything in the first is one SQL round trip and paints the screen. The second
walks both R2 buckets with ListObjectsV2 — dozens of HTTP requests, seconds in
the worst case — so it is its own request, fetched after first paint, and the
numbers that were ready immediately are not held behind the slow one.
"""

import asyncio
from typing import Any

from fastapi import Depends, Query

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_admin
from .models import BucketUsageResponse
from .services import usage_service


@router.get(
    "/admin/usage",
    response_model=dict,
    status_code=200,
    summary="App-wide usage stats (admin)",
)
async def get_admin_usage(
    refresh: bool = Query(False, description="Bypass the 5-minute server cache"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> dict[str, Any]:
    """Accounts, active accounts, Postgres footprint, screens and feature counts.

    Returned as a plain dict rather than a Pydantic model, matching
    GET /users/me/stats/detail: `bgb_admin_usage_stats()` is the shape's single
    source of truth, and a second declaration of its eight nested blocks in
    models.py would only be one more thing to drift. The frontend carries the
    shape as a JSDoc `@typedef` in web/domain/admin-usage.js instead.
    """
    return await asyncio.to_thread(usage_service.fetch_usage, get_supabase(), refresh)


@router.get(
    "/admin/usage/buckets",
    response_model=BucketUsageResponse,
    status_code=200,
    summary="R2 bucket object counts and sizes (admin)",
)
async def get_admin_bucket_usage(
    refresh: bool = Query(False, description="Bypass the 6-hour server cache"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> BucketUsageResponse:
    """How much is in the play-photo and cover-art buckets.

    Never 502s for a bucket it cannot read: an unconfigured or unlistable
    bucket comes back as data so the screen can say which it is.
    """
    payload = await asyncio.to_thread(usage_service.fetch_bucket_usage, refresh)
    return BucketUsageResponse(**payload)
