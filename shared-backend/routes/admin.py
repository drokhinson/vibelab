"""
routes/admin.py — Admin dashboard API routes
All routes at /api/v1/admin/...
Protected by ADMIN_API_KEY (Bearer token).
"""

import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Header, Query

from db import get_supabase
from auth import hash_password, require_admin
from shared_models import HealthResponse

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


# ---------------------------------------------------------------------------
# Per-app delete handlers
# ---------------------------------------------------------------------------

async def _delete_wealthmate_user(sb, user_id: str):
    """Delete a wealthmate user and cascade-remove all their data."""
    # Look up user
    user = sb.table("wealthmate_users").select("id, username").eq("id", user_id).execute()
    if not user.data:
        raise HTTPException(status_code=404, detail="User not found")
    username = user.data[0]["username"]

    # Find couple membership
    membership = (
        sb.table("wealthmate_couple_members")
        .select("couple_id")
        .eq("user_id", user_id)
        .execute()
    )
    couple_id = membership.data[0]["couple_id"] if membership.data else None

    if couple_id:
        # Check if user is the only member of their household
        members = (
            sb.table("wealthmate_couple_members")
            .select("id, user_id")
            .eq("couple_id", couple_id)
            .execute()
        )
        is_solo = len(members.data or []) <= 1

        if is_solo:
            # Solo household — delete everything
            checkins = sb.table("wealthmate_checkins").select("id").eq("couple_id", couple_id).execute()
            checkin_ids = [c["id"] for c in (checkins.data or [])]
            if checkin_ids:
                sb.table("wealthmate_checkin_values").delete().in_("checkin_id", checkin_ids).execute()

            accts = sb.table("wealthmate_accounts").select("id").eq("couple_id", couple_id).execute()
            acct_ids = [a["id"] for a in (accts.data or [])]
            if acct_ids:
                sb.table("wealthmate_account_loan_details").delete().in_("account_id", acct_ids).execute()

            groups = sb.table("wealthmate_expense_groups").select("id").eq("couple_id", couple_id).execute()
            group_ids = [g["id"] for g in (groups.data or [])]
            if group_ids:
                sb.table("wealthmate_expense_items").delete().in_("group_id", group_ids).execute()

            sb.table("wealthmate_checkins").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_accounts").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_expense_groups").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_recurring_expenses").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_invitations").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_couple_members").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_couples").delete().eq("id", couple_id).execute()
        else:
            # Merged household — detach user, keep partner's data
            sb.table("wealthmate_couple_members").delete().eq("user_id", user_id).execute()
            sb.table("wealthmate_accounts").update(
                {"owner_user_id": None}
            ).eq("couple_id", couple_id).eq("owner_user_id", user_id).execute()

    # Delete invitations sent by or to this user
    sb.table("wealthmate_invitations").delete().eq("from_user_id", user_id).execute()
    sb.table("wealthmate_invitations").delete().eq("to_username", username).execute()

    # Delete the user
    sb.table("wealthmate_users").delete().eq("id", user_id).execute()
    return {"deleted": True, "user_id": user_id, "username": username}


# Registry of apps that have user tables.
# Update this dict when a new app adopts shared auth.
async def _delete_supabase_auth_user(sb, user_id: str, profile_table: str):
    """Delete a user backed by Supabase Auth.

    Removing the auth.users row cascades to <app>_profiles via the profile's
    ON DELETE CASCADE FK, which in turn cascades to every app data table
    whose user FK targets the profile. So one auth-side delete cleans
    everything up — no per-table teardown needed.
    """
    profile = (
        sb.table(profile_table)
        .select("id, display_name")
        .eq("id", user_id)
        .execute()
    )
    if not profile.data:
        raise HTTPException(status_code=404, detail="User not found")
    display_name = profile.data[0].get("display_name")

    sb.auth.admin.delete_user(user_id)
    return {"deleted": True, "user_id": user_id, "display_name": display_name}


async def _delete_daywordplay_user(sb, user_id: str):
    return await _delete_supabase_auth_user(sb, user_id, "daywordplay_profiles")


async def _delete_plantplanner_user(sb, user_id: str):
    return await _delete_supabase_auth_user(sb, user_id, "plantplanner_profiles")


async def _delete_boardgamebuddy_user(sb, user_id: str):
    return await _delete_supabase_auth_user(sb, user_id, "boardgamebuddy_profiles")


# Per-app config. `kind` selects the listing + reset-code path:
#   - "legacy_users": app keeps a custom <prefix>_users table (bcrypt + recovery_hash)
#   - "supabase_auth": identity lives in auth.users; profile fields in <prefix>_profiles
APPS_WITH_USERS = {
    "wealthmate": {
        "kind": "legacy_users",
        "table": "wealthmate_users",
        "identity_columns": "id, username, display_name, email, created_at",
        "delete_handler": _delete_wealthmate_user,
    },
    "spotme": {
        "kind": "legacy_users",
        "table": "spotme_users",
        "identity_columns": "id, username, display_name, email, created_at",
    },
    "daywordplay": {
        "kind": "supabase_auth",
        "profile_table": "daywordplay_profiles",
        "delete_handler": _delete_daywordplay_user,
    },
    "plant-planner": {
        "kind": "supabase_auth",
        "profile_table": "plantplanner_profiles",
        "delete_handler": _delete_plantplanner_user,
    },
    "boardgame-buddy": {
        "kind": "supabase_auth",
        "profile_table": "boardgamebuddy_profiles",
        "delete_handler": _delete_boardgamebuddy_user,
    },
}


def _list_supabase_auth_users(sb, profile_table: str):
    """Return profile rows enriched with email + last_sign_in_at from auth.users.

    N+1 against auth.admin.get_user_by_id is fine for admin volume (handful of
    users per app). Switch to auth.admin.list_users() if any app exceeds ~200.
    """
    rows = (
        sb.table(profile_table)
        .select("id, display_name, avatar_url, created_at")
        .order("created_at", desc=True)
        .execute()
        .data
        or []
    )
    out = []
    for row in rows:
        email = None
        last_sign_in_at = None
        try:
            au = sb.auth.admin.get_user_by_id(row["id"])
            user_obj = getattr(au, "user", None) if au else None
            if user_obj:
                email = getattr(user_obj, "email", None)
                last_sign_in_at = getattr(user_obj, "last_sign_in_at", None)
        except Exception:
            pass
        out.append({
            "id": row["id"],
            "username": row.get("display_name"),  # frontend uses `username` as primary label
            "display_name": row.get("display_name"),
            "email": email,
            "created_at": row.get("created_at"),
            "last_sign_in_at": last_sign_in_at,
        })
    return out


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/health", response_model=HealthResponse, summary="Admin health check")
async def health():
    """Health check."""
    return {"project": "admin", "status": "ok"}


@router.get("/users")
async def list_users(
    app: str = Query(..., description="App name, e.g. 'wealthmate'"),
    authorization: Optional[str] = Header(None),
):
    """List users for an app. Returns identity fields only — never financial data."""
    require_admin(authorization)

    if app not in APPS_WITH_USERS:
        raise HTTPException(status_code=400, detail=f"App '{app}' has no user management. Known apps: {list(APPS_WITH_USERS.keys())}")

    cfg = APPS_WITH_USERS[app]
    sb = get_supabase()

    if cfg["kind"] == "supabase_auth":
        users = _list_supabase_auth_users(sb, cfg["profile_table"])
    else:
        result = (
            sb.table(cfg["table"])
            .select(cfg["identity_columns"])
            .order("created_at", desc=True)
            .execute()
        )
        users = result.data or []
    return {"app": app, "users": users}


@router.post("/users/{user_id}/reset-code")
async def generate_reset_code(
    user_id: str,
    app: str = Query(..., description="App name, e.g. 'wealthmate'"),
    authorization: Optional[str] = Header(None),
):
    """Generate a password recovery code for a user. Returns the plaintext code."""
    require_admin(authorization)

    if app not in APPS_WITH_USERS:
        raise HTTPException(status_code=400, detail=f"App '{app}' has no user management.")

    cfg = APPS_WITH_USERS[app]
    if cfg["kind"] == "supabase_auth":
        raise HTTPException(
            status_code=400,
            detail=(
                f"'{app}' uses Supabase Auth — password recovery is handled by the "
                "auth provider (OAuth) or Supabase magic link, not by an admin reset code."
            ),
        )

    sb = get_supabase()
    # Verify user exists
    check = sb.table(cfg["table"]).select("id").eq("id", user_id).execute()
    if not check.data:
        raise HTTPException(status_code=404, detail="User not found")

    # Generate and store recovery code
    recovery_code = secrets.token_urlsafe(16)
    recovery_hash_value = hash_password(recovery_code)
    sb.table(cfg["table"]).update({
        "recovery_hash": recovery_hash_value,
    }).eq("id", user_id).execute()

    return {"user_id": user_id, "recovery_code": recovery_code}


@router.get("/storage")
async def storage_overview(authorization: Optional[str] = Header(None)):
    """Database storage per app and per table. Calls admin_table_sizes() RPC."""
    require_admin(authorization)

    sb = get_supabase()
    result = sb.rpc("admin_table_sizes").execute()
    rows = result.data or []

    # Group by app prefix (first underscore split)
    apps = {}
    for row in rows:
        table = row["table_name"]
        parts = table.split("_", 1)
        app_name = parts[0] if len(parts) > 1 else "_other"

        if app_name not in apps:
            apps[app_name] = {"total_bytes": 0, "tables": []}
        apps[app_name]["total_bytes"] += row["total_bytes"]
        apps[app_name]["tables"].append({
            "table_name": table,
            "total_bytes": row["total_bytes"],
            "row_estimate": row["row_estimate"],
        })

    return {"apps": apps}


@router.get("/apps-with-users")
async def apps_with_users(authorization: Optional[str] = Header(None)):
    """Return apps that have user management, with capability flags for the UI."""
    require_admin(authorization)
    apps = []
    for name, cfg in APPS_WITH_USERS.items():
        kind = cfg["kind"]
        apps.append({
            "name": name,
            "kind": kind,
            "supports_reset_code": kind == "legacy_users",
            "supports_delete": "delete_handler" in cfg,
        })
    return {"apps": apps}


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: str,
    app: str = Query(..., description="App name, e.g. 'wealthmate'"),
    authorization: Optional[str] = Header(None),
):
    """Delete a user and all their data for the given app."""
    require_admin(authorization)

    if app not in APPS_WITH_USERS:
        raise HTTPException(status_code=400, detail=f"App '{app}' has no user management.")

    cfg = APPS_WITH_USERS[app]
    handler = cfg.get("delete_handler")
    if not handler:
        raise HTTPException(status_code=501, detail=f"Delete not implemented for '{app}'")

    sb = get_supabase()
    return await handler(sb, user_id)


# ---------------------------------------------------------------------------
# API logs (cross-app external API call audit)
# ---------------------------------------------------------------------------

# How far back each "Clear bodies" preset reaches. "all" means every row.
_AGE_DELTAS: dict[str, Optional[timedelta]] = {
    "1w": timedelta(days=7),
    "1m": timedelta(days=30),
    "all": None,
}


# Time-window presets for the admin filter UI. "all" means no time filter.
_SINCE_DELTAS: dict[str, Optional[timedelta]] = {
    "1m":    timedelta(minutes=1),
    "5m":    timedelta(minutes=5),
    "15m":   timedelta(minutes=15),
    "today": None,  # special-cased below — "since midnight UTC"
    "all":   None,
}


@router.get("/api-logs")
async def list_api_logs(
    app: Optional[str] = Query(None, description="Filter by app, e.g. 'plant-planner'"),
    api_name: Optional[str] = Query(None, description="Filter by api, e.g. 'trefle'"),
    user_id: Optional[str] = Query(None, description="Filter by user (literal 'anonymous' = NULL)"),
    since: Optional[str] = Query(
        None,
        description="Window preset: '1m', '5m', '15m', 'today', or 'all'.",
    ),
    limit: int = Query(200, ge=1, le=500),
    authorization: Optional[str] = Header(None),
):
    """List recent external API calls. Newest first."""
    require_admin(authorization)
    sb = get_supabase()
    q = (
        sb.table("api_logs")
        .select(
            "id, app, api_name, method, url, request_params, sent_at, "
            "response_time_ms, status_code, response_size_bytes, body_excerpt, "
            "error_message, user_id, user_label"
        )
        .order("sent_at", desc=True)
        .limit(limit)
    )
    if app:
        q = q.eq("app", app)
    if api_name:
        q = q.eq("api_name", api_name)
    if user_id == "anonymous":
        q = q.filter("user_id", "is", "null")
    elif user_id:
        q = q.eq("user_id", user_id)

    if since and since != "all":
        cutoff_iso: Optional[str] = None
        if since == "today":
            now = datetime.now(timezone.utc)
            midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
            cutoff_iso = midnight.isoformat()
        else:
            delta = _SINCE_DELTAS.get(since)
            if delta is not None:
                cutoff_iso = (datetime.now(timezone.utc) - delta).isoformat()
        if cutoff_iso:
            q = q.gte("sent_at", cutoff_iso)

    result = q.execute()
    return {"logs": result.data or []}


@router.get("/api-logs/users")
async def list_api_log_users(authorization: Optional[str] = Header(None)):
    """Distinct (user_id, user_label) pairs seen in api_logs, for the filter dropdown.

    Pulls the most recent 5000 rows (admin volume is small) and dedupes in
    Python — postgrest can't express SELECT DISTINCT.
    """
    require_admin(authorization)
    sb = get_supabase()
    result = (
        sb.table("api_logs")
        .select("user_id, user_label")
        .order("sent_at", desc=True)
        .limit(5000)
        .execute()
    )
    rows = result.data or []
    seen: dict[Optional[str], dict] = {}
    has_anonymous = False
    for r in rows:
        uid = r.get("user_id")
        if uid is None:
            has_anonymous = True
            continue
        if uid not in seen:
            seen[uid] = {"user_id": uid, "user_label": r.get("user_label") or uid}
    users = sorted(seen.values(), key=lambda x: (x["user_label"] or "").lower())
    if has_anonymous:
        users.insert(0, {"user_id": "anonymous", "user_label": "Anonymous (no signed-in user)"})
    return {"users": users}


@router.get("/api-logs/summary")
async def api_logs_summary(authorization: Optional[str] = Header(None)):
    """Aggregate counts + total body bytes per (app, api_name) over last 30d."""
    require_admin(authorization)
    sb = get_supabase()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    # Pull only the columns needed for summary; aggregation done in Python on
    # a small slice (admin-only, low volume).
    result = (
        sb.table("api_logs")
        .select("app, api_name, status_code, response_size_bytes, error_message")
        .gte("sent_at", cutoff)
        .limit(10000)
        .execute()
    )
    rows = result.data or []
    summary: dict[str, dict] = {}
    for r in rows:
        key = f"{r.get('app') or '?'}::{r.get('api_name') or '?'}"
        s = summary.setdefault(
            key,
            {
                "app": r.get("app"),
                "api_name": r.get("api_name"),
                "calls": 0,
                "errors": 0,
                "bytes": 0,
            },
        )
        s["calls"] += 1
        if r.get("error_message") or (r.get("status_code") or 0) >= 400:
            s["errors"] += 1
        s["bytes"] += r.get("response_size_bytes") or 0
    return {"summary": sorted(summary.values(), key=lambda x: -x["calls"])}


@router.post("/api-logs/clear-bodies")
async def clear_api_log_bodies(
    older_than: Literal["1w", "1m", "all"] = Query(
        ..., description="Cutoff: '1w' (>=7d), '1m' (>=30d), or 'all' rows."
    ),
    authorization: Optional[str] = Header(None),
):
    """Null out body_excerpt on rows older than the cutoff. Keeps timing/error stats."""
    require_admin(authorization)
    sb = get_supabase()

    delta = _AGE_DELTAS[older_than]
    q = sb.table("api_logs").update({"body_excerpt": None})
    # Only touch rows that still have a body — avoids rewriting already-cleared rows.
    # Raw PostgREST filter is the most version-stable way to express IS NOT NULL.
    q = q.filter("body_excerpt", "not.is", "null")
    if delta is not None:
        cutoff = (datetime.now(timezone.utc) - delta).isoformat()
        q = q.lt("sent_at", cutoff)
    result = q.execute()
    cleared = len(result.data or [])
    return {"cleared": cleared, "older_than": older_than}
