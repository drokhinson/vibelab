'use strict';

// ─── Supabase Auth wiring ────────────────────────────────────────────────────
// On boot the splash runs in two phases driven by init.js:
//   Phase 1 — "Authenticating": Supabase auth roundtrip + GET /profile.
//             /profile is the backend's authentication confirmation — it
//             establishes currentUser (is_admin, display_name) and
//             auto-creates a row for fresh signups. awaitInitialAuth()
//             resolves only after both finish (or after a 3s safety cap).
//   Phase 2 — "Saucing": init.js fires GET /saucebook (blocking) when
//             logged in. Pantry + Browse load in the background after the
//             splash drops; meal-builder reference data (initial-load,
//             ingredient-categories, substitutions) loads lazily on first
//             use of the meal-builder / recipe-builder.

let _profileLoadInFlight = false;
let _initialAuthResolve = null;
let _initialAuthReady = new Promise(resolve => { _initialAuthResolve = resolve; });
let _initialAuthSettled = false;

function awaitInitialAuth() {
  return _initialAuthReady;
}

function _resolveInitialAuth() {
  if (_initialAuthSettled) return;
  _initialAuthSettled = true;
  if (_initialAuthResolve) _initialAuthResolve();
}

function initSupabase() {
  const cfg = window.APP_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
    console.warn('[sauceboss] Supabase not configured; sign-in disabled.');
    _resolveInitialAuth();
    return;
  }
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error('[sauceboss] Supabase JS client missing — check the CDN script tag.');
    _resolveInitialAuth();
    return;
  }
  supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  // Hard cap so a misbehaving auth subscription can't strand the splash.
  setTimeout(_resolveInitialAuth, 3000);

  supabaseClient.auth.onAuthStateChange(async (event, sess) => {
    const isFirst = !_initialAuthSettled;
    session = sess;
    try {
      if (isFirst) {
        // Phase 1 of boot: hydrate currentUser via /profile so init.js can
        // decide which tab to land on and whether to fire /saucebook. No
        // other Sauceboss API calls happen here — those are init.js's job
        // under the "Saucing" splash.
        if (sess) await loadProfile();
        return;
      }
      // Subsequent events (modal sign-in, sign-out, token refresh).
      if (sess) {
        await loadProfile();
        if (currentUser) {
          // Block on saucebook so the Saucebook tab is populated when the
          // modal closes; pantry hydrates in the background.
          await loadSaucebook();
          loadPantry();
        }
        render();
      } else {
        currentUser = null;
        state.editMode = false;
        // Reset saucebook + pantry to anon defaults; force the user back to
        // Browse since the other tabs are locked without an account.
        state.saucebook = [];
        state.pantry = { ingredients: [], missing: new Set(), loading: false, error: null, _loaded: false };
        state.disabledIngredients = new Set();
        state.activeTab = 'browse';
        document.body.classList.remove('is-auth');
        render();
      }
    } finally {
      if (isFirst) _resolveInitialAuth();
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
    // Default landing tab once a user is signed in is Saucebook.
    state.activeTab = 'saucebook';
    document.body.classList.add('is-auth');
    try {
      state.editMode = sessionStorage.getItem('sb_edit_mode') === '1';
    } catch (_) { state.editMode = false; }
    closeAuthModal();
  } finally {
    _profileLoadInFlight = false;
  }
}

// Fetch the user's saucebook (single bulk call returning every row with
// full ingredients). Caller is responsible for render().
async function loadSaucebook() {
  if (!currentUser) return;
  try {
    state.saucebook = await api.listSaucebook();
  } catch (err) {
    console.warn('[sauceboss] saucebook load failed:', err);
    state.saucebook = [];
  }
}

// Fetch the user's pantry (single bulk call). Mirrors pantry.missing into
// the ingredient-name disabledIngredients Set so the meal-builder filter
// shows missing ingredients pre-checked. Re-renders so the Pantry tab
// updates in place when this lands as a background load.
async function loadPantry() {
  if (!currentUser) return;
  state.pantry.loading = true;
  try {
    const pantry = await api.getPantry();
    state.pantry.ingredients = pantry.ingredients || [];
    state.pantry.missing = new Set((pantry.ingredients || []).filter(i => i.missing).map(i => i.ingredientId));
    syncDisabledFromPantry();
  } catch (err) {
    console.warn('[sauceboss] pantry load failed:', err);
  } finally {
    state.pantry.loading = false;
    state.pantry._loaded = true;
    render();
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
  state.editMode = false;
  state.saucebook = [];
  state.pantry = { ingredients: [], missing: new Set(), loading: false, error: null };
  state.disabledIngredients = new Set();
  state.activeTab = 'browse';
  state.screen = 'tab-shell';
  try { sessionStorage.removeItem('sb_edit_mode'); } catch (_) {}
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
      <p class="auth-modal__subtitle">Add your own sauces, build your saucebook, and edit your recipes.</p>

      <button class="auth-modal__oauth auth-modal__oauth--google" onclick="handleOAuthSignIn('google')" ${state.authBusy ? 'disabled' : ''}>
        <svg class="auth-modal__oauth-logo" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        <span>Continue with Google</span>
      </button>
      <button class="auth-modal__oauth auth-modal__oauth--apple" onclick="handleOAuthSignIn('apple')" ${state.authBusy ? 'disabled' : ''}>
        <svg class="auth-modal__oauth-logo" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.351 2.18-.117.073-2.617 1.51-2.617 4.5 0 3.43 3.083 4.65 3.213 4.69z"/>
        </svg>
        <span>Continue with Apple</span>
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
