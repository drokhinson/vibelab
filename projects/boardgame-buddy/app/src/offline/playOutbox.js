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
//
// Retry safety comes from `client_key` (migration 048): ONE uuid minted per
// queued play at enqueue time and re-sent on every attempt, so a lost response
// — the request landed, the reply didn't — returns the original play instead
// of writing a second one. Minting per ATTEMPT instead would be the same bug
// with extra steps, which is why the key lives on the entry, not in the
// upload call. Both upload paths carry it: bgb_finalize_session calls
// bgb_log_play, so the lobby path inherits the same guard.

import AsyncStorage from '@react-native-async-storage/async-storage';
// expo-file-system top-level export changed shape in SDK 54 — the /legacy
// subpath keeps documentDirectory/copyAsync/deleteAsync (sauceboss pattern).
import * as FileSystem from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';
import api from '../api/client';

const KEY = 'bgb:playOutbox:v1';
const PHOTO_DIR = `${FileSystem.documentDirectory || ''}bgb-outbox/`;

/**
 * @typedef {Object} PendingPlay
 * @property {string} localId
 * @property {string} clientKey     uuid, also carried on payload.client_key
 * @property {string|null} userId   account that recorded it; only they flush it
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

/**
 * Synchronous snapshot for render. Pass the signed-in account id to see only
 * that user's queue — which is what every UI surface wants, since a play
 * belongs to whoever recorded it.
 * @param {string|null} [userId]
 */
export function listPending(userId) {
  if (!userId) return _items;
  return _items.filter((i) => !i.userId || i.userId === userId);
}

export async function hydrateOutbox() {
  if (_hydrated) return _items;
  _hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Entries queued before client_key existed have never been uploaded,
        // so stamping one now is safe and makes their FIRST attempt keyed —
        // which is all idempotency needs, since only retries can duplicate.
        let migrated = false;
        _items = parsed.map((it) => {
          if (it && it.clientKey) return it;
          migrated = true;
          const clientKey = randomUUID();
          return { ...it, clientKey, payload: { ...(it?.payload || {}), client_key: clientKey } };
        });
        if (migrated) _persist();
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
 * @returns {Promise<PendingPlay>}
 * @param {Omit<PendingPlay, 'localId'|'clientKey'|'createdAt'|'attempts'|'lastError'>} item
 *   `userId` is the account recording the play — required for the flush to
 *   ever pick it up again.
 */
export async function enqueuePlay(item) {
  await hydrateOutbox();
  // Crypto-backed, not Math.random(): two devices flushing into the same
  // account must not be able to collide on a key, since a collision would
  // silently drop the second play as a "duplicate".
  const clientKey = randomUUID();
  const pending = {
    localId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    ...item,
    clientKey,
    payload: { ...(item.payload || {}), client_key: clientKey },
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
 *
 * Scoped to one account: POST /plays writes under whoever's token is attached,
 * so flushing a housemate's queued play while you're signed in would file
 * their game into your history. Entries predating userId have no owner
 * recorded and are flushed by whoever is signed in — the old behaviour, and
 * the only answer available for them.
 * @param {string|null} [userId]
 * @returns {Promise<{flushed: Array<{localId:string, gameId:string|null}>, remaining: number}>}
 */
export async function flushOutbox(userId) {
  await hydrateOutbox();
  const mine = listPending(userId);
  if (_inFlight || mine.length === 0) return { flushed: [], remaining: mine.length };
  _inFlight = true;
  const flushed = [];
  try {
    for (const item of mine) {
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
  return { flushed, remaining: listPending(userId).length };
}

/**
 * Wipe the whole queue, photos included. NOT called on sign-out: a queued play
 * is a game somebody actually played, and signing out — or being signed out by
 * an expired token — must not destroy it. The queue is scoped by account
 * instead (see flushOutbox), so it survives until its owner comes back and it
 * uploads. This exists for an explicit "clear everything" and for tests.
 */
export async function clearOutbox() {
  await hydrateOutbox();
  for (const item of _items) await _deletePhoto(item.photoUri);
  _items = [];
  await _persist();
  _emit();
}
