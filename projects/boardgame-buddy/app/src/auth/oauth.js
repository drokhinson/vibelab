// Google sign-in via Supabase OAuth + a BoardgameBuddy web bridge.
//
// Why a bridge? The vibelab Supabase project is shared across apps, and
// Supabase's OAuth callback rejects non-https `redirectTo` values like
// `exp://...`. Fix: hand Supabase a real https URL on the BGB web app, and
// have that page forward the auth code to the native runtime via a deep link.
//
// The bridge page (web/auth-callback.html) must be deployed on the BGB Vercel
// host and allowlisted in Supabase → Auth → URL Configuration → Redirect URLs.

import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { makeRedirectUri } from 'expo-auth-session';
import { supabase, isAuthConfigured } from './supabase';

WebBrowser.maybeCompleteAuthSession();

const WEB_BRIDGE_URL = (process.env.EXPO_PUBLIC_AUTH_CALLBACK_URL
  || 'https://vibelab-boardgamebuddy.vercel.app/auth-callback.html').replace(/\/+$/, '');

export function getNativeRedirectUri() {
  return makeRedirectUri({ scheme: 'boardgamebuddy', path: 'auth-callback' });
}

export function getSupabaseRedirectUri(nativeUri) {
  const encoded = encodeURIComponent(nativeUri);
  return `${WEB_BRIDGE_URL}?native_url=${encoded}`;
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
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error) throw error;
    url = data?.url;
    if (!url) throw new Error('Supabase returned no OAuth URL');
  } catch (e) {
    return { ok: false, error: e.message || String(e), redirectTo };
  }

  let result;
  try {
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
      error: `Sign-in flow ended unexpectedly (type=${result?.type}).`,
      redirectTo,
    };
  }

  const handled = await handleAuthDeepLink(result.url);
  if (handled.ok) return { ok: true };
  if (handled.ignored) {
    return {
      ok: false,
      error:
        `The bridge URL didn't return an auth code. Most common cause: the ` +
        `auth-callback.html bridge isn't deployed yet on the BGB web host.`,
      redirectTo,
    };
  }
  return { ok: false, error: handled.error || 'Sign-in failed.', redirectTo };
}

export function parseAuthParamsFromUrl(url) {
  if (!url) return {};
  const out = {};
  try {
    const u = new URL(url);
    u.searchParams.forEach((v, k) => { out[k] = v; });
  } catch {
    const queryIdx = url.indexOf('?');
    const hashIdx = url.indexOf('#');
    if (queryIdx >= 0) {
      const queryEnd = hashIdx > queryIdx ? hashIdx : url.length;
      const qs = url.slice(queryIdx + 1, queryEnd);
      new URLSearchParams(qs).forEach((v, k) => { out[k] = v; });
    }
  }
  const hashIdx = url.indexOf('#');
  if (hashIdx >= 0) {
    const hash = url.slice(hashIdx + 1);
    hash.split('#').forEach((chunk) => {
      new URLSearchParams(chunk).forEach((v, k) => { if (out[k] == null) out[k] = v; });
    });
  }
  return out;
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

// Dedup table: WebBrowser result AND the OS deep-link listener can both fire
// for the same code. PKCE verifier is one-shot, so share the in-flight result.
const inflightExchanges = new Map();

function dedupKey(params) {
  if (params.code) return `code:${params.code}`;
  if (params.access_token) return `token:${params.access_token}`;
  return null;
}

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
    // Keep the entry so a late OS listener fire doesn't re-exchange.
  }
}
