// Supabase client singleton. Built only when both env vars are set so the app
// still runs read-only when auth isn't configured (e.g. for a fresh demo
// without Supabase credentials in app/.env).

import { createClient } from '@supabase/supabase-js';
import { secureStorage } from './secureStorage';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

export const isAuthConfigured = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

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
