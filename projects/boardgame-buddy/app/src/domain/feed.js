// src/domain/feed.js — Feed page assembler. Ported from web/domain/feed.js.
// First page is SWR-cached; cursor pages bypass the cache (one-shot windows).

import { api } from '../api/client';
import { bgbCache } from '../cache';

const NS = 'feed';
const FIRST_KEY = 'first';
const FRESH_TTL_MS = 60 * 1000; // feed should feel live
const STALE_TTL_MS = 10 * 60 * 1000; // serve while refreshing

export const Feed = {
  fetchPage({ cursor } = {}) {
    if (cursor) return api.get('/feed', { cursor, limit: 20 });
    return bgbCache.swr(
      NS,
      FIRST_KEY,
      () => api.get('/feed', { limit: 20 }),
      { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS },
    );
  },

  refreshFirstPage() {
    bgbCache.delete(NS, FIRST_KEY);
    return Feed.fetchPage({});
  },

  // Optimistically prepend a freshly-logged play to the cached first page so
  // the Feed paints it instantly when the user returns from the Log flow.
  prependPlay(playCard) {
    if (!playCard) return;
    const cached = bgbCache.get(NS, FIRST_KEY);
    if (!cached || !Array.isArray(cached.cards)) return;
    const next = { ...cached, cards: [playCard, ...cached.cards] };
    bgbCache.setWithTtls(NS, FIRST_KEY, next, { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS });
  },
};
