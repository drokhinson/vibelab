// @ts-check
// API client — BoardgameBuddy native. ALL backend calls go through here; never
// call fetch() directly in a screen. Ported from web/domain/api.js (transport +
// 401 refresh-retry) plus every web/domain/*.js endpoint, consolidated into one
// client organized by domain namespace.

import { supabase } from '../auth/supabase';

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

async function _request(method, path, { body, query, headers, _retried } = {}) {
  const init = { method, headers: { ...(await _authHeader()), ...(headers || {}) } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(_buildUrl(path, query), init);
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
  const res = await fetch(BASE_URL + PREFIX + path, {
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

export const api = {
  raw: { get, post, put, patch, del },
  formatErrorDetail,

  // ── Bootstrap ──────────────────────────────────────────────────────────
  bootstrap: () => get('/bootstrap'),

  // ── Profile / user ─────────────────────────────────────────────────────
  getProfile: () => get('/profile'),
  upsertProfile: (display_name, avatar) => post('/profile', { display_name, avatar }),
  deleteAccount: () => del('/profile'),
  becomeAdmin: (admin_key) => post('/profile/become-admin', { admin_key }),
  searchProfiles: (q) => get('/profiles/search', { q }),
  publicProfile: (userId) => get(`/users/${userId}/profile`),
  profileBundle: (targetUserId, { colPerPage = 12, playsPerPage = 10 } = {}) =>
    get('/profile/bundle', {
      target_user_id: targetUserId || undefined,
      col_per_page: colPerPage,
      plays_per_page: playsPerPage,
    }),

  // ── Stats ──────────────────────────────────────────────────────────────
  myStats: () => get('/users/me/stats'),
  userStats: (userId) => get(`/users/${userId}/stats`),

  // ── Feed ───────────────────────────────────────────────────────────────
  feed: ({ cursor, limit = 20 } = {}) => get('/feed', { cursor, limit }),
  hotGames: ({ windowDays = 7, limit = 10 } = {}) =>
    get('/hot-games', { window_days: windowDays, limit }),
  suggestedBuddies: ({ limit = 10 } = {}) => get('/suggestions/buddies', { limit }),
  featuredFromCollection: ({ daysSince = 60, limit = 5 } = {}) =>
    get('/suggestions/featured-from-collection', { days_since: daysSince, limit }),

  // ── Search ─────────────────────────────────────────────────────────────
  search: (q, { includeBgg = false, limit = 20 } = {}) =>
    get('/search', { q, limit, include_bgg: includeBgg ? 'true' : 'false' }),
  searchBgg: (query, { includeExpansions = true } = {}) =>
    get('/games/search-bgg', { query, include_expansions: includeExpansions ? 'true' : 'false' }),

  // ── Games ──────────────────────────────────────────────────────────────
  games: (params = {}) => get('/games', params),
  game: (id) => get(`/games/${id}`),
  gameBundle: (id, { playsLimit = 5 } = {}) => get(`/games/${id}/bundle`, { plays_limit: playsLimit }),
  recentlyPlayedGames: ({ limit = 6 } = {}) => get('/games/recently-played', { limit }),
  importBgg: (bggId) => post(`/games/import-bgg/${bggId}`),
  lookupByBgg: (bggId) => get(`/games/lookup-by-bgg/${bggId}`),
  gameMechanics: () => get('/games/mechanics'),
  gamePlays: (gameId) => get(`/games/${gameId}/plays`),
  gamePlayCount: (gameId) => get(`/games/${gameId}/play-count`),

  // ── Expansions ─────────────────────────────────────────────────────────
  expansions: (baseId) => get(`/games/${baseId}/expansions`),
  toggleExpansion: (baseId, expansionId, isEnabled) =>
    post(`/games/${baseId}/expansions/${expansionId}/toggle`, { is_enabled: isEnabled }),

  // ── Collection ─────────────────────────────────────────────────────────
  collection: (status) => get('/collection', { status }),
  collectionGrid: (params = {}) => get('/collection/grid', params),
  collectionShelf: (params = {}) => get('/collection/shelf', params),
  addToCollection: (gameId, status) => post('/collection', { game_id: gameId, status }),
  updateCollection: (gameId, status) => patch(`/collection/${gameId}`, { status }),
  removeFromCollection: (gameId) => del(`/collection/${gameId}`),

  // ── Plays ──────────────────────────────────────────────────────────────
  plays: (params = {}) => get('/plays', params),
  play: (id) => get(`/plays/${id}`),
  playFilterOptions: () => get('/plays/filter-options'),
  createPlay: (payload) => post('/plays', payload),
  updatePlay: (id, payload) => put(`/plays/${id}`, payload),
  deletePlay: (id) => del(`/plays/${id}`),
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
  updateSession: (code, gameId) => patch(`/sessions/${code}`, { game_id: gameId || null }),
  updateSessionPhase: (code, phase) => patch(`/sessions/${code}/phase`, { phase }),
  abandonSession: (code) => del(`/sessions/${code}`),
  finalizeSession: (code, payload) => post(`/sessions/${code}/finalize`, payload),

  // ── Chapters (reference guide) ─────────────────────────────────────────
  chapterTypes: () => get('/chapter-types'),
  chapterPool: (gameId, { q, chapterType, expansionIds } = {}) =>
    get(`/games/${gameId}/chapter-pool`, { q, chapter_type: chapterType, expansion_ids: csv(expansionIds) }),
  myChapters: (gameId, { expansionIds } = {}) =>
    get(`/games/${gameId}/my-chapters`, { expansion_ids: csv(expansionIds) }),
  createChapter: (gameId, payload) => post(`/games/${gameId}/chapters`, payload),
  addChapter: (gameId, chapterId) => post(`/games/${gameId}/my-chapters`, { chapter_id: chapterId }),
  removeChapter: (gameId, chapterId) => del(`/games/${gameId}/my-chapters/${chapterId}`),
  updateChapter: (chapterId, payload) => patch(`/chapters/${chapterId}`, payload),
  deleteChapter: (chapterId) => del(`/chapters/${chapterId}`),
  reportChapter: (chapterId, reason) => post(`/chapters/${chapterId}/report`, { reason: reason || null }),

  // ── BGG sync ───────────────────────────────────────────────────────────
  bggStatus: () => get('/bgg/sync/status'),
  bggLink: (username, password) => post('/bgg/link', { username, password }),
  bggUnlink: () => del('/bgg/link'),
  bggSync: () => post('/bgg/sync', {}),
  bggProcessPending: () => post('/bgg/sync/process-pending', {}),

  // ── Admin ──────────────────────────────────────────────────────────────
  adminChapterReports: (status = 'open') => get('/admin/chapter-reports', { status }),
  adminResolveReport: (reportId) => post(`/admin/chapter-reports/${reportId}/resolve`),
};

export const BASE_API_URL = BASE_URL;
export default api;
