"""
routes/daywordplay/dependencies.py
FastAPI dependency: get_current_user() — decodes JWT from Authorization header.
"""
from typing import Optional
from fastapi import Header, HTTPException

from auth import decode_token
from .constants import JWT_SECRET, JWT_ALGORITHM


async def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header required")
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Format: Bearer <token>")
    return decode_token(parts[1], JWT_SECRET, JWT_ALGORITHM)
