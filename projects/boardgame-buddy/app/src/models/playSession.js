// playSession — the host's in-progress play draft. Persisted to AsyncStorage
// (replaces the web's localStorage) so a half-finished session survives an app
// backgrounding; the photo URI stays in-memory. Ported from web/domain/
// play-session.js. Shape:
//   { code, sessionId, hostUserId, phase, game, players, expansionIds,
//     playMode, notes, photo }
//   player: { key, name, user_id, avatar, is_winner, score, round_scores }

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'bgb.activeSession';

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

// Build the PlayCreate payload the backend expects from a draft + the live
// score map (host-typed + Realtime joiner cells merged).
export function toPlayPayload(draft, { scoresByUser } = {}) {
  const players = (draft.players || []).map((p) => {
    const roundScores = p.round_scores || (p.user_id && scoresByUser ? scoresByUser[p.user_id] : null);
    const total = Array.isArray(roundScores)
      ? roundScores.reduce((s, v) => s + (Number(v) || 0), 0)
      : p.score;
    return {
      name: p.name,
      user_id: p.user_id || null,
      is_winner: !!p.is_winner,
      score: total != null && total !== '' ? Number(total) : null,
      round_scores: Array.isArray(roundScores) ? roundScores : null,
    };
  });
  return {
    game_id: draft.game?.id,
    played_at: new Date().toISOString().slice(0, 10),
    players,
    notes: draft.notes || null,
    photo_url: draft.photoUrl || null,
    expansion_ids: draft.expansionIds || [],
    play_mode: draft.playMode || null,
  };
}
