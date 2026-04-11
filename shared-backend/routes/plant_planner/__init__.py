"""
routes/plant_planner/ — PlantPlanner API routes package
All routes at /api/v1/plant_planner/...

Auth: Supabase Auth (client-side signup/login via supabase-js).
Backend verifies Supabase JWTs and manages app-specific profiles.

Supabase tables (all prefixed plantplanner_):
  plantplanner_profiles       — id (→ auth.users), username, display_name
  plantplanner_plants         — id, name, height_inches, sunlight, bloom_season, spread_inches
  plantplanner_gardens        — id, user_id, name, grid_width, grid_height
  plantplanner_garden_plants  — id, garden_id, plant_id, grid_x, grid_y
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/plant_planner", tags=["plant-planner"])

from . import auth_routes      # noqa: F401, E402
from . import plant_routes     # noqa: F401, E402
from . import garden_routes    # noqa: F401, E402
