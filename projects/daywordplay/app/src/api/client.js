// Wraps shared/api with Expo's fetch + a Supabase token getter that reads
// directly from supabase.auth.getSession(). Reading from the Supabase client
// (not from React state) avoids the first-sign-in render race where the
// React `session` lags one frame behind the persisted session.

import { makeApi } from '#shared/api';
import { supabase, isAuthConfigured } from '../auth/supabase';

const BASE_URL = (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/+$/, '');

export const api = makeApi({
  fetchFn: (url, opts) => fetch(url, opts),
  getAuthToken: async () => {
    if (!isAuthConfigured || !supabase) return null;
    try {
      const { data } = await supabase.auth.getSession();
      return data?.session?.access_token || null;
    } catch {
      return null;
    }
  },
  baseUrl: BASE_URL,
});

// Admin endpoints take a separate bearer (the ADMIN_API_KEY). We build a
// second client that yields that key as the token instead of the Supabase JWT.
let _adminKey = null;
export function setAdminKey(key) { _adminKey = key || null; }
export function getAdminKey() { return _adminKey; }

export const adminApi = makeApi({
  fetchFn: (url, opts) => fetch(url, opts),
  getAuthToken: async () => _adminKey,
  baseUrl: BASE_URL,
});

export const BASE_API_URL = BASE_URL;
