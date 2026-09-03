"""FastAPI dependencies for BoardgameBuddy."""

import asyncio
import re
from typing import Optional

from fastapi import Depends, HTTPException
from pydantic import BaseModel

import cache
from api_logger import set_request_user
from jwt_auth import SupabaseUser, get_current_supabase_user
from db import get_supabase

APP_NAME = "boardgame-buddy"

# Profile lookup cache for get_current_user. The JWT is verified locally
# against cached JWKS, so that one SELECT was the entire per-request DB cost of
# authentication — paid by every call, including the host's 2s lobby poll and
# each Gather-time write. In-process and per-worker (see cache.py): a rename on
# one worker is invisible to another until the TTL lapses, which is why the
# window is a minute rather than ten, and why nothing authorization-shaped is
# served from here (see get_current_admin).
_PROFILE_NS = "bgb.current_user"
_PROFILE_TTL_SECONDS = 60
cache.configure(_PROFILE_NS, max_entries=2048)


def invalidate_current_user(user_id: str) -> None:
    """Drop a cached profile after a write that changes it. Same-worker only —
    correctness never depends on this landing, only freshness."""
    cache.delete(_PROFILE_NS, user_id)

_USERNAME_RE = re.compile(r"[^a-z0-9_]")


def _derive_username(sb, email: Optional[str], user_id: str) -> str:
    """Pick an unused username handle for a new profile.

    Mirrors migration 017's backfill: lower-case the email local-part,
    strip everything that's not [a-z0-9_], pad if too short, then probe
    for collisions by appending an incrementing numeric suffix. Empty/
    bogus input falls back to ``user_<8-char uuid prefix>``.
    """
    base = ""
    if email:
        local = email.split("@", 1)[0].lower()
        base = _USERNAME_RE.sub("", local)
    if not base:
        base = f"user_{user_id.replace('-', '')[:8]}"
    if len(base) < 3:
        base = base.ljust(3, "0")
    if len(base) > 30:
        base = base[:30]

    candidate = base
    n = 2
    while True:
        existing = (
            sb.table("boardgamebuddy_profiles")
            .select("id")
            .eq("username", candidate)
            .limit(1)
            .execute()
        )
        if not existing.data:
            return candidate
        suffix = str(n)
        candidate = base[: 30 - len(suffix)] + suffix
        n += 1


class CurrentUser(BaseModel):
    """App-level user context."""
    user_id: str
    display_name: str
    username: str
    is_admin: bool = False


def _load_or_create_profile(su_user: SupabaseUser) -> tuple[CurrentUser, bool]:
    """Read this account's profile, creating it on first login.

    Returns (user, existed). `existed` is False for the auto-create branch,
    which the caller must not cache — the row it just wrote is what the next
    request needs to read back.

    Synchronous by design: every call in here is a blocking Supabase round
    trip, and get_current_user runs the whole thing in one worker thread rather
    than blocking the event loop three separate times.
    """
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_profiles")
        .select("id, display_name, username, is_admin")
        .eq("id", su_user.sub)
        .execute()
    )

    if result.data:
        row = result.data[0]
        return CurrentUser(
            user_id=row["id"],
            display_name=row["display_name"],
            username=row["username"],
            is_admin=bool(row.get("is_admin", False)),
        ), True

    # Auto-create profile on first auth. display_name starts at the
    # email local-part (matches old behaviour); username is the
    # stable handle, picked once and never reassigned.
    display_name = su_user.email.split("@")[0] if su_user.email else "user"
    username = _derive_username(sb, su_user.email, su_user.sub)
    sb.table("boardgamebuddy_profiles").insert({
        "id": su_user.sub,
        "display_name": display_name,
        "username": username,
    }).execute()
    return CurrentUser(
        user_id=su_user.sub,
        display_name=display_name,
        username=username,
        is_admin=False,
    ), False


async def get_current_user(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> CurrentUser:
    """Resolve Supabase Auth user to a BoardgameBuddy profile.

    Auto-creates the profile row on first login.
    """
    cached = cache.get(_PROFILE_NS, su_user.sub)
    if cached is not None:
        # set_request_user is request-scoped logging state, not part of what's
        # cached — it has to run on every request, hit or miss.
        await set_request_user(
            user_id=cached.user_id,
            user_label=cached.display_name or su_user.email,
            app=APP_NAME,
        )
        return cached

    # The Supabase client is synchronous, so this goes to a worker thread. On
    # the loop it blocked every other in-flight request in the service — all ten
    # apps — for a full round trip, and it runs on the first request of every
    # minute per user (the cache above is a 60s TTL) and on every cold worker.
    #
    # set_request_user stays out here on purpose: it writes contextvars, and a
    # contextvar set inside a to_thread worker does not propagate back to the
    # request's context, so the api_logs row would lose its user.
    user, existed = await asyncio.to_thread(_load_or_create_profile, su_user)

    # Only the found branch is cached. A miss is what auto-creates the profile,
    # and caching that would hide the row the next request needs to read back.
    if existed:
        cache.set(_PROFILE_NS, user.user_id, user, _PROFILE_TTL_SECONDS)

    await set_request_user(
        user_id=user.user_id,
        user_label=user.display_name or su_user.email,
        app=APP_NAME,
    )
    return user


async def get_current_admin(
    user: CurrentUser = Depends(get_current_user),
) -> CurrentUser:
    """Same as get_current_user, but 403s if the profile isn't an admin.

    Deliberately re-reads is_admin rather than trusting the cached copy.
    /profile/become-admin writes the flag without going through
    get_current_user, and on a multi-worker deploy no local invalidation can
    reach the other workers — so a cached `false` would lock a freshly
    promoted admin out for a full TTL. Admin traffic is negligible; this one
    extra SELECT is the right trade.
    """
    row = (
        get_supabase()
        .table("boardgamebuddy_profiles")
        .select("is_admin")
        .eq("id", user.user_id)
        .execute()
    )
    is_admin = bool(row.data and row.data[0].get("is_admin"))
    if not is_admin:
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return user


async def maybe_supabase_user(authorization: Optional[str]) -> Optional[SupabaseUser]:
    """Decode the bearer token if present; return None when missing or invalid.

    For anon-friendly endpoints that surface a richer per-user view to signed-in
    callers without forcing auth.
    """
    if not authorization:
        return None
    try:
        return await get_current_supabase_user(authorization=authorization)
    except HTTPException:
        return None
