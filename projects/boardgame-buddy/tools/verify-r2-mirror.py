#!/usr/bin/env python3
"""Prove every image URL in the database resolves to an object in R2.

    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
    R2_PLAYS_PUBLIC_BASE=https://img.bgbuddy.app \
    R2_GAMES_PUBLIC_BASE=https://covers.bgbuddy.app \
    python3 projects/boardgame-buddy/tools/verify-r2-mirror.py

Stage 4 of Docs/MIGRATION_PLAN.md — see Docs/RUNBOOK_R2_CUTOVER.md for where
this sits in the sequence. Run it TWICE:

  * after `rclone copy`, BEFORE migration 036. Rows still hold supabase.co
    URLs; this derives each object key from them and checks the key exists on
    the R2 domain. A miss here means the copy is incomplete, and finding that
    out now costs nothing — the rows still point at Supabase and the app is
    fine.

  * after migration 036. Rows now hold R2 URLs and this checks them directly.
    This run is the acceptance gate: a miss here is a broken image a user can
    see.

The two runs need no flags to tell them apart. Every URL is reduced to an
object key first, and both URL shapes reduce to the same key — which is only
true because the migration is a prefix substitution and the keys are identical
on both sides. If that ever stops being true, this tool stops being valid.

Read-only. It never writes to the database, R2 or Supabase Storage; the worst
it can do is issue a lot of HEAD requests.

No third-party imports on purpose: this has to run from a bare checkout
without installing the API's requirements, so PostgREST is called over plain
urllib rather than through the supabase client.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# (table, column) pairs holding an image URL, and which store each belongs to.
COLUMNS = [
    ("boardgamebuddy_plays", "photo_url", "plays"),
    ("boardgamebuddy_games", "image_url", "games"),
    ("boardgamebuddy_games", "thumbnail_url", "games"),
]

SUPABASE_BUCKETS = {
    "plays": "boardgamebuddy-plays",
    "games": "boardgamebuddy-games",
}

# Covers that were never re-hosted: `_upload_to_storage` returns the original
# BGG address when the download or the upload fails, so these are expected in
# boardgamebuddy_games.image_url and are not this tool's business.
FOREIGN_HOSTS = ("geekdo-images.com", "boardgamegeek.com")

PAGE = 1000
HEAD_TIMEOUT_S = 15


def env(name: str) -> str:
    value = (os.environ.get(name) or "").strip().rstrip("/")
    if not value:
        sys.exit(f"{name} is not set. See the module docstring for the call.")
    return value


def object_key(url: str, store: str, r2_base: str) -> str | None:
    """Reduce a stored URL to its object key, or None if it is not ours.

    Handles both shapes so one run works either side of migration 036:
      https://<ref>.supabase.co/storage/v1/object/public/<bucket>/<key>
      https://img.bgbuddy.app/<key>
    """
    if not url:
        return None
    if any(host in url for host in FOREIGN_HOSTS):
        return None
    if url.startswith(r2_base + "/"):
        return url[len(r2_base) + 1:]
    marker = f"/storage/v1/object/public/{SUPABASE_BUCKETS[store]}/"
    idx = url.find(marker)
    if idx != -1:
        return url[idx + len(marker):]
    return None


def fetch_column(supabase_url: str, key: str, table: str, column: str) -> list[str]:
    """Every non-null value of one column, paged through PostgREST.

    Two things this gets right that the obvious version does not, both of which
    would fail SILENTLY and in the direction that matters — reporting fewer
    objects to check than exist:

    * It pages until a response comes back EMPTY, advancing by however many
      rows arrived. Stopping on a short page assumes the server honours the
      requested limit, and PostgREST has its own `max-rows` ceiling it will
      quietly clamp to.
    * It orders by `id`. An unordered OFFSET in Postgres is free to return
      rows in a different order per page, which duplicates some and skips
      others. Duplicates this tool would survive; skips are exactly what it
      exists to catch.
    """
    values: list[str] = []
    offset = 0
    while True:
        query = urllib.parse.urlencode({
            "select": f"id,{column}",
            f"{column}": "not.is.null",
            "order": "id.asc",
            "limit": PAGE,
            "offset": offset,
        })
        req = urllib.request.Request(
            f"{supabase_url}/rest/v1/{table}?{query}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                rows = json.load(resp)
        except urllib.error.HTTPError as exc:
            sys.exit(f"PostgREST {exc.code} reading {table}.{column}: {exc.read()[:300]!r}")
        if not rows:
            return values
        values.extend(r[column] for r in rows if r.get(column))
        offset += len(rows)


def head(url: str) -> int:
    """HTTP status for a HEAD, or 0 when the request itself failed."""
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=HEAD_TIMEOUT_S) as resp:
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except Exception:
        return 0


def self_test() -> None:
    """Exercise the URL reduction, which is the only logic worth getting wrong."""
    plays_base = "https://img.bgbuddy.app"
    games_base = "https://covers.bgbuddy.app"
    cases = [
        # (url, store, base, expected key)
        ("https://abc.supabase.co/storage/v1/object/public/boardgamebuddy-plays/uid_1/dead.jpg",
         "plays", plays_base, "uid_1/dead.jpg"),
        ("https://img.bgbuddy.app/uid_1/dead.jpg", "plays", plays_base, "uid_1/dead.jpg"),
        ("https://abc.supabase.co/storage/v1/object/public/boardgamebuddy-games/13_cover.jpg",
         "games", games_base, "13_cover.jpg"),
        ("https://covers.bgbuddy.app/13_cover.jpg", "games", games_base, "13_cover.jpg"),
        # An un-rehosted BGG cover is not ours to check.
        ("https://cf.geekdo-images.com/original/img/x.jpg", "games", games_base, None),
        ("", "plays", plays_base, None),
        # A plays URL checked against the games base must not match by accident.
        ("https://abc.supabase.co/storage/v1/object/public/boardgamebuddy-plays/uid/a.jpg",
         "games", games_base, None),
    ]
    failures = 0
    for url, store, base, want in cases:
        got = object_key(url, store, base)
        if got != want:
            failures += 1
            print(f"FAIL {url!r} ({store}) -> {got!r}, want {want!r}")
    print(f"self-test: {len(cases) - failures}/{len(cases)} passed")
    sys.exit(1 if failures else 0)


def main() -> None:
    if "--self-test" in sys.argv:
        self_test()

    supabase_url = env("SUPABASE_URL")
    service_key = env("SUPABASE_SERVICE_ROLE_KEY")
    bases = {"plays": env("R2_PLAYS_PUBLIC_BASE"), "games": env("R2_GAMES_PUBLIC_BASE")}

    missing: list[tuple[str, str, int]] = []
    skipped = 0
    checked = 0

    for table, column, store in COLUMNS:
        urls = fetch_column(supabase_url, service_key, table, column)
        keys = []
        for url in urls:
            key = object_key(url, store, bases[store])
            if key is None:
                skipped += 1
            else:
                keys.append(key)
        # One object can back many rows (a cover is shared by every copy of the
        # game), so de-duplicate before spending a request on it.
        unique = sorted(set(keys))
        print(f"{table}.{column}: {len(urls)} rows, {len(unique)} distinct objects")
        for key in unique:
            target = f"{bases[store]}/{urllib.parse.quote(key, safe='/')}"
            status = head(target)
            checked += 1
            if status != 200:
                missing.append((f"{table}.{column}", target, status))

    print(f"\nchecked {checked} objects, {skipped} rows skipped (not on either origin)")
    if not missing:
        print("every image URL in the database resolves on R2")
        return

    print(f"\n{len(missing)} MISSING — do not run migration 036 until this is 0:")
    for where, target, status in missing[:40]:
        print(f"  [{status or 'no response'}] {where}  {target}")
    if len(missing) > 40:
        print(f"  … and {len(missing) - 40} more")
    sys.exit(1)


if __name__ == "__main__":
    main()
