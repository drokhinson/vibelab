// playSession — the host's in-progress play draft. Persisted to AsyncStorage
// (replaces the web's localStorage) so a half-finished session survives an app
// backgrounding; the photo URI stays in-memory. Ported from web/domain/
// play-session.js. Shape:
//   { code, sessionId, hostUserId, phase, game, players, expansionIds,
//     playMode, notes, photo }
//   player: { key, name, user_id, avatar, is_winner, score, round_scores }

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'bgb.activeSession';

// The cascade's ordered phases. PlayFlowScreen indexes into this for the
// pager and the back button, so it lives with the draft rather than in the
// screen — one list, not two that can disagree.
export const PHASES = ['gather', 'play', 'settle'];

export function emptyDraft() {
  return {
    code: null,
    sessionId: null,
    hostUserId: null,
    phase: 'gather',
    game: null,
    players: [],
    expansionIds: [],
    playMode: 'competitive',
    notes: '',
    photo: null, // { uri, name, type } — in-memory only
    // True when the lobby couldn't be opened (offline): phases flip locally
    // and the finished play queues in the outbox.
    offlineTable: false,
  };
}

export async function loadDraft() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return { ...emptyDraft(), ...d, photo: null };
  } catch {
    return null;
  }
}

export async function saveDraft(draft) {
  try {
    // Don't persist the in-memory photo blob.
    const { photo, ...rest } = draft || {};
    await AsyncStorage.setItem(KEY, JSON.stringify(rest));
  } catch {}
}

export async function clearDraft() {
  try { await AsyncStorage.removeItem(KEY); } catch {}
}

/**
 * Build a fresh Gather-phase draft from a finished play row — the "Another
 * Round" path on the Play tab. Native twin of web's
 * PlaySession.seedFromPlayRow.
 *
 * Carries the group and the setup, drops the results: scores, winners and
 * the photo all belong to the game that just ended. `cachedGame` fills in what
 * a play row doesn't carry (rulebook_url, is_expansion, theme_color) when the
 * bundle happens to be warm; the host flow resolves the rest either way.
 *
 * @param {Object} play  PlayResponse
 * @param {Object} [cachedGame]  GameSummary from a warm bundle, if any
 * @returns {Object|null} a draft ready for saveDraft(), or null if unusable
 */
export function draftFromPlayRow(play, cachedGame) {
  if (!play?.game_id) return null;
  const d = emptyDraft();
  d.game = {
    ...(cachedGame || {}),
    id: play.game_id,
    name: play.game_name || cachedGame?.name || '',
    thumbnail_url: play.game_thumbnail || cachedGame?.thumbnail_url || null,
  };
  d.playMode = play.play_mode || 'competitive';
  // Expansion rows on a play carry the expansion GAME's id, which is the same
  // id the Gather toggle list keys on.
  d.expansionIds = (play.expansions || []).map((e) => e.id || e.expansion_game_id).filter(Boolean);
  d.players = (play.players || []).map((p) => ({
    name: p.name,
    user_id: p.user_id || null,
    avatar: p.avatar || null,
    team: '',
    is_winner: false,
    score: null,
    round_scores: [],
  }));
  return d;
}
