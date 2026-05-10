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
async def _delete_daywordplay_user(sb, user_id: str):
    """Delete a daywordplay user and cascade-remove all their data."""
    user = sb.table("daywordplay_users").select("id, username").eq("id", user_id).execute()
    if not user.data:
        raise HTTPException(status_code=404, detail="User not found")
    username = user.data[0]["username"]

    # Delete votes cast by user
    sb.table("daywordplay_votes").delete().eq("voter_user_id", user_id).execute()

    # Delete votes received on their sentences
    sentences = sb.table("daywordplay_sentences").select("id").eq("user_id", user_id).execute()
    sentence_ids = [s["id"] for s in (sentences.data or [])]
    if sentence_ids:
        sb.table("daywordplay_votes").delete().in_("sentence_id", sentence_ids).execute()

    # Delete sentences, bookmarks, group memberships
    sb.table("daywordplay_sentences").delete().eq("user_id", user_id).execute()
    sb.table("daywordplay_bookmarks").delete().eq("user_id", user_id).execute()
    sb.table("daywordplay_group_members").delete().eq("user_id", user_id).execute()

    # Delete user
    sb.table("daywordplay_users").delete().eq("id", user_id).execute()
    return {"deleted": True, "user_id": user_id, "username": username}


async def _delete_plantplanner_user(sb, user_id: str):
    """Delete a plant-planner user and cascade-remove all their data."""
    user = sb.table("plantplanner_users").select("id, username").eq("id", user_id).execute()
    if not user.data:
        raise HTTPException(status_code=404, detail="User not found")
    username = user.data[0]["username"]

    # Garden plants and gardens cascade via FK ON DELETE CASCADE,
    # so deleting the user row is sufficient.
    sb.table("plantplanner_users").delete().eq("id", user_id).execute()
    return {"deleted": True, "user_id": user_id, "username": username}


APPS_WITH_USERS = {
    "wealthmate": {
        "table": "wealthmate_users",
        "identity_columns": "id, username, display_name, email, created_at",
        "delete_handler": _delete_wealthmate_user,
    },
    "spotme": {
        "table": "spotme_users",
        "identity_columns": "id, username, display_name, email, created_at",
    },
    "daywordplay": {
        "table": "daywordplay_users",
        "identity_columns": "id, username, display_name, email, created_at",
        "delete_handler": _delete_daywordplay_user,
    },
    "plant-planner": {
        "table": "plantplanner_users",
        "identity_columns": "id, username, display_name, created_at",
        "delete_handler": _delete_plantplanner_user,
    },
    "boardgame-buddy": {
        "table": "boardgamebuddy_profiles",
        "identity_columns": "id, display_name, avatar_url, created_at",
    },
}


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
    result = (
        sb.table(cfg["table"])
        .select(cfg["identity_columns"])
        .order("created_at", desc=True)
        .execute()
    )
    return {"app": app, "users": result.data or []}


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
    """Return list of app names that have user management."""
    require_admin(authorization)
    return {"apps": list(APPS_WITH_USERS.keys())}


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


@router.get("/api-logs")
async def list_api_logs(
    app: Optional[str] = Query(None, description="Filter by app, e.g. 'plant-planner'"),
    api_name: Optional[str] = Query(None, description="Filter by api, e.g. 'trefle'"),
    session_id: Optional[str] = Query(None, description="Filter to a single session id"),
    limit: int = Query(100, ge=1, le=500),
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
            "error_message, session_id, user_id"
        )
        .order("sent_at", desc=True)
        .limit(limit)
    )
    if app:
        q = q.eq("app", app)
    if api_name:
        q = q.eq("api_name", api_name)
    if session_id == "anonymous":
        # Sentinel for "calls without an authenticated session".
        q = q.filter("session_id", "is", "null")
    elif session_id:
        q = q.eq("session_id", session_id)
    result = q.execute()
    return {"logs": result.data or []}


@router.get("/api-sessions")
async def list_api_sessions(
    app: Optional[str] = Query(None, description="Filter by app"),
    limit: int = Query(50, ge=1, le=200),
    authorization: Optional[str] = Header(None),
):
    """List recent API sessions (most recently active first).

    A session represents a contiguous burst of activity from one user in one
    app — bounded by 30 minutes of API inactivity (see api_logger.py).
    """
    require_admin(authorization)
    sb = get_supabase()
    q = (
        sb.table("api_sessions")
        .select("id, app, user_id, user_label, started_at, last_activity_at, call_count")
        .order("last_activity_at", desc=True)
        .limit(limit)
    )
    if app:
        q = q.eq("app", app)
    result = q.execute()
    sessions = result.data or []
    # Mark a session "active" if its last activity is within the idle timeout.
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=30)
    for s in sessions:
        last_raw = s.get("last_activity_at")
        try:
            last = datetime.fromisoformat(last_raw.replace("Z", "+00:00")) if last_raw else None
        except (AttributeError, ValueError):
            last = None
        s["active"] = bool(last and last >= cutoff)
    return {"sessions": sessions}


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
