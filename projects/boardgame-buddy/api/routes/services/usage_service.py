"""App-wide usage stats for the admin Usage spoke.

Two reads with very different costs, so two caches with very different TTLs.

`fetch_usage` is one `bgb_admin_usage_stats()` call — eleven aggregates over
the app's own tables plus `api_logs` and `analytics_events`, composed in SQL
because `.claude/rules/performance-caching.md` says to count in the database
and because a dozen round trips to draw one screen is the wrong price. It is
cheap enough to want to feel live, so a SHORT TTL: long enough that an admin
tapping Refresh twice does not re-run it, short enough that the numbers are
this-minute true.

`fetch_bucket_usage` walks both R2 buckets with `ListObjectsV2`, which is
dozens of HTTP round trips and the one genuinely slow thing on the screen. Its
answer also barely moves hour to hour, so a LONG TTL with an explicit bypass —
the screen fetches it in its own request, after first paint, so the walk never
delays the numbers that were ready immediately.

Both caches are `cache.py`, i.e. in-process and per-worker. The service runs
one uvicorn worker on purpose (`projects/boardgame-buddy/CLAUDE.md`), so that
is one cache, not N; and a stale usage number is a cosmetic problem in any
case, never a correctness one.
"""

from typing import Any

from supabase import Client

import cache
import object_store

_USAGE_NS = "bgb.admin_usage"
_USAGE_TTL_SECONDS = 300          # 5 minutes
_BUCKETS_NS = "bgb.admin_buckets"
_BUCKETS_TTL_SECONDS = 6 * 60 * 60  # 6 hours

# One entry each — these are app-wide figures, not per-user, so the key is a
# constant and the namespace can never grow.
cache.configure(_USAGE_NS, max_entries=1)
cache.configure(_BUCKETS_NS, max_entries=1)

_KEY = "all"


def fetch_usage(sb: Client, refresh: bool = False) -> dict[str, Any]:
    """Return the whole Usage spoke payload in one call.

    Thin by design, exactly like `fetch_stats_detail`: the RPC composes every
    block server-side, so there is nothing to reshape here and no second
    declaration of its shape to drift. `047_usage_stats.sql` is the contract;
    the frontend carries it as a JSDoc `@typedef` in `web/domain/admin-usage.js`.
    """
    if not refresh:
        hit = cache.get(_USAGE_NS, _KEY)
        if hit is not None:
            return hit
    # `.data` is the JSONB the function returns, already decoded. An RPC
    # returning a scalar jsonb comes back as the object itself rather than a
    # one-row list, which is why there is no `[0]` here.
    payload = sb.rpc("bgb_admin_usage_stats").execute().data or {}
    cache.set(_USAGE_NS, _KEY, payload, _USAGE_TTL_SECONDS)
    return payload


def fetch_bucket_usage(refresh: bool = False) -> dict[str, Any]:
    """Object count and bytes for the two R2 buckets.

    Never raises for an unconfigured or unlistable bucket — `object_store.usage`
    reports both as data (`configured: false`, or a per-bucket `error`) so the
    screen can say which of the two it is. A cache write happens either way:
    re-walking a bucket that just refused us on every repaint of the screen
    helps nobody, and Refresh is there for when the token is fixed.
    """
    if not refresh:
        hit = cache.get(_BUCKETS_NS, _KEY)
        if hit is not None:
            return hit
    payload = {"buckets": object_store.usage()}
    cache.set(_BUCKETS_NS, _KEY, payload, _BUCKETS_TTL_SECONDS)
    return payload


def invalidate() -> None:
    """Drop both caches. For tests, and for a Refresh that should re-read all."""
    cache.delete(_USAGE_NS, _KEY)
    cache.delete(_BUCKETS_NS, _KEY)
