// Google sign-in via Supabase OAuth + expo-auth-session.
//
// Flow:
//   1. Ask Supabase for a Google OAuth URL with redirectTo = our redirect URI.
//   2. Open that URL in WebBrowser.openAuthSessionAsync — the browser handles
//      the Google consent screen and redirects back to our app via the
//      `sauceboss://` deep link (or Expo Go's `exp://...` scheme during dev).
//   3. Parse `code` from the redirect URL and call
//      supabase.auth.exchangeCodeForSession(code) to set the session on the
//      JS client. onAuthStateChange in AppContext picks it up from there.
//
// Caveats:
//   - In Expo Go the redirect URI is the Expo proxy scheme (`exp://...`).
//     For OAuth to round-trip cleanly, that URL also has to be allowlisted
//     in Supabase Auth → URL Configuration → Redirect URLs.
//   - In an EAS dev / preview / production build the URI is `sauceboss://`
//     (registered via app.json's `scheme` + `intentFilters`).

import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import { supabase, isAuthConfigured } from './supabase';

// Required for OAuth flow on iOS — completes any pending auth session if the
// app comes back into focus while the browser is open.
WebBrowser.maybeCompleteAuthSession();

export function getRedirectUri() {
  return makeRedirectUri({
    scheme: 'sauceboss',
    path: 'auth-callback',
  });
}

// Returns { ok, error?, cancelled? }. The caller (AppContext.signInWithGoogle)
// surfaces failures into authError. onAuthStateChange handles the success
// path — we don't dispatch session updates from here directly.
export async function signInWithGoogleOAuth() {
  if (!isAuthConfigured || !supabase) {
    return { ok: false, error: 'Sign-in is not configured for this build.' };
  }

  const redirectTo = getRedirectUri();

  let url;
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        // We control the WebBrowser ourselves; let Supabase return the URL
        // instead of trying to navigate the page (which doesn't apply on RN).
        skipBrowserRedirect: true,
      },
    });
    if (error) throw error;
    url = data?.url;
    if (!url) throw new Error('Supabase returned no OAuth URL');
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }

  let result;
  try {
    result = await WebBrowser.openAuthSessionAsync(url, redirectTo);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }

  if (result.type === 'cancel' || result.type === 'dismiss') {
    return { ok: false, cancelled: true };
  }
  if (result.type !== 'success' || !result.url) {
    return { ok: false, error: `Auth flow ended with status: ${result.type}` };
  }

  // Parse `code` from the redirect URL (PKCE) and exchange it for a session.
  let code = null;
  try {
    code = new URL(result.url).searchParams.get('code');
  } catch {
    // Some Supabase URLs ship the code as a hash fragment instead of a query
    // parameter — handle both.
    const hash = result.url.split('#')[1] || '';
    const params = new URLSearchParams(hash);
    code = params.get('code');
  }
  if (!code) {
    return { ok: false, error: 'No auth code returned from Google.' };
  }

  try {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}
