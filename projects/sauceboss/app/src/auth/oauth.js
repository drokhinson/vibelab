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
// accept for OAuth redirects on the shared vibelab project. native_url goes
// in the query string so Supabase's `URL.searchParams.set('code', …)` can
// append cleanly. (Originally we used a `#native_url=…` fragment, but
// Supabase's redirect-URL builder doesn't merge query params into URLs
// with existing fragments — `?code=xxx` got swallowed and the bridge
// landed without any auth params.)
export function getSupabaseRedirectUri(nativeUri) {
  const encoded = encodeURIComponent(nativeUri);
  return `${WEB_BRIDGE_URL}?native_url=${encoded}`;
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
    return {
      ok: false,
      error: `Sign-in flow ended unexpectedly (type=${result?.type}). ` +
        `If this happens repeatedly, open the bridge URL in a regular ` +
        `browser to confirm it's deployed:\n\n` +
        `https://sauceboss-omega.vercel.app/auth-callback.html`,
      redirectTo,
    };
  }

  const handled = await handleAuthDeepLink(result.url);
  if (handled.ok) return { ok: true };
  if (handled.ignored) {
    // Bridge ran (we got a URL back) but didn't include a code or tokens.
    // That means the bridge's JS didn't reach the redirect step — most
    // commonly because the bridge HTML isn't actually deployed yet (Vercel
    // returned a 404 page that doesn't contain our script).
    return {
      ok: false,
      error:
        `The bridge URL didn't return an auth code or tokens.\n\n` +
        `Returned URL:\n  ${result.url}\n\n` +
        `Most common cause: the auth-callback.html bridge isn't deployed ` +
        `yet on Vercel — merge the feature branch to main and wait for ` +
        `Vercel to redeploy. Verify by opening the bridge URL in a normal ` +
        `browser; you should see "No auth response in URL" rather than 404.`,
      redirectTo,
    };
  }
  return {
    ok: false,
    error: handled.error || 'Sign-in failed.',
    redirectTo,
  };
}

// Helper used by both signInWithGoogleOAuth and the Linking deep-link
// listener in App.js. The deep-link path fires when the OS hands the URL
// off to the app *outside* of WebBrowser.openAuthSessionAsync (e.g. when
// the user taps the bridge's "Open SauceBoss" fallback button).
//
// Returns the auth params extracted from the URL, regardless of whether
// the bridge forwarded a PKCE `code` or implicit-flow tokens.
export function parseAuthParamsFromUrl(url) {
  if (!url) return {};
  const out = {};
  // 1. Query string (PKCE: `?code=…`).
  try {
    const u = new URL(url);
    u.searchParams.forEach((v, k) => { out[k] = v; });
  } catch {
    // Fall through — the URL polyfill mostly handles `exp://` but be defensive.
    const queryIdx = url.indexOf('?');
    const hashIdx = url.indexOf('#');
    if (queryIdx >= 0) {
      const queryEnd = hashIdx > queryIdx ? hashIdx : url.length;
      const qs = url.slice(queryIdx + 1, queryEnd);
      new URLSearchParams(qs).forEach((v, k) => { out[k] = v; });
    }
  }
  // 2. Fragment (implicit: `#access_token=…`).
  const hashIdx = url.indexOf('#');
  if (hashIdx >= 0) {
    const hash = url.slice(hashIdx + 1);
    hash.split('#').forEach((chunk) => {
      new URLSearchParams(chunk).forEach((v, k) => {
        if (out[k] == null) out[k] = v;
      });
    });
  }
  return out;
}

// Backwards-compat shim — older callers expect just the code.
export function parseCodeFromUrl(url) {
  return parseAuthParamsFromUrl(url).code || null;
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

async function setSessionFromTokens(accessToken, refreshToken) {
  if (!supabase) return { ok: false, error: 'Sign-in is not configured for this build.' };
  try {
    const { error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) throw error;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Dedup table: when both WebBrowser.openAuthSessionAsync and the OS-level
// deep-link listener fire for the same `?code=…` URL, only one of them can
// successfully exchange the code — the second one fails with "PKCE code
// verifier not found in storage" because the verifier is one-shot. Track
// promises by their auth artifact so concurrent callers share the result.
const inflightExchanges = new Map();

function dedupKey(params) {
  if (params.code) return `code:${params.code}`;
  if (params.access_token) return `token:${params.access_token}`;
  return null;
}

// Convenience helper for the Linking listener: takes a deep link URL and,
// if it carries auth artifacts (code OR tokens), completes the handshake.
// Concurrent calls with the same code/token return the same in-flight
// promise; the second caller doesn't re-issue the request.
export async function handleAuthDeepLink(url) {
  const params = parseAuthParamsFromUrl(url);
  const key = dedupKey(params);
  if (!key) return { ok: false, ignored: true };

  const existing = inflightExchanges.get(key);
  if (existing) return existing;

  const promise = (async () => {
    if (params.code) return exchangeCodeForSession(params.code);
    return setSessionFromTokens(params.access_token, params.refresh_token);
  })();
  inflightExchanges.set(key, promise);

  try {
    return await promise;
  } finally {
    // Keep the entry around so the OS firing the listener after we've
    // already settled doesn't trigger a re-exchange. Bounded growth in
    // practice (one entry per OAuth attempt per app session); not worth
    // a cleanup pass.
  }
}
