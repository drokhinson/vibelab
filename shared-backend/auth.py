"""
auth.py — Admin auth helpers for the vibelab backend.

All app user auth now uses Supabase Auth — see supabase_auth.py for the
`get_supabase_user()` FastAPI dependency that decodes Supabase-issued JWTs.
This file only retains `require_admin()` used by admin + analytics routes.
"""

import os
from typing import Optional

from fastapi import HTTPException

ADMIN_API_KEY = os.environ.get("ADMIN_API_KEY", "dev-admin-key")


def require_admin(authorization: Optional[str]) -> None:
    """Validate Bearer token matches ADMIN_API_KEY. Raises 401/403."""
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization required")
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Invalid authorization format")
    if parts[1] != ADMIN_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid admin key")
