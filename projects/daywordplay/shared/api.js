// Day Word Play API factory — platform-agnostic. Native passes Expo's `fetch`
// and a Supabase token getter. Web uses window.fetch + the live session token.
// Endpoint paths live here once.

const PREFIX = '/api/v1/daywordplay';

function formatErrorDetail(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  if (typeof detail === 'object' && detail.message) return detail.message;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const loc = Array.isArray(d?.loc) ? d.loc.filter((p) => p !== 'body').join('.') : '';
        const msg = d?.msg || d?.message || JSON.stringify(d);
        return loc ? `${loc}: ${msg}` : msg;
      })
      .join('; ');
  }
  try { return JSON.stringify(detail); } catch { return String(detail); }
}

export function makeApi({ fetchFn, getAuthToken, baseUrl }) {
  const _fetch = fetchFn || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  if (!_fetch) throw new Error('makeApi requires a fetchFn');
  const _getToken = getAuthToken || (() => null);
  const base = (baseUrl || '').replace(/\/$/, '');

  async function call(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const token = await _getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let body = opts.body;
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const url = `${base}${PREFIX}${path}`;
    const res = await _fetch(url, { ...opts, headers, body });
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!res.ok) {
      const detail = data ? formatErrorDetail(data.detail) : '';
      const msg = detail ? `${res.status} ${detail}` : `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    // ── Health ──
    health: () => call('/health'),

    // ── Profile ──
    getProfile: () => call('/profile'),
    upsertProfile: (displayName, avatarUrl) => call('/profile', {
      method: 'POST',
      body: avatarUrl ? { display_name: displayName, avatar_url: avatarUrl } : { display_name: displayName },
    }),
    deleteProfile: () => call('/profile', { method: 'DELETE' }),
    becomeAdmin: (adminKey) => call('/profile/become-admin', { method: 'POST', body: { admin_key: adminKey } }),

    // ── Groups ──
    searchGroups: async (q) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      const data = await call(`/groups${params.toString() ? '?' + params.toString() : ''}`);
      return data?.groups || [];
    },
    getMyGroups: async () => {
      const data = await call('/groups/mine');
      return data?.groups || [];
    },
    createGroup: async (name) => {
      const data = await call('/groups', { method: 'POST', body: { name } });
      return data?.group || data;
    },
    joinGroupByCode: async (code) => {
      const data = await call('/groups/join', { method: 'POST', body: { code } });
      return data?.group || data;
    },
    requestJoin: (groupId) => call(`/groups/${encodeURIComponent(groupId)}/request-join`, { method: 'POST' }),
    getGroup: (groupId) => call(`/groups/${encodeURIComponent(groupId)}`),
    getLeaderboard: (groupId) => call(`/groups/${encodeURIComponent(groupId)}/leaderboard`),
    leaveGroup: (groupId) => call(`/groups/${encodeURIComponent(groupId)}/leave`, { method: 'DELETE' }),
    getJoinRequests: async (groupId) => {
      const data = await call(`/groups/${encodeURIComponent(groupId)}/join-requests`);
      return data?.requests || [];
    },
    respondJoinRequest: (groupId, requestId, action) => call(
      `/groups/${encodeURIComponent(groupId)}/join-requests/${encodeURIComponent(requestId)}`,
      { method: 'POST', body: { action } },
    ),

    // ── Words / Sentences / Votes ──
    getToday: (groupId) => call(`/groups/${encodeURIComponent(groupId)}/today`),
    submitSentence: (groupId, sentence) => call(
      `/groups/${encodeURIComponent(groupId)}/sentences`,
      { method: 'POST', body: { sentence } },
    ),
    getReusableSentences: async (groupId) => {
      const data = await call(`/groups/${encodeURIComponent(groupId)}/today/reusable-sentences`);
      return data?.reusable_sentences || [];
    },
    getYesterday: (groupId) => call(`/groups/${encodeURIComponent(groupId)}/yesterday`),
    getVoteCounts: (groupId) => call(`/groups/${encodeURIComponent(groupId)}/vote-counts`),
    voteSentence: (sentenceId) => call(`/sentences/${encodeURIComponent(sentenceId)}/vote`, { method: 'POST' }),

    // ── Bookmarks / Words ──
    getBookmarks: async () => {
      const data = await call('/words/bookmarks');
      return data?.words || data?.bookmarks || [];
    },
    bookmarkWord: (wordId) => call(`/words/${encodeURIComponent(wordId)}/bookmark`, { method: 'POST' }),
    unbookmarkWord: (wordId) => call(`/words/${encodeURIComponent(wordId)}/bookmark`, { method: 'DELETE' }),
    getAllWords: async () => {
      const data = await call('/words/all');
      return data?.words || [];
    },
    getPlayedWords: async () => {
      const data = await call('/words/played');
      return data?.words || [];
    },
    getWordHistory: async () => {
      const data = await call('/words/history');
      return data?.words || data?.history || [];
    },
    proposeWord: (payload) => call('/words/propose', { method: 'POST', body: payload }),

    // ── Admin (uses admin key — passed via getAuthToken or via explicit header) ──
    adminListGroups: async () => {
      const data = await call('/admin/groups');
      return data?.groups || [];
    },
    adminDeleteGroup: (groupId) => call(`/admin/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' }),
    adminListProposals: async () => {
      const data = await call('/admin/proposed-words');
      return data?.proposals || [];
    },
    adminApproveProposal: (proposalId) => call(`/admin/proposed-words/${encodeURIComponent(proposalId)}/approve`, { method: 'POST' }),
    adminRejectProposal: (proposalId) => call(`/admin/proposed-words/${encodeURIComponent(proposalId)}/reject`, { method: 'POST' }),
    adminAddWord: (payload) => call('/admin/words', { method: 'POST', body: payload }),
  };
}
