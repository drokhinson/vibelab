// src/cache/index.js — namespaced TTL cache with AsyncStorage persistence and
// stale-while-revalidate. Ported from web/domain/cache.js.
//
// Semantics are identical to the web cache:
//   - get(ns, key) returns the value while FRESH (now < storedAt + freshTtl),
//     else null.
//   - swr(ns, key, fetcher, opts) returns the cached value out to storedAt +
//     staleTtl, firing fetcher() in the background (single-flight per ns,key)
//     once the fresh window lapses; past stale it awaits fetcher().
//
// Native adaptation: localStorage → AsyncStorage. Because AsyncStorage is async
// (localStorage is sync), the in-memory Map is the primary store that get/set
// read/write synchronously, and persistence is async write-through (fire and
// forget). bindUser() is async — it awaits hydration from AsyncStorage before
// resolving, so callers should `await bgbCache.bindUser(uid)` before their first
// read on cold start.

import AsyncStorage from '@react-native-async-storage/async-storage';

const SCHEMA_VERSION = 1;
const STORAGE_PREFIX = 'bgb_cache:';
const META_SUFFIX = '__meta';
const SIZE_BUDGET_BYTES = 3 * 1024 * 1024; // ~3 MB budget
const EVICT_FRACTION = 0.25;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// ns → key → { value, storedAt, freshTtl, staleTtl, ver, bytes }
const _store = new Map();
// (ns,key) → Promise — single-flight guard inside swr().
const _inflight = new Map();
let _boundUid = null;
const _counters = { freshHit: 0, staleHit: 0, miss: 0, set: 0, evict: 0 };

function _bucket(ns) {
  let b = _store.get(ns);
  if (!b) { b = new Map(); _store.set(ns, b); }
  return b;
}

function _storageKey(ns, key) {
  return STORAGE_PREFIX + _boundUid + ':' + ns + ':' + key;
}

function _metaKey(uid) {
  return STORAGE_PREFIX + uid + ':' + META_SUFFIX;
}

function _bytesOf(entry) {
  try { return JSON.stringify(entry).length; } catch { return 0; }
}

function _totalBytes() {
  let sum = 0;
  for (const b of _store.values()) for (const e of b.values()) sum += e.bytes || 0;
  return sum;
}

// Evict oldest entries (by storedAt) until under target bytes.
function _evictOldest(targetBytes) {
  const all = [];
  for (const [ns, b] of _store.entries()) {
    for (const [key, entry] of b.entries()) all.push({ ns, key, entry });
  }
  all.sort((a, c) => (a.entry.storedAt || 0) - (c.entry.storedAt || 0));
  let bytes = _totalBytes();
  const removedStorageKeys = [];
  for (const { ns, key } of all) {
    if (bytes <= targetBytes) break;
    const bucket = _store.get(ns);
    const entry = bucket && bucket.get(key);
    if (!entry) continue;
    bytes -= entry.bytes || 0;
    bucket.delete(key);
    if (_boundUid) removedStorageKeys.push(_storageKey(ns, key));
    _counters.evict++;
  }
  if (removedStorageKeys.length) AsyncStorage.multiRemove(removedStorageKeys).catch(() => {});
}

// Async write-through — never blocks set().
function _persistEntry(ns, key, entry) {
  if (!_boundUid) return;
  AsyncStorage.setItem(_storageKey(ns, key), JSON.stringify(entry)).catch(() => {});
}

function _writeMeta() {
  if (!_boundUid) return;
  const meta = { version: SCHEMA_VERSION, savedAt: Date.now() };
  AsyncStorage.setItem(_metaKey(_boundUid), JSON.stringify(meta)).catch(() => {});
}

async function _hydrate(uid) {
  const prefix = STORAGE_PREFIX + uid + ':';
  let keys = [];
  try { keys = await AsyncStorage.getAllKeys(); } catch { return; }
  const mine = keys.filter((k) => k.startsWith(prefix) && !k.endsWith(':' + META_SUFFIX));
  if (!mine.length) return;
  let pairs = [];
  try { pairs = await AsyncStorage.multiGet(mine); } catch { return; }
  const drop = [];
  for (const [k, raw] of pairs) {
    let entry;
    try { entry = JSON.parse(raw); } catch { drop.push(k); continue; }
    if (!entry || entry.ver !== SCHEMA_VERSION) { drop.push(k); continue; }
    if (entry.storedAt + entry.staleTtl <= Date.now()) { drop.push(k); continue; }
    const rest = k.slice(prefix.length);
    const colon = rest.indexOf(':');
    if (colon < 0) continue;
    const ns = rest.slice(0, colon);
    const key = rest.slice(colon + 1);
    entry.bytes = entry.bytes || _bytesOf(entry);
    _bucket(ns).set(key, entry);
  }
  if (drop.length) AsyncStorage.multiRemove(drop).catch(() => {});
}

async function _purgeStorageFor(uid) {
  if (!uid) return;
  const prefix = STORAGE_PREFIX + uid + ':';
  let keys = [];
  try { keys = await AsyncStorage.getAllKeys(); } catch { return; }
  const drop = keys.filter((k) => k.startsWith(prefix));
  if (drop.length) await AsyncStorage.multiRemove(drop).catch(() => {});
}

async function _purgeStrangers(currentUid) {
  let keys = [];
  try { keys = await AsyncStorage.getAllKeys(); } catch { return; }
  const drop = [];
  for (const k of keys) {
    if (!k.startsWith(STORAGE_PREFIX)) continue;
    const rest = k.slice(STORAGE_PREFIX.length);
    const colon = rest.indexOf(':');
    if (colon < 0) continue;
    const uid = rest.slice(0, colon);
    if (uid !== currentUid) drop.push(k);
  }
  if (drop.length) await AsyncStorage.multiRemove(drop).catch(() => {});
}

export const bgbCache = {
  SCHEMA_VERSION,

  /** Read a fresh value or null. Expired entries are dropped on access. */
  get(ns, key) {
    const b = _store.get(ns);
    if (!b) { _counters.miss++; return null; }
    const entry = b.get(key);
    if (!entry) { _counters.miss++; return null; }
    const age = Date.now() - entry.storedAt;
    if (age < entry.freshTtl) { _counters.freshHit++; return entry.value; }
    if (age >= entry.staleTtl) {
      b.delete(key);
      if (_boundUid) AsyncStorage.removeItem(_storageKey(ns, key)).catch(() => {});
    }
    _counters.miss++;
    return null;
  },

  /** Back-compat single-TTL setter (freshTtl == staleTtl). */
  set(ns, key, value, ttlMs = DEFAULT_TTL_MS) {
    if (ttlMs <= 0) return;
    this.setWithTtls(ns, key, value, { freshTtl: ttlMs, staleTtl: ttlMs });
  },

  /** SWR setter. */
  setWithTtls(ns, key, value, { freshTtl, staleTtl } = {}) {
    if (!freshTtl || freshTtl <= 0) return;
    if (!staleTtl || staleTtl < freshTtl) staleTtl = freshTtl;
    const entry = { value, storedAt: Date.now(), freshTtl, staleTtl, ver: SCHEMA_VERSION };
    entry.bytes = _bytesOf(entry);
    _bucket(ns).set(key, entry);
    _persistEntry(ns, key, entry);
    _counters.set++;
    if (_totalBytes() > SIZE_BUDGET_BYTES) _evictOldest(SIZE_BUDGET_BYTES * (1 - EVICT_FRACTION));
    _writeMeta();
  },

  /** Stale-while-revalidate. */
  async swr(ns, key, fetcher, { freshTtl = DEFAULT_TTL_MS, staleTtl } = {}) {
    if (!staleTtl || staleTtl < freshTtl) staleTtl = freshTtl;
    const b = _bucket(ns);
    const entry = b.get(key);
    const now = Date.now();
    const inflightKey = ns + '\x00' + key;

    if (entry) {
      const age = now - entry.storedAt;
      if (age < entry.freshTtl) { _counters.freshHit++; return entry.value; }
      if (age < entry.staleTtl) {
        _counters.staleHit++;
        if (!_inflight.has(inflightKey)) {
          const p = Promise.resolve()
            .then(() => fetcher())
            .then((fresh) => { this.setWithTtls(ns, key, fresh, { freshTtl, staleTtl }); return fresh; })
            .catch(() => {})
            .finally(() => { _inflight.delete(inflightKey); });
          _inflight.set(inflightKey, p);
        }
        return entry.value;
      }
      b.delete(key);
      if (_boundUid) AsyncStorage.removeItem(_storageKey(ns, key)).catch(() => {});
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

  /** Drop a single key. */
  delete(ns, key) {
    const b = _store.get(ns);
    if (b) b.delete(key);
    if (_boundUid) AsyncStorage.removeItem(_storageKey(ns, key)).catch(() => {});
  },

  /** Drop a namespace (or every namespace when ns is omitted/null). */
  clear(ns) {
    if (ns == null) {
      const removed = [];
      for (const [n, b] of _store.entries()) {
        for (const k of b.keys()) if (_boundUid) removed.push(_storageKey(n, k));
      }
      _store.clear();
      if (removed.length) AsyncStorage.multiRemove(removed).catch(() => {});
      return;
    }
    const b = _store.get(ns);
    if (!b) return;
    const removed = [];
    if (_boundUid) for (const k of b.keys()) removed.push(_storageKey(ns, k));
    b.clear();
    if (removed.length) AsyncStorage.multiRemove(removed).catch(() => {});
  },

  /**
   * Bind the cache to a user. Wipes other users' entries, rehydrates this
   * user's entries into memory, enables write-through. Async — await before
   * the first cold-start read so persisted values are available.
   */
  async bindUser(userId) {
    if (!userId) return;
    if (_boundUid === userId) return;
    _store.clear();
    _inflight.clear();
    _boundUid = userId;
    await _purgeStrangers(userId);
    let meta = null;
    try { meta = JSON.parse(await AsyncStorage.getItem(_metaKey(userId))); } catch {}
    if (meta && meta.version !== SCHEMA_VERSION) {
      await _purgeStorageFor(userId);
    } else {
      await _hydrate(userId);
    }
    _writeMeta();
  },

  /** Unbind the current user. Wipes memory + this user's storage. */
  async unbindUser() {
    const uid = _boundUid;
    _store.clear();
    _inflight.clear();
    _boundUid = null;
    if (uid) await _purgeStorageFor(uid);
  },

  stats() {
    const out = { _counters: { ..._counters }, _boundUid, _totalBytes: _totalBytes() };
    for (const [ns, b] of _store.entries()) {
      let bytes = 0;
      for (const e of b.values()) bytes += e.bytes || 0;
      out[ns] = { entries: b.size, bytes };
    }
    return out;
  },
};
