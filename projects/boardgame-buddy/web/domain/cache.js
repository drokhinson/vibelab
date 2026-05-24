// domain/cache.js — namespaced TTL cache with localStorage persistence and
// stale-while-revalidate support.
//
// Two reads of the same entry can return different things:
//   - get(ns, key) returns the cached value while it's FRESH (now < storedAt
//     + freshTtl); after that it returns null and the caller refetches.
//   - swr(ns, key, fetcher, opts) returns the cached value all the way out to
//     storedAt + staleTtl, but kicks fetcher() in the background once the
//     fresh window has lapsed so the next read gets new data.
//
// Persistence: every successful set() is written through to localStorage at
// `bgb_cache:<userId>:<ns>:<key>` so a reload doesn't pay the network. The
// cache must be bound to a user (bindUser(uid)) before persistence is active;
// before bind, all entries are memory-only and reads/writes are silently
// dropped from the persistence layer to avoid cross-account leaks.
//
// Schema migrations: bump SCHEMA_VERSION when the entry shape changes. On
// bindUser, mismatched entries in localStorage are dropped.

(function () {
  const SCHEMA_VERSION = 1;
  const STORAGE_PREFIX = "bgb_cache:";
  const META_SUFFIX = "__meta";
  const SIZE_BUDGET_BYTES = 3 * 1024 * 1024; // ~3 MB localStorage budget
  const EVICT_FRACTION = 0.25;               // drop ~25% on quota error
  const DEFAULT_TTL_MS = 5 * 60 * 1000;

  // ns → key → { value, storedAt, freshTtl, staleTtl, ver, bytes }
  const _store = new Map();
  // (ns,key) → Promise — single-flight guard inside swr().
  const _inflight = new Map();
  let _boundUid = null;
  let _persist = true; // flips false after a QuotaExceeded fallback
  const _counters = { freshHit: 0, staleHit: 0, miss: 0, set: 0, evict: 0 };

  function _bucket(ns) {
    let b = _store.get(ns);
    if (!b) { b = new Map(); _store.set(ns, b); }
    return b;
  }

  function _storageKey(ns, key) {
    return STORAGE_PREFIX + _boundUid + ":" + ns + ":" + key;
  }

  function _metaKey(uid) {
    return STORAGE_PREFIX + uid + ":" + META_SUFFIX;
  }

  function _readMeta(uid) {
    try {
      const raw = localStorage.getItem(_metaKey(uid));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) { return null; }
  }

  function _writeMeta() {
    if (!_persist || !_boundUid) return;
    try {
      const meta = { version: SCHEMA_VERSION, savedAt: Date.now() };
      localStorage.setItem(_metaKey(_boundUid), JSON.stringify(meta));
    } catch (_) { /* meta is best-effort */ }
  }

  // Estimate bytes for budget tracking. JSON.stringify is the rough proxy
  // localStorage actually uses (UTF-16, but order-of-magnitude is what we need).
  function _bytesOf(entry) {
    try { return JSON.stringify(entry).length; } catch (_) { return 0; }
  }

  function _totalBytes() {
    let sum = 0;
    for (const b of _store.values()) for (const e of b.values()) sum += e.bytes || 0;
    return sum;
  }

  // Evict oldest entries (by storedAt) until under target bytes. Called when
  // localStorage throws QuotaExceededError or we cross SIZE_BUDGET_BYTES.
  function _evictOldest(targetBytes) {
    const all = [];
    for (const [ns, b] of _store.entries()) {
      for (const [key, entry] of b.entries()) all.push({ ns, key, entry });
    }
    all.sort((a, c) => (a.entry.storedAt || 0) - (c.entry.storedAt || 0));
    let bytes = _totalBytes();
    for (const { ns, key } of all) {
      if (bytes <= targetBytes) break;
      const bucket = _store.get(ns);
      const entry = bucket && bucket.get(key);
      if (!entry) continue;
      bytes -= entry.bytes || 0;
      bucket.delete(key);
      if (_persist && _boundUid) {
        try { localStorage.removeItem(_storageKey(ns, key)); } catch (_) {}
      }
      _counters.evict++;
    }
  }

  function _persistEntry(ns, key, entry) {
    if (!_persist || !_boundUid) return;
    try {
      localStorage.setItem(_storageKey(ns, key), JSON.stringify(entry));
    } catch (e) {
      // Most browsers throw QuotaExceededError when localStorage is full.
      // Evict 25%, retry once, then downgrade to memory-only.
      _evictOldest(SIZE_BUDGET_BYTES * (1 - EVICT_FRACTION));
      try {
        localStorage.setItem(_storageKey(ns, key), JSON.stringify(entry));
      } catch (_) {
        console.warn("bgbCache: localStorage full, downgrading to memory-only");
        _persist = false;
      }
    }
  }

  // Rehydrate the in-memory Map from any `bgb_cache:<uid>:*` keys in
  // localStorage. Drops entries that mismatch SCHEMA_VERSION.
  function _hydrate(uid) {
    const prefix = STORAGE_PREFIX + uid + ":";
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      if (k.endsWith(":" + META_SUFFIX)) continue;
      let entry;
      try { entry = JSON.parse(localStorage.getItem(k)); } catch (_) { drop.push(k); continue; }
      if (!entry || entry.ver !== SCHEMA_VERSION) { drop.push(k); continue; }
      // Skip entries already past their stale window — no point hydrating.
      if (entry.storedAt + entry.staleTtl <= Date.now()) { drop.push(k); continue; }
      const rest = k.slice(prefix.length);
      const colon = rest.indexOf(":");
      if (colon < 0) continue;
      const ns = rest.slice(0, colon);
      const key = rest.slice(colon + 1);
      entry.bytes = entry.bytes || _bytesOf(entry);
      _bucket(ns).set(key, entry);
    }
    for (const k of drop) {
      try { localStorage.removeItem(k); } catch (_) {}
    }
  }

  // Remove every `bgb_cache:<uid>:*` key (including meta) from localStorage.
  function _purgeStorageFor(uid) {
    if (!uid) return;
    const prefix = STORAGE_PREFIX + uid + ":";
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) drop.push(k);
    }
    for (const k of drop) {
      try { localStorage.removeItem(k); } catch (_) {}
    }
  }

  function _purgeStrangers(currentUid) {
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(STORAGE_PREFIX)) continue;
      const rest = k.slice(STORAGE_PREFIX.length);
      const colon = rest.indexOf(":");
      if (colon < 0) continue;
      const uid = rest.slice(0, colon);
      if (uid !== currentUid) drop.push(k);
    }
    for (const k of drop) {
      try { localStorage.removeItem(k); } catch (_) {}
    }
  }

  const bgbCache = {
    SCHEMA_VERSION,

    /** Read a fresh value or null. Expired entries are dropped on access. */
    get(ns, key) {
      const b = _store.get(ns);
      if (!b) { _counters.miss++; return null; }
      const entry = b.get(key);
      if (!entry) { _counters.miss++; return null; }
      const age = Date.now() - entry.storedAt;
      if (age < entry.freshTtl) { _counters.freshHit++; return entry.value; }
      // Past fresh: behave like an expired entry for the back-compat get() API.
      // swr() reaches into the entry directly so it can still serve the stale
      // window — that path doesn't go through here.
      if (age >= entry.staleTtl) {
        b.delete(key);
        if (_persist && _boundUid) {
          try { localStorage.removeItem(_storageKey(ns, key)); } catch (_) {}
        }
      }
      _counters.miss++;
      return null;
    },

    /**
     * Back-compat single-TTL setter. Stores with freshTtl == staleTtl so
     * old callers see the same expiry behavior they always did.
     */
    set(ns, key, value, ttlMs = DEFAULT_TTL_MS) {
      if (ttlMs <= 0) return;
      this.setWithTtls(ns, key, value, { freshTtl: ttlMs, staleTtl: ttlMs });
    },

    /**
     * SWR setter. freshTtl: how long get() returns this value; staleTtl: how
     * long swr() will serve this value while refreshing in the background.
     */
    setWithTtls(ns, key, value, { freshTtl, staleTtl } = {}) {
      if (!freshTtl || freshTtl <= 0) return;
      if (!staleTtl || staleTtl < freshTtl) staleTtl = freshTtl;
      const entry = {
        value,
        storedAt: Date.now(),
        freshTtl,
        staleTtl,
        ver: SCHEMA_VERSION,
      };
      entry.bytes = _bytesOf(entry);
      _bucket(ns).set(key, entry);
      _persistEntry(ns, key, entry);
      _counters.set++;
      if (_totalBytes() > SIZE_BUDGET_BYTES) {
        _evictOldest(SIZE_BUDGET_BYTES);
      }
      _writeMeta();
    },

    /**
     * Stale-while-revalidate. Returns cached value during the fresh window;
     * during the stale window returns cached and fires fetcher() in the
     * background; past stale, awaits fetcher().
     */
    async swr(ns, key, fetcher, { freshTtl = DEFAULT_TTL_MS, staleTtl } = {}) {
      if (!staleTtl || staleTtl < freshTtl) staleTtl = freshTtl;
      const b = _bucket(ns);
      const entry = b.get(key);
      const now = Date.now();
      const inflightKey = ns + "\x00" + key;

      if (entry) {
        const age = now - entry.storedAt;
        if (age < entry.freshTtl) {
          _counters.freshHit++;
          return entry.value;
        }
        if (age < entry.staleTtl) {
          _counters.staleHit++;
          // Background refresh, single-flight per (ns,key).
          if (!_inflight.has(inflightKey)) {
            const p = Promise.resolve()
              .then(() => fetcher())
              .then((fresh) => { this.setWithTtls(ns, key, fresh, { freshTtl, staleTtl }); return fresh; })
              .catch((e) => { console.warn("bgbCache swr refresh failed", ns, key, e); })
              .finally(() => { _inflight.delete(inflightKey); });
            _inflight.set(inflightKey, p);
          }
          return entry.value;
        }
        // Past stale — fall through to the miss path.
        b.delete(key);
        if (_persist && _boundUid) {
          try { localStorage.removeItem(_storageKey(ns, key)); } catch (_) {}
        }
      }
      _counters.miss++;
      if (_inflight.has(inflightKey)) return _inflight.get(inflightKey);
      const p = Promise.resolve()
        .then(() => fetcher())
        .then((fresh) => { this.setWithTtls(ns, key, fresh, { freshTtl, staleTtl }); return fresh; })
        .finally(() => { _inflight.delete(inflightKey); });
      _inflight.set(inflightKey, p);
      return p;
    },

    /** Drop a single key. Silent no-op when missing. */
    delete(ns, key) {
      const b = _store.get(ns);
      if (b) b.delete(key);
      if (_persist && _boundUid) {
        try { localStorage.removeItem(_storageKey(ns, key)); } catch (_) {}
      }
    },

    /** Drop a namespace (or every namespace when ns is omitted/null). */
    clear(ns) {
      if (ns == null) {
        // Wipe everything for the bound user. Memory and storage.
        for (const [n, b] of _store.entries()) {
          for (const k of b.keys()) {
            if (_persist && _boundUid) {
              try { localStorage.removeItem(_storageKey(n, k)); } catch (_) {}
            }
          }
        }
        _store.clear();
        return;
      }
      const b = _store.get(ns);
      if (!b) return;
      if (_persist && _boundUid) {
        for (const k of b.keys()) {
          try { localStorage.removeItem(_storageKey(ns, k)); } catch (_) {}
        }
      }
      b.clear();
    },

    /**
     * Bind the cache to a user. Wipes any localStorage entries from other
     * users, rehydrates this user's entries into memory, and enables
     * write-through persistence.
     */
    bindUser(userId) {
      if (!userId) return;
      if (_boundUid === userId) return;
      // Clean slate before hydrating so a logout-without-unbind can't leak.
      _store.clear();
      _inflight.clear();
      _boundUid = userId;
      _persist = true;
      _purgeStrangers(userId);
      const meta = _readMeta(userId);
      if (meta && meta.version !== SCHEMA_VERSION) {
        _purgeStorageFor(userId);
      } else {
        _hydrate(userId);
      }
      _writeMeta();
    },

    /**
     * Unbind the current user. Wipes both in-memory and localStorage for that
     * user. Call this on logout before resetting the store.
     */
    unbindUser() {
      const uid = _boundUid;
      _store.clear();
      _inflight.clear();
      if (uid) _purgeStorageFor(uid);
      _boundUid = null;
    },

    /** Snapshot of per-namespace sizes + counters — debug aid only. */
    stats() {
      const out = { _counters: { ..._counters }, _boundUid, _persist, _totalBytes: _totalBytes() };
      for (const [ns, b] of _store.entries()) {
        let bytes = 0;
        for (const e of b.values()) bytes += e.bytes || 0;
        out[ns] = { entries: b.size, bytes };
      }
      return out;
    },
  };

  window.bgbCache = bgbCache;
})();
