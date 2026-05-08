'use strict';

// ── Supabase Auth wiring ──────────────────────────────────────────────────────
// Mirrors projects/sauceboss/web/auth.js but adapted to Day Word Play's
// "logged-in only" splash gate (the home shell is hidden until the user
// signs in, like boardgame-buddy).

let _profileLoadInFlight = false;

function initSupabase() {
  const cfg = window.APP_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
    authConfigError = 'Sign-in is not configured for this build. Set Supabase URL + anon key in config.js.';
    console.warn('[daywordplay] ' + authConfigError);
    renderApp();
    return;
  }
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    authConfigError = 'Supabase JS client missing — check the CDN script tag.';
    console.error('[daywordplay] ' + authConfigError);
    renderApp();
    return;
  }
  supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  supabaseClient.auth.onAuthStateChange((_event, sess) => {
    session = sess;
    if (sess) {
      loadProfileAndBoot();
    } else {
      currentUser = null;
      myGroups = [];
      activeGroupId = null;
      todayData = null;
      yesterdayData = null;
      bookmarks = [];
      currentView = 'home';
      if (typeof dwpCache !== 'undefined') dwpCache.clear();
      renderApp();
      initAuthListeners();
    }
  });
}

async function loadProfileAndBoot() {
  if (_profileLoadInFlight || currentUser) return;
  _profileLoadInFlight = true;
  try {
    try {
      currentUser = await apiFetch('/profile');
    } catch (err) {
      const msg = err?.message || '';
      const isMissing = /404/.test(msg) || /not found/i.test(msg);
      if (!isMissing) {
        console.error('[daywordplay] GET /profile failed:', err);
        authConfigError = `Login failed: ${msg || 'unknown error'}`;
        if (supabaseClient) await supabaseClient.auth.signOut();
        return;
      }
      const email = session?.user?.email || '';
      const displayName = email.split('@')[0] || 'Player';
      try {
        await apiFetch('/profile', {
          method: 'POST',
          body: JSON.stringify({ display_name: displayName }),
        });
        currentUser = await apiFetch('/profile');
      } catch (e) {
        console.error('[daywordplay] POST /profile failed:', e);
        authConfigError = `Login failed: ${e?.message || 'unknown error'}`;
        if (supabaseClient) await supabaseClient.auth.signOut();
        return;
      }
    }
    // Hydrate the rest of the eager data (groups, active-group today word).
    try {
      await loadEagerData();
    } catch (e) {
      console.warn('[daywordplay] loadEagerData failed:', e);
    }
    renderApp();
    initShellListeners();
    initPageListeners();
    _loadDeferredData();
  } finally {
    _profileLoadInFlight = false;
  }
}

// ── Auth screen (shown when session is null) ──────────────────────────────────

function renderAuthScreen() {
  const isLogin = authMode !== 'signup';
  const errorBanner = authConfigError ? `<div class="error-banner" style="margin-bottom:16px;">${escHtml(authConfigError)}</div>` : '';
  const oauthDisabled = !supabaseClient ? 'disabled' : '';
  const googleLogo = `
    <svg class="auth-oauth-logo" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>`;
  const appleLogo = `
    <svg class="auth-oauth-logo" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.351 2.18-.117.073-2.617 1.51-2.617 4.5 0 3.43 3.083 4.65 3.213 4.69z"/>
    </svg>`;
  return `
    <div class="auth-screen">
      <div class="auth-brand">
        <div class="auth-logo"><img src="assets/brand/dwp-logo.svg" alt="" /></div>
        <h1 class="auth-title">Day Word Play</h1>
      </div>
      <p class="auth-subtitle">A new word every day. Your sentence. Your group's vote.</p>
      <div class="auth-card">
        ${errorBanner}

        <button type="button" class="auth-oauth-btn auth-oauth-google" id="oauth-google-btn" ${oauthDisabled}>
          ${googleLogo}<span>Continue with Google</span>
        </button>
        <button type="button" class="auth-oauth-btn auth-oauth-apple" id="oauth-apple-btn" ${oauthDisabled}>
          ${appleLogo}<span>Continue with Apple</span>
        </button>

        <div class="auth-divider"><span>or use email</span></div>

        <div class="auth-tabs">
          <button class="auth-tab ${isLogin ? 'active' : ''}" id="tab-login">Log In</button>
          <button class="auth-tab ${!isLogin ? 'active' : ''}" id="tab-register">Sign Up</button>
        </div>

        <form id="auth-email-form">
          <div class="form-field">
            <label for="auth-email">Email</label>
            <input type="email" id="auth-email" autocomplete="email" placeholder="you@example.com" required ${oauthDisabled} />
          </div>
          <div class="form-field">
            <label for="auth-password">Password</label>
            <input type="password" id="auth-password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" minlength="6" placeholder="at least 6 characters" required ${oauthDisabled} />
          </div>
          <button type="submit" class="auth-submit" id="auth-submit-btn" ${authBusy || oauthDisabled ? 'disabled' : ''}>
            ${authBusy ? '…' : (isLogin ? 'Log In' : 'Create Account')}
          </button>
        </form>
      </div>
    </div>
  `;
}

function initAuthListeners() {
  document.getElementById('tab-login')?.addEventListener('click', () => {
    if (authMode === 'login') return;
    authMode = 'login';
    authConfigError = null;
    renderApp();
    initAuthListeners();
  });
  document.getElementById('tab-register')?.addEventListener('click', () => {
    if (authMode === 'signup') return;
    authMode = 'signup';
    authConfigError = null;
    renderApp();
    initAuthListeners();
  });
  document.getElementById('oauth-google-btn')?.addEventListener('click', () => handleOAuthSignIn('google'));
  document.getElementById('oauth-apple-btn')?.addEventListener('click', () => handleOAuthSignIn('apple'));
  document.getElementById('auth-email-form')?.addEventListener('submit', handleEmailSubmit);
}

async function handleOAuthSignIn(provider) {
  if (!supabaseClient) return;
  authConfigError = null;
  authBusy = true;
  renderApp();
  initAuthListeners();
  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
    // Browser navigates away to the provider — onAuthStateChange will fire on return.
  } catch (e) {
    console.error(`[daywordplay] ${provider} sign-in failed:`, e);
    authConfigError = e?.message || `${provider} sign-in failed.`;
    authBusy = false;
    renderApp();
    initAuthListeners();
  }
}

async function handleEmailSubmit(e) {
  e.preventDefault();
  if (!supabaseClient) return;
  const email = document.getElementById('auth-email')?.value?.trim();
  const password = document.getElementById('auth-password')?.value;
  if (!email || !password) {
    authConfigError = 'Email and password are required.';
    renderApp();
    initAuthListeners();
    return;
  }
  authBusy = true;
  authConfigError = null;
  renderApp();
  initAuthListeners();
  const isLogin = authMode !== 'signup';
  try {
    if (isLogin) {
      const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      // onAuthStateChange will fire SIGNED_IN → loadProfileAndBoot()
    } else {
      const { error } = await supabaseClient.auth.signUp({ email, password });
      if (error) throw error;
      authConfigError = 'Check your email to confirm your account, then log in.';
      authMode = 'login';
      authBusy = false;
      renderApp();
      initAuthListeners();
    }
  } catch (err) {
    authConfigError = err?.message || 'Authentication failed.';
    authBusy = false;
    renderApp();
    initAuthListeners();
  }
}

async function handleLogout() {
  if (!supabaseClient) return;
  try {
    await supabaseClient.auth.signOut();
  } catch (e) {
    console.error('[daywordplay] signOut error:', e);
  }
  // onAuthStateChange (event=SIGNED_OUT) handles state reset + re-render.
}
