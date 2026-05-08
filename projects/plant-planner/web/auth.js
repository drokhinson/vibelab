// auth.js — Supabase Auth (Google + Apple OAuth + email/password)

var _profileLoadInFlight = false;

// ── Supabase wiring ──────────────────────────────────────────────────────────

function initSupabase() {
  var cfg = window.APP_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    authConfigError = "Sign-in is not configured for this build. Set Supabase URL + anon key in config.js.";
    console.warn("[plant-planner] " + authConfigError);
    showView("auth");
    return;
  }
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    authConfigError = "Supabase JS client missing — check the CDN script tag.";
    console.error("[plant-planner] " + authConfigError);
    showView("auth");
    return;
  }
  supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  supabaseClient.auth.onAuthStateChange(function(_event, sess) {
    session = sess;
    if (sess) {
      loadProfileAndBoot();
    } else {
      currentUser = null;
      currentGarden = null;
      gridPlacements = {};
      gardens = [];
      plants = [];
      showView("auth");
    }
  });
}

async function loadProfileAndBoot() {
  if (_profileLoadInFlight || currentUser) return;
  _profileLoadInFlight = true;
  try {
    try {
      currentUser = await apiFetch("/auth/me");
    } catch (err) {
      console.error("[plant-planner] GET /auth/me failed:", err);
      authConfigError = "Sign-in failed: " + ((err && err.message) || "unknown error");
      if (supabaseClient) await supabaseClient.auth.signOut();
      return;
    }
    try {
      await loadPlants();
    } catch (e) {
      console.warn("[plant-planner] loadPlants failed:", e);
    }
    try { await loadCompanions(); } catch (e) { console.warn('[plant-planner] loadCompanions failed:', e); }
    try { preloadThumbnails(plants, renderStyle); } catch (_) {}
    showView("gardens");
  } finally {
    _profileLoadInFlight = false;
  }
}

async function loadPlants() {
  plants = await apiFetch("/plants");
}

// ── Auth screen ──────────────────────────────────────────────────────────────

function renderAuth() {
  var isLogin = authMode !== "signup";
  var oauthDisabled = !supabaseClient ? "disabled" : "";
  var errorBanner = authConfigError
    ? '<div class="error-banner">' + escapeAuthHtml(authConfigError) + '</div>'
    : "";

  var googleLogo = '<svg class="auth-oauth-logo" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>' +
    '<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>' +
    '<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>' +
    '<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>' +
    '</svg>';
  var appleLogo = '<svg class="auth-oauth-logo" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
    '<path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.351 2.18-.117.073-2.617 1.51-2.617 4.5 0 3.43 3.083 4.65 3.213 4.69z"/>' +
    '</svg>';

  app.innerHTML =
    '<div class="max-w-sm mx-auto mt-8">' +
      '<div class="card bg-base-100 shadow-lg rounded-2xl">' +
        '<div class="card-body items-center text-center">' +
          '<h3 class="card-title font-display text-xl mb-1">Welcome to PlantPlanner</h3>' +
          '<div class="auth-illustration">' + _plantIllustrationSvg() + '</div>' +
          '<p class="text-sm text-base-content/50 mb-3">Plan your perfect garden with drag-and-drop simplicity.</p>' +
          '<div class="auth-card w-full">' +
            errorBanner +
            '<button type="button" class="auth-oauth-btn auth-oauth-google" id="oauth-google-btn"' + (oauthDisabled ? " disabled" : "") + '>' +
              googleLogo + '<span>Continue with Google</span>' +
            '</button>' +
            '<button type="button" class="auth-oauth-btn auth-oauth-apple" id="oauth-apple-btn"' + (oauthDisabled ? " disabled" : "") + '>' +
              appleLogo + '<span>Continue with Apple</span>' +
            '</button>' +
            '<div class="auth-divider"><span>or use email</span></div>' +
            '<div class="auth-tabs">' +
              '<button type="button" class="auth-tab ' + (isLogin ? "active" : "") + '" id="tab-login">Log In</button>' +
              '<button type="button" class="auth-tab ' + (!isLogin ? "active" : "") + '" id="tab-register">Sign Up</button>' +
            '</div>' +
            '<form id="auth-email-form">' +
              '<div class="form-field">' +
                '<label for="auth-email">Email</label>' +
                '<input type="email" id="auth-email" autocomplete="email" placeholder="you@example.com" required' + (oauthDisabled ? " disabled" : "") + ' />' +
              '</div>' +
              '<div class="form-field">' +
                '<label for="auth-password">Password</label>' +
                '<input type="password" id="auth-password" autocomplete="' + (isLogin ? "current-password" : "new-password") + '" minlength="6" placeholder="at least 6 characters" required' + (oauthDisabled ? " disabled" : "") + ' />' +
              '</div>' +
              '<button type="submit" class="auth-submit" id="auth-submit-btn"' + ((authBusy || oauthDisabled) ? " disabled" : "") + '>' +
                (authBusy ? "…" : (isLogin ? "Log In" : "Create Account")) +
              '</button>' +
            '</form>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  initAuthListeners();
}

function _plantIllustrationSvg() {
  return '<svg width="180" height="120" viewBox="0 0 180 120" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="20" y="75" width="140" height="30" rx="8" fill="#7BAE7F" opacity="0.12"/>' +
    '<rect x="25" y="70" width="130" height="10" rx="4" fill="#7BAE7F" opacity="0.22"/>' +
    '<path d="M50 70 Q48 45 40 30 Q48 38 50 25 Q52 38 60 30 Q52 45 50 70Z" fill="#7BAE7F" opacity="0.55"/>' +
    '<path d="M90 70 Q88 35 78 15 Q88 28 90 10 Q92 28 102 15 Q92 35 90 70Z" fill="#7BAE7F" opacity="0.7"/>' +
    '<path d="M130 70 Q128 48 120 35 Q128 42 130 30 Q132 42 140 35 Q132 48 130 70Z" fill="#7BAE7F" opacity="0.5"/>' +
    '<circle cx="78" cy="18" r="6" fill="#E8856C" opacity="0.8"/>' +
    '<circle cx="102" cy="14" r="5" fill="#E8856C" opacity="0.7"/>' +
    '<circle cx="40" cy="32" r="4" fill="#B8A9D4" opacity="0.6"/>' +
    '<circle cx="140" cy="36" r="3.5" fill="#B8A9D4" opacity="0.55"/>' +
    '</svg>';
}

function initAuthListeners() {
  var loginTab = document.getElementById("tab-login");
  if (loginTab) loginTab.onclick = function() {
    if (authMode === "login") return;
    authMode = "login";
    authConfigError = null;
    renderAuth();
  };
  var registerTab = document.getElementById("tab-register");
  if (registerTab) registerTab.onclick = function() {
    if (authMode === "signup") return;
    authMode = "signup";
    authConfigError = null;
    renderAuth();
  };
  var googleBtn = document.getElementById("oauth-google-btn");
  if (googleBtn) googleBtn.onclick = function() { handleOAuthSignIn("google"); };
  var appleBtn = document.getElementById("oauth-apple-btn");
  if (appleBtn) appleBtn.onclick = function() { handleOAuthSignIn("apple"); };
  var form = document.getElementById("auth-email-form");
  if (form) form.onsubmit = handleEmailSubmit;
}

async function handleOAuthSignIn(provider) {
  if (!supabaseClient) return;
  authConfigError = null;
  authBusy = true;
  renderAuth();
  try {
    var res = await supabaseClient.auth.signInWithOAuth({
      provider: provider,
      options: { redirectTo: window.location.origin },
    });
    if (res && res.error) throw res.error;
    // Browser navigates away to the provider — onAuthStateChange will fire on return.
  } catch (e) {
    console.error("[plant-planner] " + provider + " sign-in failed:", e);
    authConfigError = (e && e.message) ? e.message : (provider + " sign-in failed.");
    authBusy = false;
    renderAuth();
  }
}

async function handleEmailSubmit(e) {
  e.preventDefault();
  if (!supabaseClient) return;
  var emailEl = document.getElementById("auth-email");
  var passwordEl = document.getElementById("auth-password");
  var email = (emailEl && emailEl.value || "").trim();
  var password = (passwordEl && passwordEl.value) || "";
  if (!email || !password) {
    authConfigError = "Email and password are required.";
    renderAuth();
    return;
  }
  authBusy = true;
  authConfigError = null;
  renderAuth();
  var isLogin = authMode !== "signup";
  try {
    if (isLogin) {
      var r1 = await supabaseClient.auth.signInWithPassword({ email: email, password: password });
      if (r1.error) throw r1.error;
      // onAuthStateChange will fire SIGNED_IN → loadProfileAndBoot()
    } else {
      var r2 = await supabaseClient.auth.signUp({ email: email, password: password });
      if (r2.error) throw r2.error;
      authConfigError = "Check your email to confirm your account, then log in.";
      authMode = "login";
      authBusy = false;
      renderAuth();
    }
  } catch (err) {
    authConfigError = (err && err.message) ? err.message : "Authentication failed.";
    authBusy = false;
    renderAuth();
  }
}

function escapeAuthHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
