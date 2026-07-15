// src/cache/bootstrap.js — first-paint cache warm-up. Ported from
// web/domain/bootstrap.js. Calls GET /bootstrap once after auth and seeds every
// cache namespace so the app navigates without further network until SWR
// background-refresh kicks in. Returns the raw payload so AppContext can hydrate
// UI state (current_user, feed, collection map).

import { api } from '../api/client';
import { bgbCache } from './index';
import { Collection } from '../domain/collection';

const EXPECTED_BOOTSTRAP_VERSION = 1;

// TTL pairs (fresh, stale) per namespace. hostSeed lists only mutate on play
// finalize or buddy graph edits, both of which invalidate explicitly.
const TTLS = {
  profile: { fresh: 60 * 1000, stale: 5 * 60 * 1000 },
  gameBundle: { fresh: 30 * 60 * 1000, stale: 60 * 60 * 1000 },
  feedFirst: { fresh: 60 * 1000, stale: 10 * 60 * 1000 },
  stats: { fresh: 60 * 1000, stale: 10 * 60 * 1000 },
  hostSeed: { fresh: 24 * 60 * 60 * 1000, stale: 7 * 24 * 60 * 60 * 1000 },
};

function seedCaches(payload) {
  const me = payload.current_user;
  const viewerId = me && me.id;

  if (viewerId && payload.profile_bundle) {
    bgbCache.setWithTtls('profile', viewerId + '|' + viewerId, payload.profile_bundle,
      { freshTtl: TTLS.profile.fresh, staleTtl: TTLS.profile.stale });
  }

  const bundles = payload.game_detail_bundles || {};
  for (const gameId of Object.keys(bundles)) {
    if (!bundles[gameId]) continue;
    bgbCache.setWithTtls('game.bundle', gameId, bundles[gameId],
      { freshTtl: TTLS.gameBundle.fresh, staleTtl: TTLS.gameBundle.stale });
  }

  const stats = payload.profile_bundle && payload.profile_bundle.stats;
  if (viewerId && stats) {
    bgbCache.setWithTtls('stats', viewerId, stats,
      { freshTtl: TTLS.stats.fresh, staleTtl: TTLS.stats.stale });
  }

  if (payload.feed_first_page) {
    bgbCache.setWithTtls('feed', 'first', payload.feed_first_page,
      { freshTtl: TTLS.feedFirst.fresh, staleTtl: TTLS.feedFirst.stale });
  }

  if (Array.isArray(payload.recently_played_games)) {
    bgbCache.setWithTtls('game.recent', 'self', payload.recently_played_games,
      { freshTtl: TTLS.hostSeed.fresh, staleTtl: TTLS.hostSeed.stale });
  }
  if (payload.play_partners) {
    bgbCache.setWithTtls('buddy', 'all', payload.play_partners,
      { freshTtl: TTLS.hostSeed.fresh, staleTtl: TTLS.hostSeed.stale });
  }

  const pb = payload.profile_bundle;
  if (pb && pb.status_map && pb.expansion_counts) {
    Collection.seedFromBundle(pb.status_map, pb.expansion_counts);
  }
}

// Fetch /bootstrap, seed caches, return the payload. Throws on error so the
// caller can fall back to per-domain lazy fetches (e.g. GET /profile).
export async function loadBootstrap() {
  const payload = await api.get('/bootstrap');
  if (!payload || typeof payload !== 'object') throw new Error('bootstrap: empty payload');

  // Server schema bump → wipe cache before seeding the new shape.
  if (payload.bootstrap_version !== EXPECTED_BOOTSTRAP_VERSION) {
    const me = payload.current_user;
    if (me && me.id) {
      await bgbCache.unbindUser();
      await bgbCache.bindUser(me.id);
    }
  }

  seedCaches(payload);
  return payload;
}
