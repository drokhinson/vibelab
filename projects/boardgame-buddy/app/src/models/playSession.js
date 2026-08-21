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
