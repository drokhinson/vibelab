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

# Registry of apps that have user tables.
# Update this dict when a new app adopts shared auth.
APPS_WITH_USERS = {
    "wealthmate": {
        "table": "wealthmate_users",
        "identity_columns": "id, username, display_name, email, created_at",
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
