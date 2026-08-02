#!/usr/bin/env python3
"""
seed_postcards.py — one-off loader for the Slovenian Arrow stop postcards.

002_seed.sql creates the trip + stop rows with a placeholder html_content
because the real postcard pages are ~400 KB each — too large to embed in a SQL
file. This script reads those existing files and writes them into the matching
person_trip_stops rows (keyed by trip slug + sort_order).

Run once, after 001_baseline.sql and 002_seed.sql have been applied:

    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
        python db/migrations/person/seed_postcards.py

Idempotent: re-running simply re-writes the same html_content. Once the DB copy
is verified, the source files under landing/travel/static/postcards/ can be removed.
"""
import os
import sys
from pathlib import Path

from supabase import create_client

# Repo root = this file's dir / ../../..  (db/migrations/person/ -> repo root)
REPO_ROOT = Path(__file__).resolve().parents[3]
POSTCARDS_DIR = REPO_ROOT / "landing" / "travel" / "static" / "postcards"

TRIP_SLUG = "slovenian-arrow"

# Maps a stop's sort_order to its source postcard file.
STOP_FILES = {
    0: "arrow-00-startline.html",
    1: "arrow-01-brussels.html",
}


def main() -> int:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print("ERROR: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
        return 1

    sb = create_client(url, key)

    trip = sb.table("person_trips").select("id").eq("slug", TRIP_SLUG).execute()
    if not trip.data:
        print(f"ERROR: trip '{TRIP_SLUG}' not found — run 002_seed.sql first.", file=sys.stderr)
        return 1
    trip_id = trip.data[0]["id"]

    for sort_order, filename in STOP_FILES.items():
        path = POSTCARDS_DIR / filename
        if not path.exists():
            print(f"WARN: {path} missing, skipping sort_order={sort_order}", file=sys.stderr)
            continue
        html = path.read_text(encoding="utf-8")
        res = (
            sb.table("person_trip_stops")
            .update({"html_content": html})
            .eq("trip_id", trip_id)
            .eq("sort_order", sort_order)
            .execute()
        )
        n = len(res.data or [])
        print(f"Loaded {filename} → {n} stop row(s) at sort_order={sort_order} ({len(html):,} bytes)")

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
