// domain/cache.js — in-memory TTL cache for screen data (stale-while-
// revalidate). Views seed their first paint from here on re-entry — no
// skeleton, no network wait — then refresh in the background. Mutations
// invalidate the keys they touch; a 5-minute TTL bounds staleness from
// other collaborators' changes between visits.
'use strict';

(function () {
  const TTL_MS = 5 * 60 * 1000;
  const _entries = new Map(); // 'type:key' → {data, at}

  const k = (type, key) => type + ':' + (key ?? '');

  window.tsCache = {
    /** Fresh cached value, or null when absent/expired. */
    get(type, key) {
      const e = _entries.get(k(type, key));
      if (!e) return null;
      if (Date.now() - e.at > TTL_MS) { _entries.delete(k(type, key)); return null; }
      return e.data;
    },
    set(type, key, data) { _entries.set(k(type, key), { data, at: Date.now() }); },
    /** Drop one key, or every key of a type when key is omitted. */
    invalidate(type, key) {
      if (key != null) { _entries.delete(k(type, key)); return; }
      for (const key2 of [..._entries.keys()]) {
        if (key2.startsWith(type + ':')) _entries.delete(key2);
      }
    },
    clear() { _entries.clear(); },
  };
})();
