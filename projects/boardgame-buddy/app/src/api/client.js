// src/api/client.js — Singleton API client for the BoardgameBuddy backend.
//
// Ported from web/domain/api.js. Differences for native:
//   - Base URL comes from EXPO_PUBLIC_API_URL (Railway), not window.APP_CONFIG.
//   - The bearer token is read live from supabase.auth.getSession() rather than
//     a window.session global — this avoids the token-getter race where React
//     state lags the actual refreshed session (build-native gotcha).
//   - 401 → refresh once → retry, so a token that expired while the phone slept
//     never cascades into a forced sign-out.

import { supabase } from '../auth/supabase';

const RAW_BASE = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000';
const API_BASE = String(RAW_BASE).trim().replace(/\/+$/, '');
const PREFIX = '/api/v1/boardgame_buddy';

async function currentAccessToken() {
  if (!supabase) return null;
  try {
    // getSession() auto-refreshes an expired token from the refresh token.
    const { data } = await supabase.auth.getSession();
    return (data && data.session && data.session.access_token) || null;
  } catch {
    return null;
  }
}

async function refreshSession() {
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

function buildUrl(path, query) {
  let url = API_BASE + PREFIX + path;
  if (query) {
    const parts = [];
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
    if (parts.length) url += (url.includes('?') ? '&' : '?') + parts.join('&');
  }
  return url;
}

async function request(method, path, { body, query, headers, raw, _retried } = {}) {
  const token = await currentAccessToken();
  const init = {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(headers || {}),
    },
  };
  if (body !== undefined && !raw) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (raw) {
    init.body = body;
  }

  const res = await fetch(buildUrl(path, query), init);
  if (!res.ok) {
    if (res.status === 401 && !_retried && (await refreshSession())) {
      return request(method, path, { body, query, headers, raw, _retried: true });
    }
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.detail || j.message || detail;
    } catch {}
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

export const api = {
  get: (path, query) => request('GET', path, { query }),
  post: (path, body) => request('POST', path, { body }),
  put: (path, body) => request('PUT', path, { body }),
  patch: (path, body) => request('PATCH', path, { body }),
  del: (path) => request('DELETE', path),

  // For multipart bodies (play photo upload). Caller passes a FormData.
  async upload(path, formData, _retried) {
    const token = await currentAccessToken();
    const res = await fetch(API_BASE + PREFIX + path, {
      method: 'POST',
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      body: formData,
    });
    if (!res.ok) {
      if (res.status === 401 && !_retried && (await refreshSession())) {
        return api.upload(path, formData, true);
      }
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch {}
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return res.json();
  },

  // Fire-and-forget analytics ping — never blocks the UI.
  trackEvent(event) {
    fetch(API_BASE + '/api/v1/analytics/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'boardgame-buddy', event }),
    }).catch(() => {});
  },
};
