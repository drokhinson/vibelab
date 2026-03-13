"""
db.py — Supabase client singleton for the shared vibelab backend.
ONE Supabase project serves ALL apps. Tables are app-prefixed (e.g. sauceboss_carbs).
"""
import os
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

# Service role key bypasses Row Level Security — for backend use only.
# Never expose this key to the frontend or React Native app.
_client: Client | None = None


def get_supabase() -> Client:
    global _client
    if _client is None:
        _client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    return _client
