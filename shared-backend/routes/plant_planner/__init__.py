"""
routes/plant_planner/ — PlantPlanner API routes package
All routes at /api/v1/plant_planner/...

Supabase tables (all prefixed plantplanner_):
  plantplanner_profiles       — id (=auth.users.id), display_name, avatar_url, is_admin
  plantplanner_plants         — id, name, category, height_inches, spread_inches, sunlight, bloom_season, bloom_months, native, usda_zones, pollinator_attracts, water_need, care_summary, render_key
  plantplanner_renders        — key, label, params, colors
  plantplanner_gardens        — id, user_id (FK plantplanner_profiles), name, grid_width, grid_height, usda_zone, settings_json
  plantplanner_companions     — plant_a_id, plant_b_id (a<b), relationship, reason
  plantplanner_garden_plants  — id, garden_id, plant_id, pos_x, pos_y, radius_feet
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/plant_planner", tags=["plant-planner"])

from . import auth_routes      # noqa: F401, E402
from . import plant_routes     # noqa: F401, E402
from . import garden_routes    # noqa: F401, E402
from . import companion_routes  # noqa: F401, E402
