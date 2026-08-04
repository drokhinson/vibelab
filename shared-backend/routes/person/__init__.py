"""
routes/person/ — David Rokhinson personal page API
All routes at /api/v1/person/...

Public reads power the travel section on landing/about.html and the per-trip
pages at /travel/:slug. Admin writes (create/edit/delete/reorder) are gated by
the shared ADMIN_API_KEY via require_admin() from auth.py.

Supabase tables (prefixed person_):
  person_trips       — id, slug, title, eyebrow, headline, lede, photo_album_url,
                       icon_url, card_cta, sort_order, is_published, created_at,
                       updated_at
  person_trip_stops  — id, trip_id, title, meta, note, html_content, sort_order,
                       created_at, updated_at
  person_profile     — id (singleton=1), name, role, bio, photo_path, updated_at
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/person", tags=["person"])

# Import sub-modules to register their routes on this router
from . import trip_routes      # noqa: F401, E402
from . import stop_routes      # noqa: F401, E402
from . import profile_routes   # noqa: F401, E402
