// AsyncStorage-backed cache for the Offline Saucebook feature.
//
// Layout:
//   sb:offline:v1:settings            → { enabled }   (device-global)
//   sb:offline:v1:<userId>:meta       → { bytes, count, lastSyncedAt, pendingDownload }
//   sb:offline:v1:<userId>:list       → slim saucebook envelopes (Sets stripped)
//   sb:offline:v1:<userId>:sauce:<id> → one full recipe envelope per key
//
// One key per sauce avoids Android's 6MB per-entry limit and makes incremental
// add/remove cheap. ingredientNames is stored as a string array and re-hydrated
// into a Set via withIngredientNames on read (callers handle this — cache.js
// stays pure JSON).
//
// Running byte/count totals are tracked at write time so SettingsScreen can
// display storage usage without scanning every key.
//
// Pure I/O — no React, no dispatch, no api calls.

import AsyncStorage from '@react-native-async-storage/async-storage';

const NS = 'sb:offline:v1';
const SETTINGS_KEY = `${NS}:settings`;

function metaKey(userId) { return `${NS}:${userId}:meta`; }
function listKey(userId) { return `${NS}:${userId}:list`; }
function sauceKey(userId, sauceId) { return `${NS}:${userId}:sauce:${sauceId}`; }
function userPrefix(userId) { return `${NS}:${userId}:`; }

// ── byte helpers ─────────────────────────────────────────────────────────────
// UTF-8 byte length. Most recipe text is ASCII so this is exact; multibyte
// chars (emoji in cuisine names) are a small overcount of the JSON payload.
function byteLength(str) {
  if (!str) return 0;
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; } // surrogate pair
    else bytes += 3;
  }
  return bytes;
}

// Replacer that drops Sets (and Maps) — JSON.stringify default skips them
// silently which would produce `"ingredientNames": {}`. Convert to arrays.
function jsonReplacer(_key, value) {
  if (value instanceof Set) return Array.from(value);
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

function stringify(obj) {
  return JSON.stringify(obj, jsonReplacer);
}

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// ── settings (device-global) ─────────────────────────────────────────────────
// `onboardingSeen` tracks whether we've shown the first-time "save offline?"
// prompt yet. Device-scoped so the same Alert doesn't pop on every sign-in.
const DEFAULT_SETTINGS = { enabled: false, onboardingSeen: false };

export async function loadSettings() {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  const parsed = safeParse(raw);
  return { ...DEFAULT_SETTINGS, ...(parsed || {}) };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await AsyncStorage.setItem(SETTINGS_KEY, stringify(next));
  return next;
}

// ── meta (per-user totals) ───────────────────────────────────────────────────
const DEFAULT_META = { bytes: 0, count: 0, lastSyncedAt: null, pendingDownload: false };

export async function readMeta(userId) {
  if (!userId) return { ...DEFAULT_META };
  const raw = await AsyncStorage.getItem(metaKey(userId));
  const parsed = safeParse(raw);
  return { ...DEFAULT_META, ...(parsed || {}) };
}

export async function writeMeta(userId, patch) {
  if (!userId) return { ...DEFAULT_META };
  const current = await readMeta(userId);
  const next = { ...current, ...patch };
  // Clamp negatives in case a delta over-decrements.
  if (next.bytes < 0) next.bytes = 0;
  if (next.count < 0) next.count = 0;
  await AsyncStorage.setItem(metaKey(userId), stringify(next));
  return next;
}

// ── slim saucebook list ──────────────────────────────────────────────────────
export async function readList(userId) {
  if (!userId) return null;
  const raw = await AsyncStorage.getItem(listKey(userId));
  return safeParse(raw); // array of slim envelopes with ingredientNames as string[]
}

export async function writeList(userId, items) {
  if (!userId) return;
  const before = (await AsyncStorage.getItem(listKey(userId))) || '';
  const next = stringify(items || []);
  await AsyncStorage.setItem(listKey(userId), next);
  const delta = byteLength(next) - byteLength(before);
  await writeMeta(userId, { bytes: (await readMeta(userId)).bytes + delta });
}

// ── full recipe envelopes ────────────────────────────────────────────────────
export async function readSauce(userId, sauceId) {
  if (!userId || !sauceId) return null;
  const raw = await AsyncStorage.getItem(sauceKey(userId, sauceId));
  return safeParse(raw);
}

export async function writeSauces(userId, sauces) {
  if (!userId || !sauces?.length) return { addedBytes: 0, addedCount: 0 };

  const keys = sauces.map((s) => sauceKey(userId, s.id));
  const existing = await AsyncStorage.multiGet(keys);
  const existingSize = new Map(
    existing.map(([k, v]) => [k, v ? byteLength(v) : 0]),
  );

  const pairs = sauces.map((s) => [sauceKey(userId, s.id), stringify(s)]);
  await AsyncStorage.multiSet(pairs);

  let addedBytes = 0;
  let addedCount = 0;
  for (const [k, v] of pairs) {
    const oldBytes = existingSize.get(k) || 0;
    addedBytes += byteLength(v) - oldBytes;
    if (!oldBytes) addedCount += 1;
  }

  const meta = await readMeta(userId);
  await writeMeta(userId, {
    bytes: meta.bytes + addedBytes,
    count: meta.count + addedCount,
  });
  return { addedBytes, addedCount };
}

// Pull every cached full envelope whose root matches `rootId`. Used by
// openSauceById's cache-first path so the variant picker shows the full
// family even when the slim list (saucebook-only rows) is missing siblings
// that were cached for completeness by syncAll.
export async function readFamily(userId, rootId) {
  if (!userId || !rootId) return [];
  const sauceKeyPrefix = `${userPrefix(userId)}sauce:`;
  const allKeys = await AsyncStorage.getAllKeys();
  const mine = allKeys.filter((k) => k.startsWith(sauceKeyPrefix));
  if (!mine.length) return [];
  const entries = await AsyncStorage.multiGet(mine);
  const family = [];
  for (const [, v] of entries) {
    const parsed = safeParse(v);
    if (!parsed) continue;
    if (parsed.id === rootId || parsed.parentSauceId === rootId) family.push(parsed);
  }
  return family;
}

export async function deleteSauce(userId, sauceId) {
  if (!userId || !sauceId) return;
  const key = sauceKey(userId, sauceId);
  const existing = await AsyncStorage.getItem(key);
  if (existing == null) return;
  await AsyncStorage.removeItem(key);
  const meta = await readMeta(userId);
  await writeMeta(userId, {
    bytes: meta.bytes - byteLength(existing),
    count: meta.count - 1,
  });
}

// ── full wipe ────────────────────────────────────────────────────────────────
export async function clearAll(userId) {
  if (!userId) return;
  const prefix = userPrefix(userId);
  const allKeys = await AsyncStorage.getAllKeys();
  const mine = allKeys.filter((k) => k.startsWith(prefix));
  if (mine.length) await AsyncStorage.multiRemove(mine);
}

// Recompute meta from disk — used as a safety net if the running total drifts
// or on first launch after upgrading from a no-meta cache. Cheap-ish: one
// multiGet over the user's keys.
export async function recomputeMeta(userId) {
  if (!userId) return { ...DEFAULT_META };
  const prefix = userPrefix(userId);
  const sauceKeyPrefix = `${prefix}sauce:`;
  const allKeys = await AsyncStorage.getAllKeys();
  const sauceKeys = allKeys.filter((k) => k.startsWith(sauceKeyPrefix));
  const listRaw = await AsyncStorage.getItem(listKey(userId));
  let bytes = byteLength(listRaw || '');
  let count = 0;
  if (sauceKeys.length) {
    const entries = await AsyncStorage.multiGet(sauceKeys);
    for (const [, v] of entries) {
      if (v != null) {
        bytes += byteLength(v);
        count += 1;
      }
    }
  }
  const current = await readMeta(userId);
  return writeMeta(userId, { bytes, count, lastSyncedAt: current.lastSyncedAt });
}

// ── display helpers ──────────────────────────────────────────────────────────
export function formatBytes(n) {
  if (!n || n < 0) return '0 KB';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatRelative(ts) {
  if (!ts) return 'never';
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 0 || Number.isNaN(ms)) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
