// playSave — builds the PlayCreate payload from a finished draft and runs the
// save-then-photo sequence (mirrors web play-flow-view._save): persist the
// play first so a flaky upload can never lose the record, then attach the
// photo best-effort via upload + PUT.

import api from '../../api/client';
import { parseRoundScore } from '../../domain/scoring';

export function buildPlayPayload(draft, { rounds, resolvedScore }) {
  const players = draft.players.map((p) => {
    const rs = rounds > 0 ? Array.from({ length: rounds }, (_, r) => resolvedScore(p, r)) : null;
    const total = rs ? rs.reduce((s, v) => s + (Number(v) || 0), 0) : parseRoundScore(p.score);
    return {
      name: p.name,
      user_id: p.user_id || null,
      is_winner: !!p.is_winner,
      score: total != null ? Number(total) : null,
      round_scores: rounds > 1 ? rs : null,
    };
  });
  return {
    game_id: draft.game.id,
    played_at: draft.playedAt || new Date().toISOString().slice(0, 10),
    players,
    notes: draft.notes || null,
    photo_url: null,
    expansion_ids: draft.expansionIds || [],
    play_mode: draft.playMode || null,
  };
}

/**
 * @returns {Promise<{ok: boolean, error?: string, playId?: string|null, photoFailed?: boolean}>}
 */
export async function savePlay(draft, lobbyCode, { rounds, resolvedScore }) {
  const payload = buildPlayPayload(draft, { rounds, resolvedScore });
  let saved;
  try {
    saved = lobbyCode ? await api.finalizeSession(lobbyCode, payload) : await api.createPlay(payload);
  } catch (e) {
    return { ok: false, error: e.message || 'Failed to save' };
  }
  const playId = saved?.id || saved?.play_id || saved?.play?.id || null;

  let photoFailed = false;
  if (draft.photo) {
    try {
      const resp = await api.uploadPlayPhoto(draft.photo);
      if (resp?.photo_url && playId) {
        const { game_id, ...rest } = payload;
        await api.updatePlay(playId, { ...rest, photo_url: resp.photo_url });
      } else {
        photoFailed = true;
      }
    } catch {
      photoFailed = true;
    }
  }
  return { ok: true, playId, photoFailed };
}
