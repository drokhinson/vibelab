'use strict';

// Tiny localStorage cache with per-entry TTL. Used for sauce-family responses
// today; can take on other namespaces (cuisines, units, …) later.
//
// Keys: `sb:<namespace>:<key>`. Values: `{ v: <data>, t: <epoch-ms> }`.
// `get` returns null on miss / expired / parse failure. `set` is best-effort:
// QuotaExceeded or a disabled storage backend (private mode in some browsers)
// silently fails — the caller falls back to a network fetch.
//
// Invalidation: `clear(ns)` wipes every key under that namespace.
// `delete(ns, key)` targets a single entry — preferred when the mutation
// has a known id so other entries stay warm.

const sbCache = {
  get(ns, key, ttlMs) {
    try {
      const raw = localStorage.getItem(`sb:${ns}:${key}`);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!entry || typeof entry.t !== 'number') return null;
      if (Date.now() - entry.t > ttlMs) return null;
      return entry.v;
    } catch (_) {
      return null;
    }
  },

  set(ns, key, value) {
    try {
      localStorage.setItem(`sb:${ns}:${key}`, JSON.stringify({ v: value, t: Date.now() }));
    } catch (_) {
      // Quota exceeded or storage disabled — caller still works without the cache.
    }
  },

  delete(ns, key) {
    try {
      localStorage.removeItem(`sb:${ns}:${key}`);
    } catch (_) {}
  },

  clear(ns) {
    try {
      const prefix = `sb:${ns}:`;
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) toRemove.push(k);
      }
      for (const k of toRemove) localStorage.removeItem(k);
    } catch (_) {}
  },
};

window.sbCache = sbCache;
