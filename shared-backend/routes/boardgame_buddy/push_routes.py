"""Web Push endpoints — the device side of notifications (migration 017).

Three routes and no more. The per-account TIER is deliberately not here: it is
an account preference like display name and avatar, so it saves through
POST /profile, which the FE already knows how to call and reconcile. What lives
here is the per-DEVICE half — this browser's subscription — which nothing else
in the app has any reason to know about.

GET /push/config is unauthenticated-adjacent but still behind the session,
because there is no screen that asks for it before sign-in and no reason to
publish the key more widely than that. It is safe to hand out regardless: the
VAPID public key IS the thing browsers subscribe with.
"""

import asyncio

from fastapi import Depends

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import (
    MessageResponse,
    PushConfigResponse,
    PushSubscriptionCreate,
    PushSubscriptionDelete,
)
from .services import push_service


@router.get(
    "/push/config",
    response_model=PushConfigResponse,
    status_code=200,
    summary="Whether push is available, and the key to subscribe with",
)
async def get_push_config(
    user: CurrentUser = Depends(get_current_user),
) -> PushConfigResponse:
    """Report whether the server can send push, and the VAPID public key."""
    return PushConfigResponse(
        enabled=push_service.enabled(),
        vapid_public_key=push_service.public_key() or None,
    )


@router.post(
    "/push/subscriptions",
    response_model=MessageResponse,
    status_code=200,
    summary="Register this device to receive push notifications",
)
async def create_push_subscription(
    body: PushSubscriptionCreate,
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Store (or re-point) this browser's push subscription for the caller."""
    sb = get_supabase()
    # Upsert on endpoint, not on (user_id, endpoint): the endpoint is globally
    # unique by construction, and conflicting on it is what makes the same
    # browser signing in as a second account MOVE its row rather than end up
    # with two, which would push both accounts' notifications to one device.
    #
    # user_id is in the payload for exactly that reason — it is a field that
    # can legitimately change on conflict.
    upsert = sb.table("boardgamebuddy_push_subscriptions").upsert(
        {
            "user_id": user.user_id,
            "endpoint": body.endpoint,
            "p256dh": body.p256dh,
            "auth": body.auth,
            "user_agent": body.user_agent,
            # A device that was failing and has just re-subscribed is healthy
            # again; carrying the old count forward would libel it.
            "failure_count": 0,
        },
        on_conflict="endpoint",
    )
    await asyncio.to_thread(upsert.execute)
    return MessageResponse(message="Subscribed")


@router.delete(
    "/push/subscriptions",
    response_model=MessageResponse,
    status_code=200,
    summary="Stop sending push notifications to this device",
)
async def delete_push_subscription(
    body: PushSubscriptionDelete,
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Forget this browser's push subscription."""
    sb = get_supabase()
    # Scoped to the caller as well as the endpoint. The endpoint alone would be
    # enough to find the row, but it travels in a request body and treating
    # possession of it as authority to delete somebody else's device is a rule
    # worth not writing down anywhere.
    delete = (
        sb.table("boardgamebuddy_push_subscriptions")
        .delete()
        .eq("user_id", user.user_id)
        .eq("endpoint", body.endpoint)
    )
    await asyncio.to_thread(delete.execute)
    return MessageResponse(message="Unsubscribed")
