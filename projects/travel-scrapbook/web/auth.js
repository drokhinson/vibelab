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

function awaitInitialAuth() { return _initialAuthReady; }

function _resolveInitialAuth() {
  if (_initialAuthSettled) return;
  _initialAuthSettled = true;
  _initialAuthResolve();
}

function getAuthToken() { return session?.access_token || null; }

async function loadProfile() {
  // Backend auth confirmation — auto-creates the profile row on first login
  // and returns the category option set the UI needs everywhere.
  try {
    currentUser = await window.api.me();
    window.store.set('user', currentUser);
    window.store.set('categories', currentUser.categories || []);
  } catch (err) {
    console.warn('[travel-scrapbook] /me failed:', err);
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
  supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  // Hard cap so a misbehaving auth subscription can't strand the splash.
  setTimeout(_resolveInitialAuth, 3000);

  supabaseClient.auth.onAuthStateChange(async (event, sess) => {
    const isFirst = !_initialAuthSettled;
    session = sess;
    let defer = false;
    try {
      if (sess) {
        await loadProfile();
      } else if (event === 'SIGNED_OUT') {
        currentUser = null;
        window.store.set('user', null);
      } else if (isFirst) {
        // No session yet. If the URL carries OAuth params a SIGNED_IN event
        // follows after the PKCE exchange — don't resolve early (a bare
        // `return` still runs finally, so flag it and gate the resolve).
        const hasAuthParams = window.location.search.includes('code=') ||
          window.location.hash.includes('access_token=');
        if (hasAuthParams) { defer = true; return; }
      }
    } finally {
      if (!defer) _resolveInitialAuth();
    }
  });

  // Kick session restoration; onAuthStateChange delivers the result.
  supabaseClient.auth.getSession().then(({ data }) => {
    if (!data?.session) {
      const hasAuthParams = window.location.search.includes('code=') ||
        window.location.hash.includes('access_token=');
      if (!hasAuthParams) _resolveInitialAuth();
    }
  }).catch(() => _resolveInitialAuth());
}

async function handleOAuthSignIn(provider) {
  if (!supabaseClient) { toast('Sign-in is not configured', { error: true }); return; }
  // Return to the current path so the /scrap popup lands back on itself.
  const redirectTo = window.location.origin + '/auth-callback' +
    '?next=' + encodeURIComponent(window.location.pathname + window.location.search);
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
  window.store.set('user', null);
  window.router.go('login');
}
