// API client — wraps shared/api.js with the native fetch + a token getter that
// reads from the AppContext after sign-in (Phase 2). For Phase 1 the token
// getter returns null so all calls go out unauthenticated.

import { makeApi } from '#shared/api';

// Default to the deployed Railway backend. EXPO_PUBLIC_API_URL in app/.env
// overrides for local dev (e.g. http://localhost:8000 with `uvicorn main:app
// --reload` running). Defaulting to the live URL means a fresh `git clone`
// on a teammate's machine works without any .env setup.
const DEFAULT_API_URL = 'https://vibelab-production-2119.up.railway.app';
const BASE_URL = process.env.EXPO_PUBLIC_API_URL || DEFAULT_API_URL;

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
