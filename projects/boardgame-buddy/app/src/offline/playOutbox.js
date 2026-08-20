// @ts-check
// playOutbox — the queue of plays recorded offline (or lost to a dead link at
// save time), uploaded when connectivity returns. Follows the repo outbox
// pattern (sauceboss offline/sync.js): the module owns its storage, guards
// concurrent flushes with an inFlight flag, and notifies subscribers so UI
// badges stay live.
//
// Error semantics (matches src/api/client.js): an error WITHOUT `.status` is
// a network failure — the flush stops and retries later. An error WITH a 4xx
// status is a server rejection — the item is kept with `lastError` so the
// user can see why and discard it; the flush continues to the next item.

import AsyncStorage from '@react-native-async-storage/async-storage';
// expo-file-system top-level export changed shape in SDK 54 — the /legacy
// subpath keeps documentDirectory/copyAsync/deleteAsync (sauceboss pattern).
import * as FileSystem from 'expo-file-system/legacy';
import api from '../api/client';

const KEY = 'bgb:playOutbox:v1';
const PHOTO_DIR = `${FileSystem.documentDirectory || ''}bgb-outbox/`;

/**
 * @typedef {Object} PendingPlay
 * @property {string} localId
 * @property {Object} payload       PlayCreate body (photo_url always null)
 * @property {string|null} code     lobby code if the session was opened online
 * @property {string|null} photoUri persisted copy under PHOTO_DIR
 * @property {{id:string,name:string,thumbnail_url:string|null,theme_color:string|null}|null} gameSnapshot
 * @property {string|null} winnerName
 * @property {string} createdAt
 * @property {number} attempts
 * @property {string|null} lastError
 */

/** @type {PendingPlay[]} */
let _items = [];
let _hydrated = false;
let _inFlight = false;
const _listeners = new Set();

function _emit() {
  for (const fn of _listeners) {
    try {
      fn(_items);
    } catch {}
  }
}

async function _persist() {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(_items));
  } catch {}
}

export function subscribeOutbox(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Synchronous snapshot for render. */
export function listPending() {
  return _items;
}

export async function hydrateOutbox() {
  if (_hydrated) return _items;
  _hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        _items = parsed;
        _emit();
      }
    }
  } catch {}
  return _items;
}

/** Copy a temp photo (ImageManipulator cache — purgeable) into our own
 *  document dir so it survives until upload. Returns the stable uri, or null
 *  if the copy fails (the play still queues, just without its photo). */
export async function persistOutboxPhoto(photo, localId) {
  if (!photo?.uri || !FileSystem.documentDirectory) return null;
  try {
    await FileSystem.makeDirectoryAsync(PHOTO_DIR, { intermediates: true }).catch(() => {});
    const dest = `${PHOTO_DIR}${localId}.jpg`;
    await FileSystem.copyAsync({ from: photo.uri, to: dest });
    return dest;
  } catch {
    return null;
  }
}

async function _deletePhoto(uri) {
  if (!uri) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {}
}

/**
 * @param {Omit<PendingPlay, 'localId'|'createdAt'|'attempts'|'lastError'>} item
 * @returns {Promise<PendingPlay>}
 */
export async function enqueuePlay(item) {
  await hydrateOutbox();
  const pending = {
    localId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    ...item,
  };
  _items = [..._items, pending];
  await _persist();
  _emit();
  return pending;
}

export async function discardPlay(localId) {
  await hydrateOutbox();
  const item = _items.find((i) => i.localId === localId);
  if (item) await _deletePhoto(item.photoUri);
  _items = _items.filter((i) => i.localId !== localId);
  await _persist();
  _emit();
}

function _isNetworkError(e) {
  return !e || e.status == null;
}

/** Upload one pending play: finalize the original lobby when it still exists,
 *  else plain createPlay; then best-effort photo attach. */
async function _uploadItem(item) {
  let saved = null;
  if (item.code) {
    try {
      saved = await api.finalizeSession(item.code, item.payload);
    } catch (e) {
      if (_isNetworkError(e)) throw e;
      // Session expired / already finalized / rejected — fall back to a
      // plain play so the record isn't lost.
      saved = await api.createPlay(item.payload);
    }
  } else {
    saved = await api.createPlay(item.payload);
  }
  const playId = saved?.id || saved?.play_id || saved?.play?.id || null;

  if (item.photoUri && playId) {
    // Photo attach mirrors playSave.js: upload, then PATCH the one column.
    // Best-effort — a failure here never blocks the queue (the play itself
    // is already saved).
    try {
      const resp = await api.uploadPlayPhoto({ uri: item.photoUri, name: 'play.jpg', type: 'image/jpeg' });
      if (resp?.photo_url) await api.attachPlayPhoto(playId, resp.photo_url);
    } catch {}
  }
  return playId;
}

/**
 * Serial flush. Network error stops the run (still offline); a server
 * rejection records lastError on the item and moves on.
 * @returns {Promise<{flushed: Array<{localId:string, gameId:string|null}>, remaining: number}>}
 */
export async function flushOutbox() {
  await hydrateOutbox();
  if (_inFlight || _items.length === 0) return { flushed: [], remaining: _items.length };
  _inFlight = true;
  const flushed = [];
  try {
    for (const item of [..._items]) {
      try {
        await _uploadItem(item);
        await _deletePhoto(item.photoUri);
        _items = _items.filter((i) => i.localId !== item.localId);
        flushed.push({ localId: item.localId, gameId: item.payload?.game_id || null });
        await _persist();
        _emit();
      } catch (e) {
        if (_isNetworkError(e)) break; // still offline — try again later
        _items = _items.map((i) =>
          i.localId === item.localId
            ? { ...i, attempts: i.attempts + 1, lastError: e.message || 'Upload rejected' }
            : i,
        );
        await _persist();
        _emit();
      }
    }
  } finally {
    _inFlight = false;
  }
  return { flushed, remaining: _items.length };
}

/** Wipe on sign-out — queued plays belong to the signed-in account. */
export async function clearOutbox() {
  await hydrateOutbox();
  for (const item of _items) await _deletePhoto(item.photoUri);
  _items = [];
  await _persist();
  _emit();
}
