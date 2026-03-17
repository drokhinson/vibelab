"""
routes/plant_planner/ — PlantPlanner API routes package
All routes at /api/v1/plant_planner/...

Supabase tables (all prefixed plantplanner_):
  plantplanner_users          — id, username, display_name, password_hash
  plantplanner_plants         — id, name, emoji, height_inches, sunlight, bloom_season, spread_inches
  plantplanner_gardens        — id, user_id, name, grid_width, grid_height
  plantplanner_garden_plants  — id, garden_id, plant_id, grid_x, grid_y
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/plant_planner", tags=["plant-planner"])

from . import auth_routes      # noqa: F401, E402
from . import plant_routes     # noqa: F401, E402
from . import garden_routes    # noqa: F401, E402
