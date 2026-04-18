// auth.js — Supabase Auth: email + Google + Apple, plus profile-setup view

function initSupabase() {
  var cfg = window.APP_CONFIG;
  if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    console.error("Supabase config missing");
    showView("auth");
    return;
  }
  supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  supabaseClient.auth.onAuthStateChange(function(event, sess) {
    session = sess;
    if (sess) {
      loadProfile();
    } else {
      currentUser = null;
      showView("auth");
    }
  });
}

async function loadProfile() {
  try {
    currentUser = await apiFetch("/profile");
  } catch (err) {
    if (err && err.status === 404) {
      // First login — collect a display name before entering the app
      showView("profile-setup");
      return;
    }
    console.error("Profile load failed:", err);
    session = null;
    showView("auth");
    return;
  }
  try {
    await loadPlants();
    try { preloadThumbnails(plants, renderStyle); } catch (_) {}
  } catch (e) {
    console.error("Plant catalog load failed:", e);
  }
  showView("gardens");
}

async function loadPlants() {
  plants = await apiFetch("/plants");
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth view (login / signup / OAuth)
// ─────────────────────────────────────────────────────────────────────────────

var authMode = "login"; // "login" | "signup"

function renderAuth() {
  app.innerHTML = ''
    + '<div class="max-w-sm mx-auto mt-12">'
    +   '<div class="card bg-base-100 shadow-lg rounded-2xl">'
    +     '<div class="card-body items-center text-center">'
    +       '<h3 class="card-title font-display text-xl mb-1">Welcome to PlantPlanner</h3>'
    +       authIllustrationSVG()
    +       '<p class="text-sm text-base-content/50 mb-3">Plan your perfect garden with drag-and-drop simplicity.</p>'
    +       '<div role="tablist" class="tabs tabs-boxed w-full mb-3">'
    +         '<a id="tab-login" role="tab" class="tab tab-active flex-1">Log in</a>'
    +         '<a id="tab-signup" role="tab" class="tab flex-1">Sign up</a>'
    +       '</div>'
    +       '<div id="auth-error" class="w-full"></div>'
    +       '<form id="auth-submit" class="space-y-3 w-full">'
    +         '<input type="email" name="email" placeholder="Email" required class="input input-bordered w-full input-sm" />'
    +         '<input type="password" name="password" placeholder="Password" required minlength="6" class="input input-bordered w-full input-sm" />'
    +         '<button type="submit" id="auth-btn" class="btn btn-primary w-full btn-sm">Log in</button>'
    +       '</form>'
    +       '<div class="divider text-xs text-base-content/40 my-3">or continue with</div>'
    +       '<div class="grid grid-cols-2 gap-2 w-full">'
    +         '<button id="oauth-google" class="btn btn-outline btn-sm gap-2">'
    +           googleIconSVG()
    +           '<span>Google</span>'
    +         '</button>'
    +         '<button id="oauth-apple" class="btn btn-neutral btn-sm gap-2">'
    +           appleIconSVG()
    +           '<span>Apple</span>'
    +         '</button>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    + '</div>';

  document.getElementById("tab-login").onclick = function() { switchAuthMode("login"); };
  document.getElementById("tab-signup").onclick = function() { switchAuthMode("signup"); };
  document.getElementById("auth-submit").onsubmit = handleEmailAuth;
  document.getElementById("oauth-google").onclick = function() { handleOAuth("google"); };
  document.getElementById("oauth-apple").onclick = function() { handleOAuth("apple"); };
}

function switchAuthMode(mode) {
  authMode = mode;
  document.getElementById("tab-login").classList.toggle("tab-active", mode === "login");
  document.getElementById("tab-signup").classList.toggle("tab-active", mode === "signup");
  document.getElementById("auth-btn").textContent = mode === "login" ? "Log in" : "Sign up";
  document.getElementById("auth-error").innerHTML = "";
}

async function handleEmailAuth(e) {
  e.preventDefault();
  var form = e.target;
  var errEl = document.getElementById("auth-error");
  var btn = document.getElementById("auth-btn");
  errEl.innerHTML = "";
  btn.classList.add("loading");
  btn.disabled = true;
  var email = form.email.value;
  var password = form.password.value;
  try {
    var result;
    if (authMode === "signup") {
      result = await supabaseClient.auth.signUp({ email: email, password: password });
      if (result.error) throw result.error;
      if (result.data && result.data.user && !result.data.session) {
        // Email confirmation required
        errEl.innerHTML = '<div class="alert alert-info text-sm py-2">Check your email to confirm your account.</div>';
      }
    } else {
      result = await supabaseClient.auth.signInWithPassword({ email: email, password: password });
      if (result.error) throw result.error;
    }
    // onAuthStateChange handles the rest on success.
  } catch (err) {
    errEl.innerHTML = '<div class="alert alert-error text-sm py-2">' + (err.message || "Authentication failed") + '</div>';
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}

async function handleOAuth(provider) {
  var errEl = document.getElementById("auth-error");
  errEl.innerHTML = "";
  try {
    var result = await supabaseClient.auth.signInWithOAuth({
      provider: provider,
      options: { redirectTo: window.location.origin + window.location.pathname }
    });
    if (result.error) throw result.error;
    // Browser will redirect to the provider, then back; nothing more to do here.
  } catch (err) {
    errEl.innerHTML = '<div class="alert alert-error text-sm py-2">' + (err.message || "Sign-in failed") + '</div>';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile setup view (first login only)
// ─────────────────────────────────────────────────────────────────────────────

function renderProfileSetup() {
  var defaultName = "";
  if (session && session.user) {
    defaultName = (session.user.user_metadata && (session.user.user_metadata.full_name || session.user.user_metadata.name))
      || (session.user.email ? session.user.email.split("@")[0] : "");
  }
  app.innerHTML = ''
    + '<div class="max-w-sm mx-auto mt-12">'
    +   '<div class="card bg-base-100 shadow-lg rounded-2xl">'
    +     '<div class="card-body items-center text-center">'
    +       '<h3 class="card-title font-display text-xl mb-1">One last thing</h3>'
    +       '<p class="text-sm text-base-content/60 mb-4">What should we call you?</p>'
    +       '<div id="profile-error" class="w-full"></div>'
    +       '<form id="profile-form" class="space-y-3 w-full">'
    +         '<input type="text" name="display_name" placeholder="Display name" required maxlength="80" '
    +              'value="' + escapeHtml(defaultName) + '" class="input input-bordered w-full input-sm" />'
    +         '<button type="submit" id="profile-btn" class="btn btn-primary w-full btn-sm">Continue</button>'
    +       '</form>'
    +     '</div>'
    +   '</div>'
    + '</div>';

  document.getElementById("profile-form").onsubmit = handleProfileSubmit;
}

async function handleProfileSubmit(e) {
  e.preventDefault();
  var errEl = document.getElementById("profile-error");
  var btn = document.getElementById("profile-btn");
  errEl.innerHTML = "";
  btn.classList.add("loading");
  btn.disabled = true;
  var name = e.target.display_name.value.trim();
  if (!name) {
    btn.classList.remove("loading");
    btn.disabled = false;
    return;
  }
  try {
    currentUser = await apiFetch("/profile", { method: "POST", body: { display_name: name } });
    await loadPlants();
    try { preloadThumbnails(plants, renderStyle); } catch (_) {}
    showView("gardens");
  } catch (err) {
    errEl.innerHTML = '<div class="alert alert-error text-sm py-2">' + (err.message || "Could not save") + '</div>';
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG helpers
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
  });
}

function authIllustrationSVG() {
  return ''
    + '<div class="auth-illustration">'
    + '<svg width="180" height="120" viewBox="0 0 180 120" fill="none" xmlns="http://www.w3.org/2000/svg">'
    +   '<rect x="20" y="75" width="140" height="30" rx="8" fill="#7BAE7F" opacity="0.12"/>'
    +   '<rect x="25" y="70" width="130" height="10" rx="4" fill="#7BAE7F" opacity="0.22"/>'
    +   '<path d="M50 70 Q48 45 40 30 Q48 38 50 25 Q52 38 60 30 Q52 45 50 70Z" fill="#7BAE7F" opacity="0.55"/>'
    +   '<path d="M90 70 Q88 35 78 15 Q88 28 90 10 Q92 28 102 15 Q92 35 90 70Z" fill="#7BAE7F" opacity="0.7"/>'
    +   '<path d="M130 70 Q128 48 120 35 Q128 42 130 30 Q132 42 140 35 Q132 48 130 70Z" fill="#7BAE7F" opacity="0.5"/>'
    +   '<circle cx="78" cy="18" r="6" fill="#E8856C" opacity="0.8"/>'
    +   '<circle cx="102" cy="14" r="5" fill="#E8856C" opacity="0.7"/>'
    +   '<circle cx="40" cy="32" r="4" fill="#B8A9D4" opacity="0.6"/>'
    +   '<circle cx="140" cy="36" r="3.5" fill="#B8A9D4" opacity="0.55"/>'
    + '</svg>'
    + '</div>';
}

function googleIconSVG() {
  return '<svg width="16" height="16" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">'
    + '<path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8a12 12 0 1 1 0-24c3 0 5.7 1.1 7.8 3l5.7-5.7A20 20 0 1 0 24 44a20 20 0 0 0 19.6-23.5z"/>'
    + '<path fill="#FF3D00" d="M6.3 14.7l6.6 4.8A12 12 0 0 1 24 12c3 0 5.7 1.1 7.8 3l5.7-5.7A20 20 0 0 0 6.3 14.7z"/>'
    + '<path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A12 12 0 0 1 12.7 28l-6.6 5.1A20 20 0 0 0 24 44z"/>'
    + '<path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2c-.4.4 6.6-4.8 6.6-14.8 0-1.3-.1-2.3-.4-3.5z"/>'
    + '</svg>';
}

function appleIconSVG() {
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M16.36 1c.06 1.27-.46 2.5-1.27 3.4-.86.95-2.27 1.69-3.51 1.6-.13-1.21.5-2.46 1.32-3.27.91-.92 2.42-1.62 3.46-1.73zM21 17.34c-.42 1-.92 1.99-1.61 2.92-.94 1.27-2.27 2.85-3.92 2.86-1.46.02-1.84-.94-3.82-.93-1.98.01-2.4.95-3.86.93-1.66-.02-2.92-1.45-3.85-2.72C1.62 17.4.4 13.84 1.92 11.32c1.07-1.78 2.97-2.91 4.93-2.94 1.55-.02 3.02 1.04 3.86 1.04.84 0 2.6-1.29 4.4-1.1.75.03 2.86.3 4.21 2.27-3.45 1.94-2.91 6.12 1.69 6.75z"/>'
    + '</svg>';
}
