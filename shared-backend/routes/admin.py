"""
routes/admin.py — Admin dashboard API routes
All routes at /api/v1/admin/...
Protected by ADMIN_API_KEY (Bearer token).
"""

import os
import secrets
from typing import Optional

from fastapi import APIRouter, HTTPException, Header, Query

from db import get_supabase
from auth import hash_password

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])

ADMIN_API_KEY = os.environ.get("ADMIN_API_KEY", "dev-admin-key")


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
APPS_WITH_USERS = {
    "wealthmate": {
        "table": "wealthmate_users",
        "identity_columns": "id, username, display_name, email, created_at",
        "delete_handler": _delete_wealthmate_user,
    },
}


# ---------------------------------------------------------------------------
# Admin auth
# ---------------------------------------------------------------------------

def _require_admin(authorization: Optional[str]):
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization required")
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Invalid authorization format")
    if parts[1] != ADMIN_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid admin key")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/health")
async def health():
    return {"project": "admin", "status": "ok"}


@router.get("/users")
async def list_users(
    app: str = Query(..., description="App name, e.g. 'wealthmate'"),
    authorization: Optional[str] = Header(None),
):
    """List users for an app. Returns identity fields only — never financial data."""
    _require_admin(authorization)

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
    _require_admin(authorization)

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
    _require_admin(authorization)

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
    _require_admin(authorization)
    return {"apps": list(APPS_WITH_USERS.keys())}


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: str,
    app: str = Query(..., description="App name, e.g. 'wealthmate'"),
    authorization: Optional[str] = Header(None),
):
    """Delete a user and all their data for the given app."""
    _require_admin(authorization)

    if app not in APPS_WITH_USERS:
        raise HTTPException(status_code=400, detail=f"App '{app}' has no user management.")

    cfg = APPS_WITH_USERS[app]
    handler = cfg.get("delete_handler")
    if not handler:
        raise HTTPException(status_code=501, detail=f"Delete not implemented for '{app}'")

    sb = get_supabase()
    return await handler(sb, user_id)
