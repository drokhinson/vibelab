// Supabase client singleton. Built only when both env vars are set so the app
// still runs read-only when auth isn't configured (e.g. for a fresh demo
// without Supabase credentials in app/.env).

import { createClient } from '@supabase/supabase-js';
import { secureStorage } from './secureStorage';

// dotenv on Windows occasionally preserves wrapping quotes and trailing
// whitespace. A stray trailing slash on the URL also makes Supabase's
// `${url}/auth/v1/...` build invalid paths in some Hermes URL impls. Strip
// all of it once at boot.
function sanitizeUrl(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.replace(/\/+$/, '').trim();
}

function sanitizeKey(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

const SUPABASE_URL = sanitizeUrl(process.env.EXPO_PUBLIC_SUPABASE_URL);
const SUPABASE_ANON_KEY = sanitizeKey(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);

// Validate URL shape upfront so we surface a clear error message instead of
// the cryptic "Invalid path specified in url" Supabase throws on signUp.
function isValidUrl(s) {
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export const isAuthConfigured = !!(SUPABASE_URL && SUPABASE_ANON_KEY && isValidUrl(SUPABASE_URL));

if (process.env.EXPO_PUBLIC_SUPABASE_URL && !isAuthConfigured) {
  // Log once so a misconfigured URL is obvious in the Metro console.
  // eslint-disable-next-line no-console
  console.warn(
    `[sauceboss/auth] EXPO_PUBLIC_SUPABASE_URL is set but invalid: "${SUPABASE_URL}". ` +
      `Expected something like https://xxx.supabase.co — check for stray quotes, ` +
      `trailing slashes, or whitespace in app/.env.`,
  );
}

// When unconfigured, leave the client null and let the UI gracefully hide
// sign-in surfaces.
export const supabase = isAuthConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: secureStorage,
        autoRefreshToken: true,
        persistSession: true,
        // RN doesn't expose a URL bar, so no detection needed.
        detectSessionInUrl: false,
      },
    })
  : null;

