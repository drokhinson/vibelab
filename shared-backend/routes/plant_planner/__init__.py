"""
routes/plant_planner/ — PlantPlanner API routes package
All routes at /api/v1/plant_planner/...

Supabase tables (all prefixed plantplanner_):
  plantplanner_profiles       — id (=auth.users.id), display_name, avatar_url, is_admin
  plantplanner_plant_cache    — API-backed plant catalog (Trefle + Perenual; mirrored images)
  plantplanner_gardens        — id, user_id, name, grid_*, conditions, shortlist_plant_cache_ids, settings_json
  plantplanner_garden_plants  — id, garden_id, plant_cache_id, pos_x, pos_y, radius_feet
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/plant_planner", tags=["plant-planner"])

from . import auth_routes       # noqa: F401, E402
from . import catalog_routes    # noqa: F401, E402
from . import garden_routes     # noqa: F401, E402
from . import library_routes    # noqa: F401, E402
from . import location_routes   # noqa: F401, E402
