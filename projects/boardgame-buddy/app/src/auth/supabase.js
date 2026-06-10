// Supabase client singleton. Built only when both env vars are set so the app
// still runs read-only when auth isn't configured. Mirrors the realtime usage
// the web app does via window.supabaseClient — here it's a real ESM import.

import { createClient } from '@supabase/supabase-js';
import { secureStorage } from './secureStorage';

function sanitize(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

function sanitizeUrl(raw) {
  return sanitize(raw).replace(/\/+$/, '');
}

const SUPABASE_URL = sanitizeUrl(process.env.EXPO_PUBLIC_SUPABASE_URL);
const SUPABASE_ANON_KEY = sanitize(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);

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
    `[bgb/auth] EXPO_PUBLIC_SUPABASE_URL is set but invalid: "${SUPABASE_URL}". ` +
      `Expected https://xxx.supabase.co — check for stray quotes/whitespace in app/.env.`,
  );
}

export const supabase = isAuthConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: secureStorage,
        autoRefreshToken: true,
        persistSession: true,
        // RN has no URL bar to detect a session in.
        detectSessionInUrl: false,
        // PKCE so the OAuth redirect carries ?code=… which the web bridge
        // forwards to the native deep link.
        flowType: 'pkce',
      },
    })
  : null;
