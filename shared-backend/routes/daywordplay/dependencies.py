"""
routes/daywordplay/dependencies.py
FastAPI dependency: get_current_user() — decodes Supabase Auth JWT.
"""

from typing import Optional
from fastapi import Header

from supabase_auth import get_supabase_user


async def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    """FastAPI dependency — decode Supabase Auth JWT from Authorization header."""
    return await get_supabase_user(authorization)
