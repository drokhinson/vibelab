// @ts-check
// The one game-search pipeline (GameFinder, Search tab, Gather step, LogPlay
// quick-pick all consume this). Fallthrough:
//   1. OWNED/WISHLIST — instant in-memory fuzzy match over the offline
//      collection store. Works in airplane mode; zero latency.
//   2. BGB — debounced GET /search against the backend catalog.
//   3. BGG — GET /games/search-bgg for games not in the catalog yet; picking
//      one imports it via POST /games/import-bgg/{bggId}.
//
// searchLocal is synchronous; searchRemote returns backend + bgg tiers and
// dedupes anything the local tier already surfaced.

import { api } from '../api/client';
import { collectionGames } from '../offline/collectionStore';

/** Lightweight subsequence-friendly fuzzy score. 0 = no match; higher = better. */
export function fuzzyScore(query, target) {
  const q = query.toLowerCase().trim();
  const t = (target || '').toLowerCase();
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 90 - Math.min(20, t.length - q.length);
  const wordIdx = t.indexOf(' ' + q);
  if (wordIdx >= 0) return 70 - Math.min(20, wordIdx);
  const idx = t.indexOf(q);
  if (idx >= 0) return 55 - Math.min(25, idx);
  // Subsequence: every query char appears in order ("tta" → "Terraforming...").
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const next = t.indexOf(ch, ti);
    if (next === -1) return 0;
    gaps += next - ti;
    ti = next + 1;
  }
  return Math.max(1, 30 - Math.min(25, gaps));
}

/**
 * Tier 1 — synchronous match over the offline collection.
 * @param {string} query
 * @param {{ limit?: number, includeExpansions?: boolean }} [opts]
 */
export function searchLocal(query, { limit = 8, includeExpansions = false } = {}) {
  const q = query.trim();
  if (!q) return [];
  return collectionGames()
    .filter((g) => includeExpansions || !g.is_expansion)
    .map((g) => ({ game: g, score: fuzzyScore(q, g.name) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.game.name.localeCompare(b.game.name))
    .slice(0, limit)
    .map((r) => r.game);
}

/**
 * Tiers 2+3 — backend /search (which itself ranks collection-first) and
 * optionally BGG. Results already shown by the local tier are dropped.
 * Expansions are excluded server-side unless includeExpansions is set, so
 * both tiers agree on what a "game" is in the picker.
 * @param {string} query
 * @param {{ includeBgg?: boolean, includeExpansions?: boolean, limit?: number, localIds?: Set<string> }} [opts]
 * @returns {Promise<{ results: any[], bggResults: any[], bggSearched: boolean }>}
 */
export async function searchRemote(query, { includeBgg = false, includeExpansions = false, limit = 20, localIds } = {}) {
  const q = query.trim();
  if (!q) return { results: [], bggResults: [], bggSearched: false };
  const resp = await api.search(q, { includeBgg, includeExpansions, limit });
  const seen = localIds || new Set();
  const seenBgg = new Set();
  const results = [];
  for (const r of resp?.results || []) {
    const g = r.game || r;
    if (g?.id && seen.has(g.id)) continue;
    if (g?.bgg_id) seenBgg.add(g.bgg_id);
    results.push(r);
  }
  const bggResults = (resp?.bgg_results || []).filter((b) => !seenBgg.has(b.bgg_id));
  return { results, bggResults, bggSearched: !!resp?.bgg_searched };
}

/**
 * Resolve a BGG pick to a catalog game: reuse if already imported, else
 * import. Returns a GameSummary.
 * @param {number} bggId
 */
export async function resolveBggGame(bggId) {
  const existing = await api.lookupByBgg(bggId).catch(() => null);
  if (existing?.id) return existing;
  return api.importBgg(bggId);
}
