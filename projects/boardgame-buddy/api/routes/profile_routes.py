"""User profile endpoints."""

import asyncio
from typing import Any

from fastapi import Depends, HTTPException, Query, Path

from auth import ADMIN_API_KEY
from db import get_supabase
from jwt_auth import SupabaseUser, get_current_supabase_user

from . import router
from .dependencies import CurrentUser, get_current_user, invalidate_current_user
from .models import (
    AdminKeyBody,
    MessageResponse,
    ProfileCreate,
    ProfileResponse,
    ProfileSearchResult,
    PublicProfileResponse,
)
from .services import account_deletion_service, profile_service


@router.get(
    "/profile",
    response_model=ProfileResponse,
    status_code=200,
    summary="Get current user profile",
)
async def get_profile(
    user: CurrentUser = Depends(get_current_user),
) -> ProfileResponse:
    """Get the current user's profile.

    Routed through ``get_current_user`` so first-time callers (including
    cross-app users whose ``auth.users`` row was created by another vibelab
    app) get a ``boardgamebuddy_profiles`` row auto-created here instead of
    bouncing back to auth on a 404.
    """
    sb = get_supabase()
    result = await asyncio.to_thread(
        sb.table("boardgamebuddy_profiles").select("*").eq("id", user.user_id).execute
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    return ProfileResponse(**result.data[0])


@router.post(
    "/profile",
    response_model=ProfileResponse,
    status_code=200,
    summary="Update display name and/or avatar on the current user's profile",
)
async def update_profile(
    body: ProfileCreate,
    user: CurrentUser = Depends(get_current_user),
) -> ProfileResponse:
    """Patch the current user's display_name, avatar and/or notification tier.

    Every field is independently optional — the settings page saves name,
    avatar and notification tier separately. Username is locked in at signup
    and can't be changed here. Passing avatar=null clears the customization and
    reverts to the BGB default rendered client-side.

    push_tier (migration 017) rides this endpoint rather than a /push route of
    its own because it is an account preference like the other two, and this is
    already the one path the FE knows how to save a profile through and
    reconcile from — window.store.user updates and every subscriber re-renders,
    for free.
    """
    patch: dict[str, Any] = {}
    if body.display_name is not None:
        patch["display_name"] = body.display_name
    if "avatar" in body.model_fields_set:
        patch["avatar"] = body.avatar.model_dump() if body.avatar is not None else None
    # Identity edits retire the first-time onboarding modal — the user has
    # demonstrably interacted with their profile. Tracked separately from the
    # patch's emptiness because the notification tier below is NOT such an
    # edit: it is reachable from Settings without ever meeting that modal, and
    # turning notifications on must not silently dismiss it.
    identity_touched = bool(patch)
    if body.push_tier is not None:
        patch["push_tier"] = str(body.push_tier)
    if not patch:
        raise HTTPException(status_code=400, detail="Nothing to update")
    if identity_touched:
        patch["needs_setup"] = False
    sb = get_supabase()
    result = await asyncio.to_thread(
        sb.table("boardgamebuddy_profiles").update(patch).eq("id", user.user_id).execute
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    # display_name rides on CurrentUser (it becomes the host's participant row
    # on the next hosted lobby), so drop the cached copy rather than let a
    # rename take up to a minute to show up.
    invalidate_current_user(user.user_id)
    return ProfileResponse(**result.data[0])


@router.post(
    "/profile/become-admin",
    response_model=ProfileResponse,
    status_code=200,
    summary="Promote current user to admin by admin key",
)
async def become_admin(
    body: AdminKeyBody,
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> ProfileResponse:
    """Exchange the shared admin API key for the is_admin flag on this user's profile."""
    if not ADMIN_API_KEY or body.admin_key != ADMIN_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid admin key")
    sb = get_supabase()
    result = await asyncio.to_thread(
        sb.table("boardgamebuddy_profiles")
        .update({"is_admin": True})
        .eq("id", su_user.sub)
        .execute
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    # get_current_admin re-reads is_admin anyway, so this is belt and braces —
    # it keeps the cached display copy from lagging on the worker that served
    # the promotion.
    invalidate_current_user(su_user.sub)
    return ProfileResponse(**result.data[0])


@router.get(
    "/profiles/search",
    response_model=list[ProfileSearchResult],
    status_code=200,
    summary="Search profiles by display name (for buddy linking)",
)
async def search_profiles(
    q: str = Query(..., min_length=1, max_length=50, description="Display name fragment"),
    user: CurrentUser = Depends(get_current_user),
) -> list[ProfileSearchResult]:
    """Find other BoardgameBuddy users by display name *or* username
    (case-insensitive substring match). Email shown for tiebreaking."""
    sb = get_supabase()
    # PostgREST `.or_()` takes a comma-joined list of column ops. Both
    # columns are matched with case-insensitive `like`; the lowercased
    # `username` column makes the lower-vs-upper distinction moot for
    # itself, but using `ilike` keeps the two predicates symmetrical.
    needle = q.replace(",", "").replace("(", "").replace(")", "")
    rows = await asyncio.to_thread(
        sb.table("boardgamebuddy_profiles")
        .select("id, display_name, username, avatar")
        .or_(f"display_name.ilike.%{needle}%,username.ilike.%{needle}%")
        .neq("id", user.user_id)
        .order("display_name")
        .limit(20)
        .execute
    )
    return [
        ProfileSearchResult(
            id=row["id"],
            display_name=row["display_name"],
            username=row["username"],
            avatar=row.get("avatar"),
        )
        for row in (rows.data or [])
    ]


@router.get(
    "/users/{user_id}/profile",
    response_model=PublicProfileResponse,
    status_code=200,
    summary="Get a user's public profile",
)
async def get_public_profile(
    user_id: str = Path(..., description="User UUID"),
    viewer: CurrentUser = Depends(get_current_user),
) -> PublicProfileResponse:
    """Profiles are fully public — anyone signed in can see anyone else's profile."""
    return await asyncio.to_thread(
        profile_service.fetch_public_profile, get_supabase(), viewer.user_id, user_id
    )


@router.get(
    "/profile/bundle",
    response_model=dict,
    status_code=200,
    summary="Single-call Profile view bundle (stats + shelves + plays + caches)",
)
async def get_profile_bundle(
    target_user_id: str | None = Query(
        None,
        description=(
            "User whose profile to load. Defaults to the caller (Profile Self). "
            "Pass another user's id for Profile Other — buddies / requests are "
            "omitted from the response in that case, and the recent-plays log, "
            "the shared record and the top-three games are buddies-only."
        ),
    ),
    col_per_page: int = Query(12, ge=1, le=100, description="Per-page size for each shelf's first page"),
    plays_per_page: int = Query(10, ge=1, le=50, description="Per-page size for the recent-plays block"),
    viewer: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Return everything Profile Self / Profile Other need on cold load in one round trip.

    Backed by the `bgb_profile_bundle` RPC; the shape mirrors what the FE
    currently destructures from /users/{id}/stats + /collection/grid (×3) +
    /plays + /collection + /buddies + /buddies/requests.

    Visibility (migration 064): a viewer who is neither the target nor an
    accepted buddy gets `recent_plays`, `together` and `top_games` as null.
    They still get the collection shelves and the stats block — the four
    headline numbers a public profile has always shown — plus
    `recent_plays_total`, which is one of them.
    """
    sb = get_supabase()
    target = target_user_id or viewer.user_id
    result = await asyncio.to_thread(
        sb.rpc(
            "bgb_profile_bundle",
            {
                "viewer": viewer.user_id,
                "target": target,
                "col_per_page": col_per_page,
                "plays_per_page": plays_per_page,
            },
        ).execute
    )
    return result.data or {}


@router.delete(
    "/profile",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete the current user's account and data",
)
async def delete_profile(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> MessageResponse:
    """Delete the current user's account: play photos, rows, and the login itself.

    Thin on purpose — the order of the three steps and what each failure
    leaves behind is the substance, and it lives in
    `services/account_deletion_service.py`. The short version: photos first
    (so a flaky object store costs a retry, not the photos), rows second
    (cascading to collections, plays, buddies, sessions, achievements and the
    rest, with authored guide chapters keeping their text under a NULL
    `created_by`), and the Identity Platform credential last, so a failure
    always leaves a signed-in caller able to retry.

    THE CREDENTIAL IS THE POINT. Deleting only the rows left the account alive
    at the provider, so signing back in with Google re-created an empty
    profile and signing up again with the same address answered
    `auth/email-already-in-use` — a deletion that told the user it had not
    happened.

    Depends on `get_current_supabase_user` rather than `get_current_user`, and
    must keep doing so: the latter auto-creates a profile row for a caller who
    has none, which on a retry after a partial failure would resurrect the
    account this endpoint just deleted.
    """
    try:
        await account_deletion_service.delete_account(
            app_uid=su_user.sub, provider_uid=su_user.provider_uid
        )
    except account_deletion_service.DeletionBlocked as exc:
        # Nothing was touched. 503 rather than 500: the account is intact and
        # the same request will work once the operator fixes the config.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except account_deletion_service.DeletionFailed as exc:
        # Something was — and if it got as far as the rows, a cached
        # CurrentUser would go on serving a profile that no longer exists for
        # up to a TTL. Dropped here as well as on the success path, because
        # the failure that leaves rows deleted is the one where a stale cache
        # is most confusing.
        invalidate_current_user(su_user.sub)
        # The client keeps the session so the user can retry; every step is
        # idempotent, so a retry finishes the job.
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    # The rows are gone; a cached CurrentUser for this id would keep a deleted
    # account authenticating for up to a TTL on this worker.
    invalidate_current_user(su_user.sub)
    return MessageResponse(message="Account deleted")
