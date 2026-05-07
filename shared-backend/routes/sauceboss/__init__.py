"""SauceBoss route package."""

from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/sauceboss", tags=["sauceboss"])

from . import public_routes, admin_routes, profile_routes, favorites_routes, import_export_routes  # noqa: E402, F401
