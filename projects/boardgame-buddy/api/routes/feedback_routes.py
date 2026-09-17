"""The Dev feedback board — what users want built next.

Its own module rather than more routes on profile_routes.py, for the reason
reaction_routes.py states about itself: this is its own object with its own
lifecycle, and .claude/rules/backend-python.md wants files split by domain rather
than grown.

THE ONE SECURITY-SHAPED THING IN HERE. A non-admin must never see a resolved
item, and the gate for that is on this side of the wire, not in the client's
filter chips: `_effective_status` forces `open` for anyone who is not an admin,
whatever the query string said. The frontend hides the Open/Resolved control from
non-admins too, but that is chrome — the same relationship ui/admin-gate.js
describes between itself and get_current_admin.

Admin-ness is read with `_is_admin` rather than `Depends(get_current_admin)`,
because GET /feedback serves everybody and only *widens* for an admin. The two
write endpoints that are genuinely admin-only do use the dependency.
"""

import asyncio

from fastapi import Depends, HTTPException, Path, Query

from db import get_supabase

from . import router
from .constants import FeedbackStatus
from .dependencies import CurrentUser, get_current_admin, get_current_user
from .models import (
    FeedbackCreate,
    FeedbackLikeResponse,
    FeedbackOptionResponse,
    FeedbackResponse,
)
from .services import feedback_service


def _effective_status(user: CurrentUser, requested: str | None) -> str:
    """Which half of the board this caller actually gets.

    A non-admin gets `open`, full stop — resolving an item is what takes it off
    their list, so honouring `?status=resolved` from one would undo the feature.
    An admin gets what they asked for, defaulting to `open` so the screen's first
    paint is the same for everyone.
    """
    if not user.is_admin:
        return FeedbackStatus.OPEN.value
    if requested in (FeedbackStatus.OPEN.value, FeedbackStatus.RESOLVED.value):
        return requested
    if requested:
        raise HTTPException(
            status_code=400, detail="status must be 'open' or 'resolved'"
        )
    return FeedbackStatus.OPEN.value


@router.get(
    "/feedback-types",
    response_model=list[FeedbackOptionResponse],
    status_code=200,
    summary="List feedback types",
)
async def list_feedback_types(
    _user: CurrentUser = Depends(get_current_user),
) -> list[FeedbackOptionResponse]:
    """Return the feedback-type lookup rows, in display order."""
    # A top-level kebab path, not /feedback/types, mirroring /chapter-types: the
    # nested form is two segments and would be shadowed the day a
    # GET /feedback/{id} lands. See routes/__init__.py on declaration order.
    rows = await asyncio.to_thread(feedback_service.list_types, get_supabase())
    return [FeedbackOptionResponse(**r) for r in rows]


@router.get(
    "/feedback-topics",
    response_model=list[FeedbackOptionResponse],
    status_code=200,
    summary="List feedback topics",
)
async def list_feedback_topics(
    _user: CurrentUser = Depends(get_current_user),
) -> list[FeedbackOptionResponse]:
    """Return the feedback-topic lookup rows, in display order."""
    rows = await asyncio.to_thread(feedback_service.list_topics, get_supabase())
    return [FeedbackOptionResponse(**r) for r in rows]


@router.get(
    "/feedback",
    response_model=list[FeedbackResponse],
    status_code=200,
    summary="The Dev feedback board, ordered by likes",
)
async def list_feedback(
    status: str | None = Query(
        None, description="open | resolved. Admin only; non-admins always get open."
    ),
    type: str | None = Query(None, description="Filter by feedback type id"),
    topic: str | None = Query(None, description="Filter by topic id"),
    user: CurrentUser = Depends(get_current_user),
) -> list[FeedbackResponse]:
    """List feedback items, most-liked first, then newest."""
    rows = await asyncio.to_thread(
        feedback_service.list_feedback,
        get_supabase(),
        user.user_id,
        _effective_status(user, status),
        type,
        topic,
    )
    return [FeedbackResponse(**r) for r in rows]


@router.post(
    "/feedback",
    response_model=FeedbackResponse,
    status_code=201,
    summary="Submit feedback",
)
async def create_feedback(
    payload: FeedbackCreate,
    user: CurrentUser = Depends(get_current_user),
) -> FeedbackResponse:
    """Add an item to the board, liked by its author so it starts at 1."""
    # 201 here where the like endpoints below are 200: this genuinely creates a
    # row every time, and unlike a like it is not idempotent — filing the same
    # thing twice means the person said it twice.
    body = payload.body.strip()
    if not body:
        raise HTTPException(status_code=400, detail="Feedback cannot be empty")
    row = await asyncio.to_thread(
        feedback_service.create,
        get_supabase(),
        user.user_id,
        payload.feedback_type,
        payload.topic,
        body,
    )
    return FeedbackResponse(**row)


@router.post(
    "/feedback/{feedback_id}/like",
    response_model=FeedbackLikeResponse,
    status_code=200,
    summary="Like a feedback item",
)
async def like_feedback(
    feedback_id: str = Path(..., description="Feedback UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> FeedbackLikeResponse:
    """Add the caller's like. Idempotent — a second tap changes nothing."""
    # 200 rather than 201, the same argument reaction_routes makes: the composite
    # PK makes the write idempotent, so "Created" would be a lie half the time.
    count = await asyncio.to_thread(
        feedback_service.like, get_supabase(), user.user_id, feedback_id
    )
    return FeedbackLikeResponse(feedback_id=feedback_id, liked=True, like_count=count)


@router.delete(
    "/feedback/{feedback_id}/like",
    response_model=FeedbackLikeResponse,
    status_code=200,
    summary="Take back a like",
)
async def unlike_feedback(
    feedback_id: str = Path(..., description="Feedback UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> FeedbackLikeResponse:
    """Remove the caller's like. Returns the count so the client reconciles."""
    count = await asyncio.to_thread(
        feedback_service.unlike, get_supabase(), user.user_id, feedback_id
    )
    return FeedbackLikeResponse(feedback_id=feedback_id, liked=False, like_count=count)


@router.post(
    "/feedback/{feedback_id}/resolve",
    response_model=FeedbackResponse,
    status_code=200,
    summary="Mark feedback resolved (admin)",
)
async def resolve_feedback(
    feedback_id: str = Path(..., description="Feedback UUID"),
    admin: CurrentUser = Depends(get_current_admin),
) -> FeedbackResponse:
    """Admin-only: take an item off everyone else's board."""
    row = await asyncio.to_thread(
        feedback_service.set_status, get_supabase(), admin.user_id, feedback_id, True
    )
    return FeedbackResponse(**row)


@router.post(
    "/feedback/{feedback_id}/reopen",
    response_model=FeedbackResponse,
    status_code=200,
    summary="Reopen resolved feedback (admin)",
)
async def reopen_feedback(
    feedback_id: str = Path(..., description="Feedback UUID"),
    admin: CurrentUser = Depends(get_current_admin),
) -> FeedbackResponse:
    """Admin-only: put a resolved item back on the board."""
    # Resolving is reversible on purpose — it is the admin's read of "this is
    # done", and a read can be wrong. Nothing here deletes.
    row = await asyncio.to_thread(
        feedback_service.set_status, get_supabase(), admin.user_id, feedback_id, False
    )
    return FeedbackResponse(**row)
