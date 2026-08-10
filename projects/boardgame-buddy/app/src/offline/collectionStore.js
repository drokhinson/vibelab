// @ts-check
// Offline owned/wishlist collection. The full collection (denormalized game
// fields included) persists to AsyncStorage and hydrates into memory BEFORE
// any network call, so game search and play setup work instantly — even in
// airplane mode. Never the source of truth: a background refresh from
// GET /collection reconciles it whenever we're online, and every collection
// mutation / BGG sync completion triggers a refresh.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../api/client';

const KEY = 'bgb:collection:v1';

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
        game_name: gameSummary?.name || null,
        game_thumbnail_url: gameSummary?.thumbnail_url || null,
        game_year_published: gameSummary?.year_published ?? null,
        game_min_players: gameSummary?.min_players ?? null,
        game_max_players: gameSummary?.max_players ?? null,
        game_playing_time: gameSummary?.playing_time ?? null,
        game_is_expansion: gameSummary?.is_expansion ?? null,
        game_base_game_bgg_id: gameSummary?.base_game_bgg_id ?? null,
        game_expansion_color: gameSummary?.expansion_color ?? null,
        game_play_mode: gameSummary?.play_mode ?? null,
        game_bgg_id: gameSummary?.bgg_id ?? null,
        game_theme_color: gameSummary?.theme_color ?? null,
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

/** Owned+wishlist items as GameSummary-ish objects for search/display. */
export function collectionGames() {
  return _state.items.map((it) => ({
    id: it.game_id,
    bgg_id: it.game_bgg_id ?? null,
    name: it.game_name || '',
    year_published: it.game_year_published ?? null,
    min_players: it.game_min_players ?? null,
    max_players: it.game_max_players ?? null,
    playing_time: it.game_playing_time ?? null,
    thumbnail_url: it.game_thumbnail_url ?? null,
    image_url: null,
    theme_color: it.game_theme_color ?? null,
    is_expansion: !!it.game_is_expansion,
    base_game_bgg_id: it.game_base_game_bgg_id ?? null,
    expansion_color: it.game_expansion_color ?? null,
    play_mode: it.game_play_mode ?? null,
    status: it.status,
  }));
}
