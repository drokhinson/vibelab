// auth.js — Supabase Auth wiring (pattern: sauceboss/web/auth.js, simplified).
// Boot: initSupabase() restores the session (incl. OAuth redirect params),
// awaitInitialAuth() resolves once the session state is known (3s safety cap).
'use strict';

let supabaseClient = null;
let session = null;
let currentUser = null; // { user_id, display_name, username, is_admin, categories }

let _initialAuthResolve = null;
const _initialAuthReady = new Promise((resolve) => { _initialAuthResolve = resolve; });
let _initialAuthSettled = false;
let _profileLoadInFlight = false;

function awaitInitialAuth() { return _initialAuthReady; }

function _resolveInitialAuth() {
  if (_initialAuthSettled) return;
  _initialAuthSettled = true;
  _initialAuthResolve();
}

function getAuthToken() { return session?.access_token || null; }

async function loadProfile() {
  // Backend auth confirmation — auto-creates the profile row on first login
  // and returns the category option set the UI needs everywhere. Runs in the
  // background off the session (see onAuthStateChange), so guard against
  // overlapping calls when several auth events land in quick succession. A
  // failed load leaves currentUser null so a later event can retry.
  if (_profileLoadInFlight || currentUser) return;
  _profileLoadInFlight = true;
  try {
    currentUser = await window.api.me();
    window.store.set('user', currentUser);
    window.store.set('categories', currentUser.categories || []);
  } catch (err) {
    // A valid Supabase session exists but the backend profile call failed
    // (server unreachable / CORS / 5xx). Auth still succeeded (we route off
    // the session, not the profile), so surface the hiccup instead of only
    // logging it — otherwise the header/user-gated UI silently stays empty.
    console.warn('[travel-scrapbook] /me failed:', err);
    if (session) {
      const detail = err?.message || 'the server could not be reached';
      toast(`Signed in, but couldn't load your profile — ${detail}`, { error: true });
    }
  } finally {
    _profileLoadInFlight = false;
  }
}

function initSupabase() {
  const cfg = window.APP_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
    console.warn('[travel-scrapbook] Supabase not configured; sign-in disabled.');
    _resolveInitialAuth();
    return;
  }
  if (!window.supabase?.createClient) {
    console.error('[travel-scrapbook] Supabase JS client missing — check the CDN script tag.');
    _resolveInitialAuth();
    return;
  }
  // Pin the PKCE flow explicitly so the OAuth exchange is deterministic
  // regardless of the floating @supabase/supabase-js@2 CDN pin. persistSession
  // keeps the session + code_verifier in localStorage across the redirect.
  supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
  });

  // Hard cap so a misbehaving auth subscription can't strand the splash.
  setTimeout(_resolveInitialAuth, 3000);

  supabaseClient.auth.onAuthStateChange((event, sess) => {
    session = sess;
    if (sess) {
      // A restored session already means the visitor is authenticated — the
      // /me call only enriches their profile. Drop the splash on the local
      // session immediately and load the profile in the BACKGROUND. Blocking
      // the splash on /me strands boot behind a network round-trip: when the
      // Railway backend is cold-starting (>3s) the 3s cap fires with `user`
      // still null, so a signed-in visitor refreshing a /trip/:id deep link
      // gets bounced off their trip to /login. Route off the session instead.
      window.store.set('authed', true);
      _resolveInitialAuth();
      loadProfile();
      return;
    }
    if (event === 'SIGNED_OUT') {
      currentUser = null;
      window.tsCache?.clear(); // never serve one account's data to the next
      window.store.set('authed', false);
      window.store.set('user', null);
      _resolveInitialAuth();
      return;
    }
    // No session yet. If the URL carries OAuth params, a SIGNED_IN event
    // follows once the PKCE exchange completes — wait for it (the 3s cap is
    // the safety net). Otherwise this is an anonymous visitor.
    const hasAuthParams = window.location.search.includes('code=') ||
      window.location.hash.includes('access_token=');
    if (!hasAuthParams) { window.store.set('authed', false); _resolveInitialAuth(); }
  });

  // Kick session restoration directly off getSession()'s own result instead
  // of only reacting to !session — onAuthStateChange firing for a restored
  // session is a separate async path on the same client with no guarantee
  // it lands (version/timing dependent), which previously left a valid
  // session unresolved until the 3s cap, with `authed` never set true.
  supabaseClient.auth.getSession().then(({ data }) => {
    if (data?.session) {
      session = data.session;
      window.store.set('authed', true);
      _resolveInitialAuth();
      loadProfile();
      return;
    }
    const hasAuthParams = window.location.search.includes('code=') ||
      window.location.hash.includes('access_token=');
    if (!hasAuthParams) { window.store.set('authed', false); _resolveInitialAuth(); }
  }).catch(() => _resolveInitialAuth());
}

async function handleOAuthSignIn(provider) {
  if (!supabaseClient) { toast('Sign-in is not configured', { error: true }); return; }
  // Return straight to the current page (matching sauceboss/daywordplay) so
  // supabase-js completes the PKCE exchange in a single load — no intermediate
  // callback hop. pathname preserves /scrap, and scrap-popup-view restores the
  // scrap target from its localStorage stash after the round-trip.
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await supabaseClient.auth.signInWithOAuth({ provider, options: { redirectTo } });
  if (error) toast(error.message, { error: true });
}

async function handleEmailAuth(mode, email, password) {
  if (!supabaseClient) throw new Error('Sign-in is not configured');
  if (mode === 'signup') {
    const { error } = await supabaseClient.auth.signUp({ email, password });
    if (error) throw error;
  } else {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }
}

async function handleLogout() {
  try { await supabaseClient?.auth.signOut(); } catch (_) {}
  currentUser = null;
  session = null;
  window.tsCache?.clear(); // never serve one account's data to the next
  window.store.set('authed', false);
  window.store.set('user', null);
  window.router.go('login');
}
