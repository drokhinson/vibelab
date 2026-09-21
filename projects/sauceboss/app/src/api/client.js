// API client — wraps shared/api.js with the native fetch and a token getter.
// AppContext installs the real getter via setAuthTokenGetter once Supabase auth
// is up; until then calls go out unauthenticated.

import { makeApi } from '#shared/api';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000';

let _getToken = () => null;

export function setAuthTokenGetter(getter) {
  _getToken = typeof getter === 'function' ? getter : () => null;
}

export const api = makeApi({
  fetchFn: (url, opts) => fetch(url, opts),
  getAuthToken: async () => {
    try {
      return await _getToken();
    } catch {
      return null;
    }
  },
  baseUrl: BASE_URL,
});

export const BASE_API_URL = BASE_URL;
