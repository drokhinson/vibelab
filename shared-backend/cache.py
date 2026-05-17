"""In-process TTL cache shared across the FastAPI app.

Stores values per `namespace` so different call sites (BGG /thing, BGG /search,
mechanics list, game lookups, …) can age and invalidate independently. Each
namespace is a tiny dict guarded by a single lock; concurrent reads are
serialised but cheap (no I/O, just a hash lookup).

Per-worker, lost on restart — that's acceptable for a prototype on Railway
where most cold restarts coincide with a deploy. The Phase 5 frontend cache
layer mirrors this contract for repeated FE-side reads.

Pattern lifted from `.claude/rules/performance-caching.md` (dwpCache).
"""

import threading
import time
from typing import Any, Iterator, Optional


# Per-namespace storage: { ns: { key: (value, expires_monotonic) } }.
_NS: dict[str, dict[Any, tuple[Any, float]]] = {}
# Per-namespace max entries (FIFO eviction order). 0 = unbounded.
_NS_MAX: dict[str, int] = {}
_LOCK = threading.Lock()


def configure(ns: str, max_entries: int = 0) -> None:
    """Register a namespace with optional FIFO eviction cap.

    Call once at import time per cache site. Skipping configure() is fine —
    the namespace materialises on first set() with no cap.
    """
    with _LOCK:
        _NS.setdefault(ns, {})
        _NS_MAX[ns] = max_entries


def get(ns: str, key: Any) -> Optional[Any]:
    """Fetch a fresh value or None. Expired entries are dropped on access so
    callers never see stale data without paying for it elsewhere."""
    now = time.monotonic()
    with _LOCK:
        bucket = _NS.get(ns)
        if not bucket:
            return None
        entry = bucket.get(key)
        if entry is None:
            return None
        value, expires_at = entry
        if expires_at <= now:
            bucket.pop(key, None)
            return None
        return value


def set(ns: str, key: Any, value: Any, ttl_seconds: float) -> None:
    """Store `value` for `ttl_seconds`. Overwrites any existing entry."""
    if ttl_seconds <= 0:
        return
    expires_at = time.monotonic() + ttl_seconds
    with _LOCK:
        bucket = _NS.setdefault(ns, {})
        # Apply FIFO eviction if a cap is configured and we'd exceed it.
        # Cheap because we only check on writes and dict preserves insertion
        # order (Python 3.7+).
        cap = _NS_MAX.get(ns, 0)
        if cap and key not in bucket and len(bucket) >= cap:
            for stale_key in _iter_first(bucket, len(bucket) - cap + 1):
                bucket.pop(stale_key, None)
        bucket[key] = (value, expires_at)


def delete(ns: str, key: Any) -> None:
    """Drop a single entry. Silent no-op when the entry doesn't exist."""
    with _LOCK:
        bucket = _NS.get(ns)
        if bucket:
            bucket.pop(key, None)


def clear(ns: Optional[str] = None) -> None:
    """Drop everything in a namespace (or all namespaces when ns=None)."""
    with _LOCK:
        if ns is None:
            _NS.clear()
            return
        bucket = _NS.get(ns)
        if bucket:
            bucket.clear()


def stats() -> dict[str, dict[str, int]]:
    """Per-namespace size snapshot. Useful for the admin clear endpoint."""
    out: dict[str, dict[str, int]] = {}
    with _LOCK:
        for ns, bucket in _NS.items():
            out[ns] = {
                "entries": len(bucket),
                "max": _NS_MAX.get(ns, 0),
            }
    return out


def _iter_first(d: dict, n: int) -> Iterator[Any]:
    """Yield the first `n` keys of `d` in insertion order. Used by the FIFO
    eviction path; pulled out so the caller side stays compact."""
    it = iter(d)
    for _ in range(n):
        yield next(it)
