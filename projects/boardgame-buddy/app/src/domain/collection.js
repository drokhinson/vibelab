// src/domain/collection.js — Collection mutations + cached viewer status map +
// per-base-game expansion-owned counts. Ported from web/domain/collection.js.
// Both maps come from a single /collection fetch and are cached together; any
// mutation busts both plus the profile/game bundles that embed them.

import { api } from '../api/client';
import { bgbCache } from '../cache';

const NS = 'collection';
const COMBINED_KEY = 'combined';
const FRESH_TTL_MS = 60 * 1000;
const STALE_TTL_MS = 5 * 60 * 1000;

async function fetchCombined() {
  const data = await api.get('/collection');
  const items = Array.isArray(data) ? data : ((data && data.items) || []);
  const status = {};
  const expCount = {};
  for (const it of items) {
    if (it.status === 'owned' || it.status === 'wishlist' || it.status === 'played') {
      status[it.game_id] = it.status;
    }
    const g = it.game;
    if (it.status === 'owned' && g && g.is_expansion && g.base_game_bgg_id) {
      expCount[g.base_game_bgg_id] = (expCount[g.base_game_bgg_id] || 0) + 1;
    }
  }
  return { status, expCount };
}

function ensure({ force = false } = {}) {
  if (force) bgbCache.delete(NS, COMBINED_KEY);
  return bgbCache.swr(NS, COMBINED_KEY, fetchCombined, { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS });
}

export const Collection = {
  add(gameId, status) {
    return api.post('/collection', { game_id: gameId, status })
      .then((r) => { Collection.invalidate(); return r; });
  },
  updateStatus(itemId, status) {
    return api.patch(`/collection/${itemId}`, { status })
      .then((r) => { Collection.invalidate(); return r; });
  },
  remove(itemId) {
    return api.del(`/collection/${itemId}`).then((r) => { Collection.invalidate(); return r; });
  },
  removeByGame(gameId) {
    return api.del(`/collection/by-game/${gameId}`).then((r) => { Collection.invalidate(); return r; });
  },

  async statusFor(gameId) {
    const map = await Collection.myStatusMap();
    return (map && map[gameId]) || null;
  },
  async myStatusMap(opts = {}) {
    const r = await ensure(opts);
    return r.status;
  },
  async myExpansionCountByBaseBggId(opts = {}) {
    const r = await ensure(opts);
    return r.expCount;
  },

  invalidate() {
    bgbCache.delete(NS, COMBINED_KEY);
    bgbCache.clear('profile');
    bgbCache.clear('game.bundle');
  },

  // Prime the cache from the Profile/bootstrap bundle so the first Feed /
  // Profile render pays zero round trips for status pills.
  seedFromBundle(statusMap, expansionCounts) {
    if (!statusMap || !expansionCounts) return;
    bgbCache.setWithTtls(
      NS,
      COMBINED_KEY,
      { status: { ...statusMap }, expCount: { ...expansionCounts } },
      { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS },
    );
  },
};
