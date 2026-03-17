"""Shared constants for PlantPlanner API."""

import os

JWT_SECRET = os.environ.get("PLANTPLANNER_JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"
