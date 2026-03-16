"""
routes/spotme/ — SpotMe API routes package
All routes at /api/v1/spotme/...

Supabase tables (all prefixed spotme_):
  spotme_users              — id, username, display_name, password_hash, bio, location fields
  spotme_hobby_categories   — id, slug, name, icon, sort_order
  spotme_hobbies            — id, category_id, name, slug
  spotme_user_hobbies       — id, user_id, hobby_id, proficiency, notes
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/spotme", tags=["spotme"])

# Import sub-modules to register their routes on this router
from . import auth_routes      # noqa: F401, E402
from . import profile_routes   # noqa: F401, E402
from . import hobby_routes     # noqa: F401, E402
