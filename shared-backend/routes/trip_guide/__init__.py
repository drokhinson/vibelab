"""
trip_guide — TripGuide: a generic trip-guide builder.

An admin creates a trip (name, description, color scheme) and populates it with
ordered "stops" — cards that each hold a name, a short description, and HTML
content. Viewing is public; create/edit/reorder/delete is gated by the shared
vibelab admin code (ADMIN_API_KEY) via auth.require_admin.
"""

from fastapi import APIRouter

router = APIRouter(
    prefix="/api/v1/trip_guide",
    tags=["trip_guide"],
)

# Import sub-modules so their routes register on the router.
from . import scheme_routes  # noqa: F401, E402
from . import trip_routes    # noqa: F401, E402
from . import stop_routes    # noqa: F401, E402
