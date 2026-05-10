"""SauceBoss route package."""

from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/sauceboss", tags=["sauceboss"])

from . import (  # noqa: E402, F401
    public_routes,
    admin_routes,
    profile_routes,
    import_export_routes,
    saucebook_routes,
    pantry_routes,
    favorites_routes,  # release/sauceboss-1.0 compat shim — remove once release retires
)
