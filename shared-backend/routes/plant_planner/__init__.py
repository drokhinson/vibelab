"""
routes/plant_planner/ — PlantPlanner API routes package
All routes at /api/v1/plant_planner/...

Authentication is delegated to Supabase Auth — JWTs are verified by the
shared `jwt_auth.get_current_supabase_user` dependency.

Supabase tables (all prefixed plantplanner_):
  plantplanner_profiles       — id (FK auth.users), display_name
  plantplanner_plants         — id, name, height_inches, sunlight, bloom_season, ...
  plantplanner_renders        — key (PK), label, params, colors
  plantplanner_gardens        — id, user_id (FK plantplanner_profiles), name, grid dims
  plantplanner_garden_plants  — id, garden_id, plant_id, grid_x, grid_y
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/plant_planner", tags=["plant-planner"])

from . import auth_routes      # noqa: F401, E402
from . import plant_routes     # noqa: F401, E402
from . import garden_routes    # noqa: F401, E402
