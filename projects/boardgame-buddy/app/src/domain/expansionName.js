// @ts-check
// Expansion label helpers.
//
// Mirrors web/helpers.js `stripBaseGameName` and the backend's
// `_strip_base_prefix` (shared-backend/routes/boardgame_buddy/
// expansion_routes.py) — keep the three in sync.

/** Separators BGG uses between a base game's name and the expansion's own:
 *  "Catan: Cities & Knights", "Carcassonne – Inns & Cathedrals",
 *  "Azul, Crystal Mosaic". */
const SEPARATORS = '[:\\-–—,]';

/**
 * Drop a leading base-game name from an expansion's name, for surfaces where
 * the base game is already the surrounding context — a game page's expansion
 * list, the host's Gather picker, a play's expansion chips.
 * "Carcassonne: Abbey & Mayor" reads as "Abbey & Mayor" there.
 *
 * Display only: the stored name is untouched, so the expansion's own detail
 * page, the collection grid, search and the feed still show it in full.
 * Falls back to the original when the base name isn't a prefix, or when
 * stripping it would leave nothing behind.
 *
 * @param {string} name
 * @param {string} [baseName]
 * @returns {string}
 */
export function stripBaseGameName(name, baseName) {
  const raw = String(name ?? '').trim();
  const base = String(baseName ?? '').trim();
  if (!raw || !base) return raw;
  // Escape the base name — real titles carry regex metacharacters
  // ("7 Wonders (Duel)", "Brass: Birmingham").
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = raw.replace(new RegExp(`^${escaped}\\s*${SEPARATORS}\\s*`, 'i'), '').trim();
  return stripped || raw;
}

/**
 * Case-insensitive substring match against BOTH the displayed label and the
 * stored/full name — the base game's name is stripped from what's shown, so
 * a user who types it would otherwise get nothing. Used by the Gather picker
 * filter and the import sheet.
 *
 * @param {string} q
 * @param {...(string|null|undefined)} candidates
 */
export function matchesExpansionQuery(q, ...candidates) {
  const needle = String(q ?? '').trim().toLowerCase();
  if (!needle) return true;
  return candidates.some((c) => String(c ?? '').toLowerCase().includes(needle));
}

/**
 * Insert a freshly imported expansion into a rendered list, keeping the
 * name order the bundle RPC and GET /games/{id}/expansions both use. The
 * import endpoint answers with the finished ExpansionListItem, so the row
 * can go up immediately instead of waiting on a refetch.
 * @param {Array<Object>} list
 * @param {Object} expansion
 */
export function insertExpansion(list, expansion) {
  const rows = Array.isArray(list) ? list : [];
  if (!expansion || !expansion.expansion_game_id) return rows;
  if (rows.some((e) => e.expansion_game_id === expansion.expansion_game_id)) return rows;
  return [...rows, expansion].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}
