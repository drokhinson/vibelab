"""
routes/daywordplay/constants.py
"""
import os

JWT_SECRET = os.environ.get("DAYWORDPLAY_JWT_SECRET", "daywordplay-dev-secret-change-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_DAYS = 30
