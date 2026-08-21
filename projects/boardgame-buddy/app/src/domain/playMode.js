// @ts-check
// The scoring-style vocabulary. Mirrors the backend PlayMode StrEnum
// (shared-backend/routes/boardgame_buddy/constants.py) and the
// boardgamebuddy_games.play_mode CHECK constraint — these three strings are
// the only legal values, and a play POSTed with anything else is a 422.
//
// Co-op is 'coop'. It is NOT 'cooperative': that spelling reads naturally,
// never round-trips, and silently disables every co-op branch it guards.
// Compare through isCoop() rather than against a literal so the two can't
// drift apart again.

/** @typedef {'competitive'|'coop'|'team'} PlayModeValue */

/** @type {PlayModeValue[]} */
export const PLAY_MODES = ['competitive', 'coop', 'team'];

/** @type {Record<PlayModeValue, string>} */
export const PLAY_MODE_LABELS = {
  competitive: 'Competitive',
  coop: 'Co-op',
  team: 'Teams',
};

/**
 * True for the all-win-or-all-lose scoring style.
 * @param {string|null|undefined} mode
 */
export function isCoop(mode) {
  return normalizePlayMode(mode) === 'coop';
}

/**
 * Coerce any inbound value to a legal mode. Absent → 'competitive' (the
 * backend's own default); the legacy 'cooperative' spelling maps to 'coop' so
 * a draft persisted before this module existed still scores correctly.
 * @param {string|null|undefined} mode
 * @returns {PlayModeValue}
 */
export function normalizePlayMode(mode) {
  if (mode === 'cooperative') return 'coop';
  return PLAY_MODES.includes(/** @type {any} */ (mode)) ? /** @type {any} */ (mode) : 'competitive';
}
