// Google sign-in via Supabase OAuth + a SauceBoss web bridge.
//
// Why a bridge? The vibelab Supabase project is shared across multiple apps,
// and Supabase's OAuth callback rejects non-https `redirectTo` values like
// `exp://...` even when they're in the allowlist — falling back to the
// project's Site URL (which currently points at boardgame buddy). The fix:
// hand Supabase a real https URL on the SauceBoss web app, and have that
// page forward the auth code to the native runtime via a deep link.
//
// Flow:
//   1. App computes its own deep-link target (`exp://.../--/auth-callback`
//      in Expo Go, `sauceboss://auth-callback` in EAS / production).
//   2. App asks Supabase for an OAuth URL with redirectTo =
//      `https://<web>/auth-callback#native_url=<encoded native URL>`.
//      Supabase honors the https URL because it's a legit allowlisted host.
//   3. After Google auth, Supabase redirects the browser to the bridge with
//      `?code=...&state=...`. The bridge reads `code` from the query and
//      `native_url` from the fragment, then redirects the browser to
//      `<native_url>?code=<code>` — which opens the app.
//   4. The app's Linking listener (App.js) catches the deep link, parses
//      `code`, and calls supabase.auth.exchangeCodeForSession. Session
//      lands; onAuthStateChange in AppContext hydrates the user.
//
// The native_url-in-fragment pattern is necessary because in Expo Go the
// redirect target is whatever LAN/tunnel host Metro is on — it changes per
// session, so we can't bake a single URL into the bridge.

import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { makeRedirectUri } from 'expo-auth-session';
import { supabase, isAuthConfigured } from './supabase';

WebBrowser.maybeCompleteAuthSession();

// Web bridge URL. Override at build time via EXPO_PUBLIC_AUTH_CALLBACK_URL
// if you ever deploy SauceBoss web on a different host.
const WEB_BRIDGE_URL = (process.env.EXPO_PUBLIC_AUTH_CALLBACK_URL
  || 'https://sauceboss-omega.vercel.app/auth-callback.html').replace(/\/+$/, '');

// The deep-link target the bridge will forward to. Expo Go uses the
// `exp://<host>:<port>/--/auth-callback` pattern; EAS / production use
// `sauceboss://auth-callback` via app.json's `scheme`.
export function getNativeRedirectUri() {
  return makeRedirectUri({
    scheme: 'sauceboss',
    path: 'auth-callback',
  });
}

// The URL we hand to Supabase. Has to be https — that's what Supabase will
// accept for OAuth redirects on the shared vibelab project.
export function getSupabaseRedirectUri(nativeUri) {
  const encoded = encodeURIComponent(nativeUri);
  return `${WEB_BRIDGE_URL}#native_url=${encoded}`;
}

function makeAllowlistHint(redirectTo) {
  return (
    `OAuth landed somewhere unexpected — Supabase didn't honor the redirect URL:\n\n  ${redirectTo}\n\n` +
    `Make sure the bridge URL (without the fragment) is in Supabase → Authentication → ` +
    `URL Configuration → Redirect URLs.`
  );
}

export async function signInWithGoogleOAuth() {
  if (!isAuthConfigured || !supabase) {
    return { ok: false, error: 'Sign-in is not configured for this build.' };
  }

  const nativeUri = getNativeRedirectUri();
  const redirectTo = getSupabaseRedirectUri(nativeUri);

  // eslint-disable-next-line no-console
  console.log('[sauceboss/oauth] redirect URLs:', { nativeUri, redirectTo });

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
    // Pass nativeUri (not redirectTo) as the return URL so the WebBrowser
    // closes when the bridge bounces us into the app. The bridge appends
    // ?code=… to nativeUri, so a startsWith check on that base is enough.
    result = await WebBrowser.openAuthSessionAsync(url, nativeUri);
  } catch (e) {
    return { ok: false, error: e.message || String(e), redirectTo };
  }

  if (result.type === 'cancel' || result.type === 'dismiss') {
    return { ok: false, cancelled: true, redirectTo };
  }
  if (result.type !== 'success' || !result.url) {
    return { ok: false, error: makeAllowlistHint(redirectTo), redirectTo };
  }

  const code = parseCodeFromUrl(result.url);
  if (!code) {
    return { ok: false, error: makeAllowlistHint(redirectTo), redirectTo };
  }

  return exchangeCodeForSession(code);
}

// Helper used by both signInWithGoogleOAuth and the Linking deep-link
// listener in App.js. The deep-link path fires when the OS hands the URL
// off to the app *outside* of WebBrowser.openAuthSessionAsync (e.g. when
// the user taps the bridge's "Open SauceBoss" fallback button).
export function parseCodeFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const fromQuery = u.searchParams.get('code');
    if (fromQuery) return fromQuery;
  } catch {
    // ignore — try the hash form below
  }
  const hash = (url.split('#')[1] || '');
  const hashParams = new URLSearchParams(hash);
  return hashParams.get('code');
}

export async function exchangeCodeForSession(code) {
  if (!supabase) return { ok: false, error: 'Sign-in is not configured for this build.' };
  try {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Convenience helper for the Linking listener: takes a deep link URL and,
// if it carries an auth code, exchanges it.
export async function handleAuthDeepLink(url) {
  const code = parseCodeFromUrl(url);
  if (!code) return { ok: false, ignored: true };
  return exchangeCodeForSession(code);
}
