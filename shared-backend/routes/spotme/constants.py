"""Shared constants for SpotMe API."""

import os

JWT_SECRET = os.environ.get("SPOTME_JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"
