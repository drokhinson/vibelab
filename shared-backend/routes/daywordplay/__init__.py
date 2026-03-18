"""
routes/daywordplay/__init__.py
Day Word Play — daily vocabulary challenge with social groups.
All routes at /api/v1/daywordplay/...
"""
from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/daywordplay", tags=["daywordplay"])

from . import auth_routes  # noqa: E402, F401
from . import group_routes  # noqa: E402, F401
from . import word_routes  # noqa: E402, F401
from . import admin_routes  # noqa: E402, F401
