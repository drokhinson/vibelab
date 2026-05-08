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
  return `
    <div class="auth-screen">
      <div class="auth-logo">📖</div>
      <h1 class="auth-title">Day Word Play</h1>
      <p class="auth-subtitle">A new word every day. Your sentence. Your group's vote.</p>
      <div class="auth-card">
        ${errorBanner}

        <button type="button" class="auth-oauth-btn auth-oauth-google" id="oauth-google-btn" ${oauthDisabled}>
          Continue with Google
        </button>
        <button type="button" class="auth-oauth-btn auth-oauth-apple" id="oauth-apple-btn" ${oauthDisabled}>
          Continue with Apple
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
