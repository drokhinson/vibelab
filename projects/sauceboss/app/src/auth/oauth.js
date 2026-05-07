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
//   - If the redirect URI is NOT in Supabase's allowlist, Supabase silently
//     falls back to the project's "Site URL" — which on the shared vibelab
//     project may be a different app entirely (e.g. boardgame buddy). The
//     diagnostic console.log + the ALLOWLIST_HINT thrown back into authError
//     are there to make this misconfiguration obvious.

import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import { supabase, isAuthConfigured } from './supabase';

WebBrowser.maybeCompleteAuthSession();

export function getRedirectUri() {
  return makeRedirectUri({
    scheme: 'sauceboss',
    path: 'auth-callback',
  });
}

function makeAllowlistHint(redirectTo) {
  return (
    `OAuth landed in the wrong app — Supabase's Site URL fallback kicked in ` +
    `because this redirect URL isn't in the allowlist:\n\n  ${redirectTo}\n\n` +
    `Add it to Supabase → Authentication → URL Configuration → Redirect URLs ` +
    `(wildcards are supported) and try again.`
  );
}

export async function signInWithGoogleOAuth() {
  if (!isAuthConfigured || !supabase) {
    return { ok: false, error: 'Sign-in is not configured for this build.' };
  }

  const redirectTo = getRedirectUri();

  // Print the actual redirect URI we're asking for, in a way the dev console
  // makes easy to spot. If sign-in keeps landing in boardgame buddy (or any
  // other vibelab app), copy this URL into Supabase's Redirect Allowlist.
  // eslint-disable-next-line no-console
  console.log('[sauceboss/oauth] Google sign-in redirect URI →', redirectTo);

  let url;
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        skipBrowserRedirect: true,
      },
    });
    if (error) throw error;
    url = data?.url;
    if (!url) throw new Error('Supabase returned no OAuth URL');
  } catch (e) {
    return { ok: false, error: e.message || String(e), redirectTo };
  }

  let result;
  try {
    result = await WebBrowser.openAuthSessionAsync(url, redirectTo);
  } catch (e) {
    return { ok: false, error: e.message || String(e), redirectTo };
  }

  if (result.type === 'cancel' || result.type === 'dismiss') {
    return { ok: false, cancelled: true, redirectTo };
  }
  if (result.type !== 'success' || !result.url) {
    // Most common cause: Supabase fell back to Site URL because redirectTo
    // wasn't allowlisted, and that Site URL isn't our app. Surface the hint.
    return {
      ok: false,
      error: makeAllowlistHint(redirectTo),
      redirectTo,
    };
  }

  let code = null;
  try {
    code = new URL(result.url).searchParams.get('code');
  } catch {
    const hash = result.url.split('#')[1] || '';
    const params = new URLSearchParams(hash);
    code = params.get('code');
  }
  if (!code) {
    return {
      ok: false,
      error: makeAllowlistHint(redirectTo),
      redirectTo,
    };
  }

  try {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    return { ok: true, redirectTo };
  } catch (e) {
    return { ok: false, error: e.message || String(e), redirectTo };
  }
}
