// @ts-check
// API client — BoardgameBuddy native. ALL backend calls go through here; never
// call fetch() directly in a screen. Ported from web/domain/api.js (transport +
// 401 refresh-retry) plus every web/domain/*.js endpoint, consolidated into one
// client organized by domain namespace.

import { supabase } from '../auth/supabase';
import * as net from '../offline/net';

const BASE_URL = (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/+$/, '');
const PREFIX = '/api/v1/boardgame_buddy';

// Token getter is injected by AppContext so it reads straight from the Supabase
// client (not React state) — avoids the first-sign-in render race.
let _getToken = async () => null;
export function setAuthTokenGetter(getter) {
  _getToken = typeof getter === 'function' ? getter : async () => null;
}

/**
 * Coerce FastAPI's `detail` (string | {msg} | [{loc,msg}]) into one readable
 * string. Without this, RN renders a 422 body as "[object Object]".
 * @param {any} detail
 * @returns {string}
 */
export function formatErrorDetail(detail) {
  if (detail == null) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (d && d.msg ? d.msg : typeof d === 'string' ? d : JSON.stringify(d)))
      .join('; ');
  }
  if (typeof detail === 'object') return detail.msg || detail.message || JSON.stringify(detail);
  return String(detail);
}

async function _authHeader() {
  try {
    const tok = await _getToken();
    return tok ? { Authorization: 'Bearer ' + tok } : {};
  } catch {
    return {};
  }
}

// Refresh the Supabase access token (recover transparently from a 401 caused
// by a token that expired while the phone slept). Returns true on success.
async function _refreshSession() {
  if (!supabase) return false;
  try {
    let { data } = await supabase.auth.getSession();
    if (data && data.session) return true;
    const r = await supabase.auth.refreshSession();
    return !r.error && !!(r.data && r.data.session);
  } catch {
    return false;
  }
}

function _buildUrl(path, query) {
  let url = BASE_URL + PREFIX + path;
  if (query) {
    const parts = [];
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    if (parts.length) url += (url.includes('?') ? '&' : '?') + parts.join('&');
  }
  return url;
}

// The one place connectivity evidence is recorded. A completed response —
// ANY status — proves the link works, so a 404 or a 500 counts as success
// here; only a fetch rejection is a network failure. That keeps offline/net.js
// and the "error without .status means the network died" convention the rest
// of the app already follows as two views of the same fact, rather than two
// definitions that can disagree.
async function _trackedFetch(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    net.noteFailure();
    throw e;
  }
  net.noteSuccess();
  return res;
}

async function _request(method, path, { body, query, headers, _retried } = {}) {
  const init = { method, headers: { ...(await _authHeader()), ...(headers || {}) } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await _trackedFetch(_buildUrl(path, query), init);
  if (!res.ok) {
    if (res.status === 401 && !_retried && (await _refreshSession())) {
      return _request(method, path, { body, query, headers, _retried: true });
    }
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = formatErrorDetail(j.detail) || j.message || detail;
    } catch {}
    const err = new Error(detail);
    // @ts-ignore — attach status for callers that branch on 404 etc.
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// Multipart upload (play photo). In RN the file part is { uri, name, type }.
async function _upload(path, formData, _retried) {
  const res = await _trackedFetch(BASE_URL + PREFIX + path, {
    method: 'POST',
    headers: await _authHeader(),
    body: formData,
  });
  if (!res.ok) {
    if (res.status === 401 && !_retried && (await _refreshSession())) {
      return _upload(path, formData, true);
    }
    let detail = res.statusText;
    try { detail = formatErrorDetail((await res.json()).detail) || detail; } catch {}
    const err = new Error(detail);
    // @ts-ignore
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const get = (p, query) => _request('GET', p, { query });
const post = (p, body) => _request('POST', p, { body });
const put = (p, body) => _request('PUT', p, { body });
const patch = (p, body) => _request('PATCH', p, { body });
const del = (p) => _request('DELETE', p, {});

function csv(ids) {
  return ids && ids.length ? ids.join(',') : undefined;
}

// Every method here has a call site. A wrapper with no caller is how a route
// that no longer exists stays invisible until it 404s in someone's hands, so
// prune rather than keep "just in case" — and there is deliberately no `raw`
// escape hatch, because a route reachable outside this list can't be audited.
export const api = {
  formatErrorDetail,

  // ── Connectivity ───────────────────────────────────────────────────────
  // Unauthenticated and trivial, so a failure can only mean the link. This is
  // what offline/net.js probes when the user taps "Try again"; every project
  // has one (.claude/rules/backend-python.md).
  health: () => get('/health'),

  // ── Bootstrap ──────────────────────────────────────────────────────────
  bootstrap: () => get('/bootstrap'),
  // Deferred second stage. Building these is an N+1 in SQL and nothing on
  // the first screen reads them, so the server split them out — we pull them
  // after the user has landed. Game Detail falls back to its own fetch.
  bootstrapGameBundles: () => get('/bootstrap/game-bundles'),

  // ── Profile / user ─────────────────────────────────────────────────────
  getProfile: () => get('/profile'),
  upsertProfile: (display_name, avatar) => post('/profile', { display_name, avatar }),
  deleteAccount: () => del('/profile'),
  becomeAdmin: (admin_key) => post('/profile/become-admin', { admin_key }),
  searchProfiles: (q) => get('/profiles/search', { q }),
  publicProfile: (userId) => get(`/users/${userId}/profile`),

  // ── Stats ──────────────────────────────────────────────────────────────
  myStats: () => get('/users/me/stats'),
  userStats: (userId) => get(`/users/${userId}/stats`),

  // ── Feed ───────────────────────────────────────────────────────────────
  // The hot-games / suggested-buddies / featured-from-collection rails are
  // embedded in this response; they have no standalone endpoints.
  feed: ({ cursor, limit = 20 } = {}) => get('/feed', { cursor, limit }),

  // ── Search ─────────────────────────────────────────────────────────────
  // Expansions are excluded from every source by default (migration 041) —
  // they belong to a base game's expansion section, not the game picker.
  search: (q, { includeBgg = false, includeExpansions = false, limit = 20 } = {}) =>
    get('/search', {
      q,
      limit,
      include_bgg: includeBgg ? 'true' : 'false',
      include_expansions: includeExpansions ? 'true' : 'false',
    }),

  // ── Games ──────────────────────────────────────────────────────────────
  // Game Detail reads the bundle, which carries the game, its expansions and
  // its recent plays — hence no plain /games/{id}, /plays or /play-count here.
  gameBundle: (id, { playsLimit = 5 } = {}) => get(`/games/${id}/bundle`, { plays_limit: playsLimit }),
  recentlyPlayedGames: ({ limit = 6 } = {}) => get('/games/recently-played', { limit }),
  // Idempotent: returns the pre-existing row when the bgg_id is already in
  // the catalog, so no lookup-first round trip.
  importBgg: (bggId) => post(`/games/import-bgg/${bggId}`),

  // ── Expansions ─────────────────────────────────────────────────────────
  expansions: (baseId) => get(`/games/${baseId}/expansions`),
  toggleExpansion: (baseId, expansionId, isEnabled) =>
    post(`/games/${baseId}/expansions/${expansionId}/toggle`, { is_enabled: isEnabled }),
  // BGG-linked expansions this base game doesn't have in the catalog yet.
  // Since expansions are hidden from search, importing from here is the only
  // way one enters the catalog.
  availableExpansions: (baseId) => get(`/games/${baseId}/expansions/available`),
  importExpansion: (baseId, bggId) => post(`/games/${baseId}/expansions/import/${bggId}`),

  // ── Collection ─────────────────────────────────────────────────────────
  collection: (status) => get('/collection', { status }),
  collectionGrid: (params = {}) => get('/collection/grid', params),
  addToCollection: (gameId, status) => post('/collection', { game_id: gameId, status }),
  updateCollection: (gameId, status) => patch(`/collection/${gameId}`, { status }),
  removeFromCollection: (gameId) => del(`/collection/${gameId}`),

  // ── Plays ──────────────────────────────────────────────────────────────
  plays: (params = {}) => get('/plays', params),
  play: (id) => get(`/plays/${id}`),
  createPlay: (payload) => post('/plays', payload),
  updatePlay: (id, payload) => put(`/plays/${id}`, payload),
  // Writes just the one column. Attaching through updatePlay instead is a
  // FULL replacement — it deletes and re-inserts every player and expansion
  // row to set a string.
  attachPlayPhoto: (id, photoUrl) => patch(`/plays/${id}/photo`, { photo_url: photoUrl }),
  deletePlay: (id) => del(`/plays/${id}`),
  leavePlay: (id) => post(`/plays/${id}/leave`, {}),
  uploadPlayPhoto: (photo) => {
    const fd = new FormData();
    // RN file part shape.
    // @ts-ignore — RN FormData accepts { uri, name, type }.
    fd.append('file', { uri: photo.uri, name: photo.name || 'play.jpg', type: photo.type || 'image/jpeg' });
    return _upload('/plays/photo', fd);
  },

  // ── Buddies ────────────────────────────────────────────────────────────
  buddies: () => get('/buddies'),
  buddyRequests: () => get('/buddies/requests'),
  sendBuddyRequest: (targetUserId) => post('/buddies/request', { target_user_id: targetUserId }),
  acceptBuddy: (requestId) => post(`/buddies/${requestId}/accept`, {}),
  rejectBuddy: (requestId) => post(`/buddies/${requestId}/reject`, {}),
  unfriend: (edgeId) => del(`/buddies/${edgeId}`),
  playedWith: () => get('/played-with'),
  ghostPlayers: () => get('/ghost-players'),
  linkGhost: (displayName, targetUserId) =>
    post('/ghost-players/link', { display_name: displayName, target_user_id: targetUserId }),
  mergeGhosts: (sourceDisplayName, targetDisplayName) =>
    post('/ghost-players/merge', { source_display_name: sourceDisplayName, target_display_name: targetDisplayName }),

  // ── Sessions (live host/join) ─────────────────────────────────────────
  createSession: (gameId) => post('/sessions', { game_id: gameId || null }),
  joinableSessions: () => get('/sessions/joinable'),
  session: (code) => get(`/sessions/${code}`),
  joinSession: (code, displayName) => post(`/sessions/${code}/join`, { display_name: displayName || null }),
  addParticipant: (code, { userId, displayName }) =>
    post(`/sessions/${code}/participants`, { user_id: userId || null, display_name: displayName }),
  removeParticipant: (code, participantId) => del(`/sessions/${code}/participants/${participantId}`),
  // The scoring grid's columns ARE the roster order, on every surface
  // (migration 056). Gather-only — once Play starts the order is frozen.
  reorderParticipants: (code, participantIds) =>
    put(`/sessions/${code}/participants/order`, { participant_ids: participantIds }),
  updateSession: (code, gameId) => patch(`/sessions/${code}`, { game_id: gameId || null }),
  updateSessionPhase: (code, phase) => patch(`/sessions/${code}/phase`, { phase }),
  finalizeSession: (code, payload) => post(`/sessions/${code}/finalize`, payload),

  // ── Chapters (reference guide) ─────────────────────────────────────────
  chapterTypes: () => get('/chapter-types'),
  chapterPool: (gameId, { q, chapterType, expansionIds } = {}) =>
    get(`/games/${gameId}/chapter-pool`, { q, chapter_type: chapterType, expansion_ids: csv(expansionIds) }),
  myChapters: (gameId, { expansionIds } = {}) =>
    get(`/games/${gameId}/my-chapters`, { expansion_ids: csv(expansionIds) }),
  addChapter: (gameId, chapterId) => post(`/games/${gameId}/my-chapters`, { chapter_id: chapterId }),
  removeChapter: (gameId, chapterId) => del(`/games/${gameId}/my-chapters/${chapterId}`),
  deleteChapter: (chapterId) => del(`/chapters/${chapterId}`),

  // ── BGG sync ───────────────────────────────────────────────────────────
  bggStatus: () => get('/bgg/sync/status'),
  bggLink: (username, password) => post('/bgg/link', { username, password }),
  bggUnlink: () => del('/bgg/link'),
  bggSync: () => post('/bgg/sync', {}),

  // ── Admin ──────────────────────────────────────────────────────────────
  adminChapterReports: (status = 'open') => get('/admin/chapter-reports', { status }),
  adminResolveReport: (reportId) => post(`/admin/chapter-reports/${reportId}/resolve`),
  adminMissingImages: () => get('/games/admin/missing-images'),
  adminRefreshGameImages: (gameId) => post(`/games/admin/${gameId}/refresh-images`),
  adminRefreshAllImages: () => post('/games/refresh-images'),
  adminSetRulebookUrl: (gameId, rulebookUrl) =>
    patch(`/games/admin/${gameId}/rulebook-url`, { rulebook_url: rulebookUrl || null }),
};
export default api;
