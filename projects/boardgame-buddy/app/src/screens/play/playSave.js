// playSave — builds the PlayCreate payload from a finished draft and runs the
// save (mirrors web play-flow-view._runSave).
//
// Two round trips on the blocking path:
//   1. the photo upload starts FIRST and is not awaited — on mobile upstream
//      the bytes are the largest chunk of wall clock and nothing about them
//      has to wait on the play row, only the attach does;
//   2. the create/finalize is awaited, and the caller unblocks the moment it
//      lands — not when the photo does.
// The attach (`PATCH /plays/{id}/photo`, one column) then runs in the
// background. Attaching through `PUT /plays/{id}` instead would full-replace
// every player and expansion row to write one string.
//
// A NETWORK failure (error without .status) never loses the play — it lands
// in the offline outbox and uploads on the next flush; only server rejections
// surface as errors.

import api from '../../api/client';
import { parseRoundScore } from '../../domain/scoring';
import { normalizePlayMode } from '../../domain/playMode';
import { enqueuePlay, persistOutboxPhoto } from '../../offline/playOutbox';

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
    // Normalized, not passed through: PlayCreate validates against the
    // PlayMode enum, so an off-vocabulary string is a 422 on an otherwise
    // finished play.
    play_mode: normalizePlayMode(draft.playMode),
  };
}

/**
 * Land an already-in-flight photo upload on the saved play. Best-effort: the
 * play is already safe, so a failure here is a warning, never an error.
 * @returns {Promise<boolean>} true when the photo made it
 */
export async function attachPhoto(uploadPromise, playId) {
  if (!uploadPromise || !playId) return false;
  try {
    const resp = await uploadPromise;
    if (!resp?.photo_url) return false;
    await api.attachPlayPhoto(playId, resp.photo_url);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Object} draft
 * @param {string|null} lobbyCode
 * @param {{rounds: number, resolvedScore: Function, snap?: Object,
 *          userId?: string|null}} opts
 *   `snap` carries the memoized upload promise across a Retry so the photo
 *   bytes aren't pushed twice. `userId` stamps the outbox entry on the queued
 *   path so only its owner ever flushes it.
 * @returns {Promise<{ok: boolean, error?: string, playId?: string|null,
 *                    uploadPromise?: Promise<any>|null, queued?: boolean}>}
 */
export async function savePlay(draft, lobbyCode, { rounds, resolvedScore, snap, userId }) {
  const payload = buildPlayPayload(draft, { rounds, resolvedScore });

  // Start the upload alongside the save rather than after it. Cached on the
  // snapshot so a Retry re-uses bytes already uploaded; cleared on failure so
  // a Retry does get a fresh attempt.
  const carrier = snap || {};
  if (draft.photo && !carrier.uploadPromise) {
    carrier.uploadPromise = api.uploadPlayPhoto(draft.photo).catch(() => {
      carrier.uploadPromise = null;
      return null;
    });
  }
  const uploadPromise = carrier.uploadPromise || null;

  let saved;
  try {
    saved = lobbyCode ? await api.finalizeSession(lobbyCode, payload) : await api.createPlay(payload);
  } catch (e) {
    if (e && e.status != null) {
      return { ok: false, error: e.message || 'Failed to save' };
    }
    // Network failure — queue for the next online flush instead of losing
    // the record. The photo temp file is copied to a stable dir first.
    const localId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const photoUri = draft.photo ? await persistOutboxPhoto(draft.photo, localId) : null;
    const winner = draft.players.find((p) => p.is_winner) || null;
    await enqueuePlay({
      payload,
      // Whose play this is. Without it the flush can't tell one account's
      // queue from another's on a shared device.
      userId: userId || null,
      code: lobbyCode || null,
      photoUri,
      gameSnapshot: draft.game
        ? {
            id: draft.game.id,
            name: draft.game.name,
            thumbnail_url: draft.game.thumbnail_url || null,
            theme_color: draft.game.theme_color || null,
          }
        : null,
      winnerName: winner ? winner.name : null,
    });
    return { ok: true, queued: true, playId: null, uploadPromise: null };
  }
  const playId = saved?.id || saved?.play_id || saved?.play?.id || null;
  // Unblock here, on the play landing — the photo attaches in the background
  // via attachPhoto(). Returning the promise lets the caller warn on the
  // still-up wrap-up card if it never makes it.
  return { ok: true, playId, uploadPromise };
}
