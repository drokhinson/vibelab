// src/domain/play.js — Logged play. Ported from web/domain/play.js.
// Any play mutation can shift feed, stats, game bundles, and buddy seeds, so
// we bust those cache namespaces directly (no cross-module deps).

import { api } from '../api/client';
import { bgbCache } from '../cache';

function invalidatePlayDeps() {
  bgbCache.delete('feed', 'first');
  bgbCache.clear('stats');
  bgbCache.clear('game.bundle');
  bgbCache.delete('buddy', 'all');
  bgbCache.clear('profile');
  bgbCache.delete('game.recent', 'self');
}

export const Play = {
  list({ gameId, buddyId, search, userId, page = 1, perPage = 20 } = {}) {
    return api.get('/plays', {
      game_id: gameId,
      buddy_id: buddyId,
      user_id: userId || undefined,
      search: search || undefined,
      page,
      per_page: perPage,
    });
  },

  get(id) { return api.get(`/plays/${id}`); },

  create(payload) {
    return api.post('/plays', payload).then((r) => { invalidatePlayDeps(); return r; });
  },
  update(id, payload) {
    return api.put(`/plays/${id}`, payload).then((r) => { invalidatePlayDeps(); return r; });
  },
  remove(id) {
    return api.del(`/plays/${id}`).then((r) => { invalidatePlayDeps(); return r; });
  },

  invalidateDeps: invalidatePlayDeps,
};
