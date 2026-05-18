// domain/cache.js — generic in-memory TTL cache.
//
// Mirrors the dwpCache pattern documented in .claude/rules/performance-caching.md.
// Bundle endpoints and stats are read often (Profile / Game Detail switches)
// but rarely mutate inside a session — cache them with a sensible TTL so a
// quick back-and-forth doesn't re-pay the network round trip.
//
// Per-tab, lost on reload. Mutations invalidate selectively via clear(ns).

(function () {
  // ns → key → { value, expiresAt }
  const _store = new Map();

  const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min

  function _bucket(ns) {
    let b = _store.get(ns);
    if (!b) {
      b = new Map();
      _store.set(ns, b);
    }
    return b;
  }

  const bgbCache = {
    /** Read a fresh value or null. Expired entries are dropped on access. */
    get(ns, key) {
      const b = _store.get(ns);
      if (!b) return null;
      const entry = b.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        b.delete(key);
        return null;
      }
      return entry.value;
    },

    /** Store a value with TTL (defaults to 5 min). Overwrites any existing entry. */
    set(ns, key, value, ttlMs = DEFAULT_TTL_MS) {
      if (ttlMs <= 0) return;
      _bucket(ns).set(key, { value, expiresAt: Date.now() + ttlMs });
    },

    /** Drop a single key. Silent no-op when missing. */
    delete(ns, key) {
      const b = _store.get(ns);
      if (b) b.delete(key);
    },

    /** Drop a namespace (or every namespace when ns is omitted/null). */
    clear(ns) {
      if (ns == null) {
        _store.clear();
        return;
      }
      const b = _store.get(ns);
      if (b) b.clear();
    },

    /** Snapshot of per-namespace sizes — debug aid only. */
    stats() {
      const out = {};
      for (const [ns, b] of _store.entries()) out[ns] = b.size;
      return out;
    },
  };

  window.bgbCache = bgbCache;
})();
