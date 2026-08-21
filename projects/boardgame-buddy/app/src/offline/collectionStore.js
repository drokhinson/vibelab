// @ts-check
// Offline owned/wishlist collection. The full collection (denormalized game
// fields included) persists to AsyncStorage and hydrates into memory BEFORE
// any network call, so game search and play setup work instantly — even in
// airplane mode. Never the source of truth: a background refresh from
// GET /collection reconciles it whenever we're online, and every collection
// mutation / BGG sync completion triggers a refresh.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../api/client';

// v2 = rows keep GET /collection's nested `game` object. A v1 payload (flat
// `game_*` columns) is simply not read; the first refresh rewrites it.
const KEY = 'bgb:collection:v2';

/** @type {{ items: import('../api/types').CollectionItem[], syncedAt: number|null }} */
let _state = { items: [], syncedAt: null };
let _hydrated = false;
const _listeners = new Set();

function _emit() {
  for (const fn of _listeners) fn(_state);
}

/** Subscribe to collection changes. Returns unsubscribe. */
export function subscribeCollection(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Synchronous snapshot (for useSyncExternalStore + search). */
export function getCollectionSnapshot() {
  return _state;
}

/** Load the persisted collection into memory. Call once at boot. */
export async function hydrateCollection() {
  if (_hydrated) return _state;
  _hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) {
        _state = { items: parsed.items, syncedAt: parsed.syncedAt || null };
        _emit();
      }
    }
  } catch {
    // Corrupt cache — start empty; refresh will rebuild it.
  }
  return _state;
}

/** Pull the fresh collection from the API and persist. No-op on failure
 *  (offline) — the stale snapshot stays serviceable. */
export async function refreshCollection() {
  try {
    const items = await api.collection();
    const list = Array.isArray(items) ? items : [];
    _state = { items: list, syncedAt: Date.now() };
    _emit();
    AsyncStorage.setItem(KEY, JSON.stringify(_state)).catch(() => {});
    return _state;
  } catch {
    return null;
  }
}

/** Optimistically apply a local status change so search/grids reflect it
 *  before (or without) the next server refresh. */
export function applyLocalStatus(gameId, status, gameSummary) {
  const items = _state.items.filter((it) => it.game_id !== gameId);
  if (status === 'owned' || status === 'wishlist') {
    const prev = _state.items.find((it) => it.game_id === gameId);
    items.push({
      ...(prev || {
        id: `local-${gameId}`,
        game_id: gameId,
        added_at: new Date().toISOString(),
        last_played_at: null,
        play_count: 0,
        // Same nested shape GET /collection returns, so the next background
        // refresh replaces this row rather than changing the shape under
        // collectionGames().
        game: { ...(gameSummary || {}), id: gameId },
      }),
      status,
    });
  }
  _state = { ..._state, items };
  _emit();
  AsyncStorage.setItem(KEY, JSON.stringify(_state)).catch(() => {});
}

/** Wipe on sign-out. */
export async function clearCollection() {
  _state = { items: [], syncedAt: null };
  _emit();
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {}
}

/**
 * Shelf rows flattened to GameSummary-shaped objects for search/display, with
 * the row's `status` and play stats carried along. `it.game` is the nested
 * GameSummary GET /collection returns — do NOT reintroduce flat `game_*`
 * field reads here; that shape belongs to /collection/grid, not this endpoint.
 */
export function collectionGames() {
  return _state.items
    .filter((it) => it && it.game)
    .map((it) => ({
      ...it.game,
      id: it.game.id || it.game_id,
      name: it.game.name || '',
      status: it.status,
      last_played_at: it.last_played_at ?? null,
      play_count: it.play_count ?? 0,
    }));
}
