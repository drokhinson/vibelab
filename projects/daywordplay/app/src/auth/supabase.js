// Supabase client singleton. Built only when both env vars are set so the app
// still launches when auth isn't configured (a fresh demo without creds).

import { createClient } from '@supabase/supabase-js';
import { secureStorage } from './secureStorage';

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
  // eslint-disable-next-line no-console
  console.warn(
    `[daywordplay/auth] EXPO_PUBLIC_SUPABASE_URL is set but invalid: "${SUPABASE_URL}". ` +
      `Expected something like https://xxx.supabase.co — check for stray quotes, ` +
      `trailing slashes, or whitespace in app/.env.`,
  );
}

export const supabase = isAuthConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: secureStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        flowType: 'pkce',
      },
    })
  : null;
