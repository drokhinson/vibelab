"""
travel_scrapbook — Save travel links to trips, AI-extract the place, geocode
it, and sort trips into optimized routes with Google Maps exports.
"""

from fastapi import APIRouter

router = APIRouter(
    prefix="/api/v1/travel_scrapbook",
    tags=["travel_scrapbook"],
)

# Import sub-modules so their routes register on the router.
from . import profile_routes  # noqa: F401, E402
from . import trip_routes     # noqa: F401, E402
from . import source_routes   # noqa: F401, E402
from . import scrap_routes    # noqa: F401, E402
from . import plan_routes     # noqa: F401, E402
from . import community_routes  # noqa: F401, E402
from . import export_routes   # noqa: F401, E402
from . import member_routes   # noqa: F401, E402
