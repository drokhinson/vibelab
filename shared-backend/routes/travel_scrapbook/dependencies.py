"""FastAPI dependencies for Travel Scrapbook."""

import hashlib
import re
from typing import Optional

from fastapi import Depends, Header, HTTPException
from pydantic import BaseModel

from api_logger import set_request_user
from auth import extract_bearer_token
from db import get_supabase
from jwt_auth import SupabaseUser, get_current_supabase_user

from .constants import APP_NAME, CAPTURE_TOKEN_PREFIX

_USERNAME_RE = re.compile(r"[^a-z0-9_]")


def hash_capture_token(token: str) -> str:
    """sha256 hex of a personal capture token. A deterministic digest (not
    bcrypt) is deliberate: tokens are 256-bit random so offline guessing is
    moot, and /capture must look the row up BY token — which needs an
    indexable hash."""
    return hashlib.sha256(token.encode()).hexdigest()


def _derive_username(sb, email: Optional[str], user_id: str) -> str:
    """Pick an unused username handle for a new profile.

    Lower-case the email local-part, strip everything that's not [a-z0-9_],
    pad if too short, then probe for collisions by appending an incrementing
    numeric suffix. Empty/bogus input falls back to ``user_<8-char uuid>``.
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
            sb.table("travelscrapbook_profiles")
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


def _resolve_profile(sb, user_id: str, email: Optional[str]) -> CurrentUser:
    """Load the Travel Scrapbook profile for a user id, auto-creating it on
    first login (shared by JWT and capture-token auth paths)."""
    result = (
        sb.table("travelscrapbook_profiles")
        .select("id, display_name, username, is_admin")
        .eq("id", user_id)
        .execute()
    )

    if result.data:
        row = result.data[0]
        return CurrentUser(
            user_id=row["id"],
            display_name=row["display_name"],
            username=row["username"],
            is_admin=bool(row.get("is_admin", False)),
        )

    display_name = email.split("@")[0] if email else "traveler"
    username = _derive_username(sb, email, user_id)
    sb.table("travelscrapbook_profiles").insert({
        "id": user_id,
        "display_name": display_name,
        "username": username,
    }).execute()
    return CurrentUser(
        user_id=user_id,
        display_name=display_name,
        username=username,
        is_admin=False,
    )


async def get_current_user(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> CurrentUser:
    """Resolve Supabase Auth user to a Travel Scrapbook profile.

    Auto-creates the profile row on first login.
    """
    sb = get_supabase()
    user = _resolve_profile(sb, su_user.sub, su_user.email)
    await set_request_user(
        user_id=user.user_id,
        user_label=user.display_name or su_user.email,
        app=APP_NAME,
    )
    return user


async def get_capture_user(
    authorization: Optional[str] = Header(None),
) -> CurrentUser:
    """Auth for POST /capture: a personal capture token (iOS Shortcut) OR a
    normal Supabase JWT (web share target / quick-paste / bookmarklet).

    Capture tokens carry a recognizable prefix, so we route on it instead of
    probing both stores on every request.
    """
    token = extract_bearer_token(authorization)
    if not token.startswith(CAPTURE_TOKEN_PREFIX):
        return await get_current_user(await get_current_supabase_user(authorization))

    sb = get_supabase()
    rows = (
        sb.table("travelscrapbook_capture_tokens")
        .select("id, user_id, revoked_at")
        .eq("token_hash", hash_capture_token(token))
        .execute()
    )
    if not rows.data or rows.data[0]["revoked_at"] is not None:
        raise HTTPException(status_code=401, detail="Invalid or revoked capture token")
    row = rows.data[0]
    sb.table("travelscrapbook_capture_tokens").update(
        {"last_used_at": "now()"}
    ).eq("id", row["id"]).execute()

    user = _resolve_profile(sb, row["user_id"], None)
    await set_request_user(
        user_id=user.user_id,
        user_label=user.display_name,
        app=APP_NAME,
    )
    return user
