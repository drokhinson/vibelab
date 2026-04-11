"""
routes/admin.py — Admin dashboard API routes
All routes at /api/v1/admin/...
Protected by ADMIN_API_KEY (Bearer token).
"""

from typing import Optional

from fastapi import APIRouter, HTTPException, Header, Query

from db import get_supabase
from auth import require_admin
from shared_models import HealthResponse

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


# ---------------------------------------------------------------------------
# Per-app delete handlers
# ---------------------------------------------------------------------------

async def _delete_wealthmate_user(sb, user_id: str):
    """Delete a WealthMate user via Supabase Auth admin API.

    Solo households: manually delete all couple-owned data before the profile
    vanishes via ON DELETE CASCADE from auth.users.
    Merged households: detach the leaving member and reassign their personal
    accounts to joint — the partner keeps the household intact.
    """
    user = sb.table("wealthmate_profiles").select("id, username").eq("id", user_id).execute()
    if not user.data:
        raise HTTPException(status_code=404, detail="User not found")
    username = user.data[0]["username"]

    membership = (
        sb.table("wealthmate_couple_members")
        .select("couple_id")
        .eq("user_id", user_id)
        .execute()
    )
    couple_id = membership.data[0]["couple_id"] if membership.data else None

    if couple_id:
        members = (
            sb.table("wealthmate_couple_members")
            .select("id, user_id")
            .eq("couple_id", couple_id)
            .execute()
        )
        is_solo = len(members.data or []) <= 1

        if is_solo:
            # Solo household — delete all couple-owned data first
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
            # Merged household — detach user, keep partner's data intact
            sb.table("wealthmate_couple_members").delete().eq("user_id", user_id).execute()
            sb.table("wealthmate_accounts").update(
                {"owner_user_id": None}
            ).eq("couple_id", couple_id).eq("owner_user_id", user_id).execute()

    # Delete any invitations this user is part of
    sb.table("wealthmate_invitations").delete().eq("from_user_id", user_id).execute()
    sb.table("wealthmate_invitations").delete().eq("to_username", username).execute()

    # Delete from Supabase Auth — CASCADE handles wealthmate_profiles row
    from db import delete_auth_user
    delete_auth_user(user_id)
    return {"deleted": True, "user_id": user_id, "username": username}


# Registry of apps that have user tables.
# Update this dict when a new app adopts shared auth.
async def _delete_daywordplay_user(sb, user_id: str):
    """Delete a daywordplay user via Supabase Auth admin API.

    ON DELETE CASCADE from auth.users → daywordplay_profiles → all data tables
    handles all data cleanup automatically.
    """
    user = sb.table("daywordplay_profiles").select("id, username").eq("id", user_id).execute()
    if not user.data:
        raise HTTPException(status_code=404, detail="User not found")
    username = user.data[0]["username"]

    from db import delete_auth_user
    delete_auth_user(user_id)
    return {"deleted": True, "user_id": user_id, "username": username}


async def _delete_plantplanner_user(sb, user_id: str):
    """Delete a plant-planner user via Supabase Auth admin API.

    ON DELETE CASCADE from auth.users → plantplanner_profiles → gardens → garden_plants
    handles all data cleanup automatically.
    """
    user = sb.table("plantplanner_profiles").select("id, username").eq("id", user_id).execute()
    if not user.data:
        raise HTTPException(status_code=404, detail="User not found")
    username = user.data[0]["username"]

    from db import delete_auth_user
    delete_auth_user(user_id)
    return {"deleted": True, "user_id": user_id, "username": username}


async def _delete_spotme_user(sb, user_id: str):
    """Delete a SpotMe user via Supabase Auth admin API.

    ON DELETE CASCADE from auth.users → spotme_profiles → user_hobbies
    handles all data cleanup automatically.
    """
    user = sb.table("spotme_profiles").select("id, username").eq("id", user_id).execute()
    if not user.data:
        raise HTTPException(status_code=404, detail="User not found")
    username = user.data[0]["username"]

    from db import delete_auth_user
    delete_auth_user(user_id)
    return {"deleted": True, "user_id": user_id, "username": username}


APPS_WITH_USERS = {
    "wealthmate": {
        "table": "wealthmate_profiles",
        "identity_columns": "id, username, display_name, email, created_at",
        "delete_handler": _delete_wealthmate_user,
        "uses_supabase_auth": True,
    },
    "spotme": {
        "table": "spotme_profiles",
        "identity_columns": "id, username, display_name, email, created_at",
        "delete_handler": _delete_spotme_user,
        "uses_supabase_auth": True,
    },
    "daywordplay": {
        "table": "daywordplay_profiles",
        "identity_columns": "id, username, display_name, email, created_at",
        "delete_handler": _delete_daywordplay_user,
        "uses_supabase_auth": True,
    },
    "plant-planner": {
        "table": "plantplanner_profiles",
        "identity_columns": "id, username, display_name, created_at",
        "delete_handler": _delete_plantplanner_user,
        "uses_supabase_auth": True,
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
