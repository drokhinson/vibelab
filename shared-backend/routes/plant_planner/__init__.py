"""
routes/plant_planner/ — PlantPlanner API routes package
All routes at /api/v1/plant_planner/...

Supabase tables (all prefixed plantplanner_):
  plantplanner_profiles       — id (=auth.users.id), display_name, avatar_url, is_admin
  plantplanner_plants         — id, name, height_inches, sunlight, bloom_season, spread_inches, render_key
  plantplanner_renders        — key, label, params, colors
  plantplanner_gardens        — id, user_id (FK plantplanner_profiles), name, grid_width, grid_height
  plantplanner_garden_plants  — id, garden_id, plant_id, grid_x, grid_y
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/plant_planner", tags=["plant-planner"])

from . import auth_routes      # noqa: F401, E402
from . import plant_routes     # noqa: F401, E402
from . import garden_routes    # noqa: F401, E402
from . import companion_routes  # noqa: F401, E402
