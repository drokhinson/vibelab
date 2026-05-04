'use strict';

// ─── Supabase Auth wiring ────────────────────────────────────────────────────
// Pattern mirrors boardgame-buddy/web/auth.js but without the splash gate —
// SauceBoss stays browsable when signed out.

let _profileLoadInFlight = false;

function initSupabase() {
  const cfg = window.APP_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
    console.warn('[sauceboss] Supabase not configured; sign-in disabled.');
    return;
  }
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error('[sauceboss] Supabase JS client missing — check the CDN script tag.');
    return;
  }
  supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  supabaseClient.auth.onAuthStateChange((event, sess) => {
    session = sess;
    if (sess) {
      loadProfile();
    } else {
      currentUser = null;
      state.favorites = new Set();
      document.body.classList.remove('is-auth');
      render();
    }
  });
}

async function loadProfile() {
  if (_profileLoadInFlight || currentUser) return;
  _profileLoadInFlight = true;
  try {
    try {
      currentUser = await fetchProfile();
    } catch (err) {
      const msg = err?.message || '';
      const isMissing = /404/.test(msg) || /not found/i.test(msg);
      if (!isMissing) {
        console.error('[sauceboss] GET /profile failed:', err);
        session = null;
        return;
      }
      const email = session?.user?.email || '';
      const displayName = email.split('@')[0] || 'Saucier';
      await createProfile(displayName);
      currentUser = await fetchProfile();
    }
    try {
      state.favorites = await fetchFavorites();
    } catch (e) {
      console.warn('[sauceboss] failed to load favorites:', e);
      state.favorites = new Set();
    }
    document.body.classList.add('is-auth');
    closeAuthModal();
    render();
  } finally {
    _profileLoadInFlight = false;
  }
}

async function handleLogout() {
  if (!supabaseClient) return;
  try {
    await supabaseClient.auth.signOut();
  } catch (e) {
    console.error('[sauceboss] signOut error:', e);
  }
  session = null;
  currentUser = null;
  state.favorites = new Set();
  state.favoritesOnly = false;
  document.body.classList.remove('is-auth');
  render();
}

// ─── Auth modal ──────────────────────────────────────────────────────────────
function openAuthModal() {
  if (!supabaseClient) {
    alert('Sign-in is not configured for this deployment.');
    return;
  }
  state.authModalOpen = true;
  state.authMode = 'login';
  state.authError = null;
  state.authBusy = false;
  renderAuthModal();
}

function closeAuthModal() {
  state.authModalOpen = false;
  state.authError = null;
  state.authBusy = false;
  renderAuthModal();
}

function renderAuthModal() {
  let modal = document.getElementById('auth-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'auth-modal';
    modal.className = 'auth-modal hidden';
    document.body.appendChild(modal);
  }
  if (!state.authModalOpen) {
    modal.classList.add('hidden');
    modal.innerHTML = '';
    return;
  }
  modal.classList.remove('hidden');
  const isLogin = state.authMode !== 'signup';
  modal.innerHTML = `
    <div class="auth-modal__backdrop" onclick="closeAuthModal()"></div>
    <div class="auth-modal__card" role="dialog" aria-modal="true" aria-label="Sign in">
      <button class="auth-modal__close" onclick="closeAuthModal()" aria-label="Close">×</button>
      <h2 class="auth-modal__title">${isLogin ? 'Sign in to SauceBoss' : 'Create your account'}</h2>
      <p class="auth-modal__subtitle">Add your own sauces, save favorites, and edit your recipes.</p>

      <button class="auth-modal__oauth auth-modal__oauth--google" onclick="handleOAuthSignIn('google')" ${state.authBusy ? 'disabled' : ''}>
        Continue with Google
      </button>
      <button class="auth-modal__oauth auth-modal__oauth--apple" onclick="handleOAuthSignIn('apple')" ${state.authBusy ? 'disabled' : ''}>
        Continue with Apple
      </button>

      <div class="auth-modal__divider"><span>or</span></div>

      <form class="auth-modal__form" onsubmit="event.preventDefault(); handleEmailSubmit();">
        <label class="auth-modal__label">
          Email
          <input id="auth-email" type="email" autocomplete="email" required />
        </label>
        <label class="auth-modal__label">
          Password
          <input id="auth-password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" minlength="6" required />
        </label>
        ${state.authError ? `<p class="auth-modal__error">${state.authError}</p>` : ''}
        <button type="submit" class="auth-modal__submit" ${state.authBusy ? 'disabled' : ''}>
          ${state.authBusy ? '...' : (isLogin ? 'Sign in' : 'Sign up')}
        </button>
      </form>

      <p class="auth-modal__footer">
        ${isLogin
          ? `New here? <a href="#" onclick="event.preventDefault(); switchAuthMode('signup')">Create an account</a>`
          : `Already have one? <a href="#" onclick="event.preventDefault(); switchAuthMode('login')">Sign in</a>`}
      </p>
    </div>
  `;
}

function switchAuthMode(mode) {
  state.authMode = mode;
  state.authError = null;
  renderAuthModal();
}

async function handleOAuthSignIn(provider) {
  if (!supabaseClient) return;
  state.authBusy = true;
  state.authError = null;
  renderAuthModal();
  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
  } catch (e) {
    console.error(`[sauceboss] ${provider} sign-in failed:`, e);
    state.authError = e.message || `${provider} sign-in failed`;
    state.authBusy = false;
    renderAuthModal();
  }
}

async function handleEmailSubmit() {
  if (!supabaseClient) return;
  const email = document.getElementById('auth-email')?.value?.trim();
  const password = document.getElementById('auth-password')?.value;
  if (!email || !password) {
    state.authError = 'Email and password are required.';
    renderAuthModal();
    return;
  }
  state.authBusy = true;
  state.authError = null;
  renderAuthModal();
  const isLogin = state.authMode !== 'signup';
  try {
    if (isLogin) {
      const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } else {
      const { error } = await supabaseClient.auth.signUp({ email, password });
      if (error) throw error;
      state.authError = 'Check your email to confirm your account, then sign in.';
      state.authMode = 'login';
    }
  } catch (e) {
    state.authError = e.message || 'Authentication failed.';
  } finally {
    state.authBusy = false;
    renderAuthModal();
  }
}
