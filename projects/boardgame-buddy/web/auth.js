// auth.js — Supabase Auth: login, signup, session management

let authConfigError = null;
let profileLoadInFlight = false;

function initSupabase() {
  const cfg = window.APP_CONFIG;
  try {
    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
      throw new Error("Supabase URL and anon key are not configured.");
    }
    supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

    supabaseClient.auth.onAuthStateChange((event, sess) => {
      session = sess;
      if (sess) {
        loadProfile();
      } else {
        currentUser = null;
        showAuthView();
      }
    });
  } catch (err) {
    console.error("Supabase init failed:", err);
    authConfigError = err.message || "Supabase auth could not be initialized.";
    showAuthView();
  }
}

function showAuthView() {
  renderAuth();
  showView("auth");
}

async function loadProfile() {
  // Supabase fires onAuthStateChange multiple times on OAuth return
  // (INITIAL_SESSION, SIGNED_IN); this guard keeps the fetch + toast single-shot.
  if (profileLoadInFlight || currentUser) return;
  profileLoadInFlight = true;
  try {
    try {
      currentUser = await apiFetch("/profile");
    } catch (getErr) {
      // 404 means profile doesn't exist yet — try to create it.
      // Any other error (CORS, 401, 500) should surface so the user can debug.
      const isMissingProfile = /not found/i.test(getErr?.message || "") || /404/.test(getErr?.message || "");
      if (!isMissingProfile) {
        console.error("GET /profile failed:", getErr);
        showToast(`Login failed: ${getErr.message || "unknown error"}`, "error");
        session = null;
        showAuthView();
        return;
      }
      try {
        const email = session.user?.email || "";
        const name = email.split("@")[0] || "Player";
        await apiFetch("/profile", {
          method: "POST",
          body: { display_name: name },
        });
        currentUser = await apiFetch("/profile");
      } catch (e) {
        console.error("POST /profile failed:", e);
        showToast(`Login failed: ${e.message || "unknown error"}`, "error");
        session = null;
        showAuthView();
        return;
      }
    }
    showView("closet");
    loadCloset();
    updateProfileUI();
    initSession();
  } finally {
    profileLoadInFlight = false;
  }
}

function updateProfileUI() {
  const el = document.getElementById("profile-avatar");
  if (el && currentUser) {
    el.textContent = computeInitials(currentUser.display_name);
  }
}

function renderAuth() {
  const container = document.getElementById("auth-container");
  const configBanner = authConfigError
    ? `<div class="alert alert-warning mb-4 text-sm">
         <i data-lucide="alert-triangle" class="w-4 h-4"></i>
         <span>Auth is misconfigured: ${authConfigError} Check Supabase env vars.</span>
       </div>`
    : "";
  const oauthDisabled = authConfigError ? "disabled" : "";

  container.innerHTML = `
    <div class="flex flex-col items-center justify-center min-h-[60vh] px-4">
      <div class="mb-8 text-center">
        <div class="mb-4" style="color: var(--accent)"><i data-lucide="dice-6" style="width:64px;height:64px;"></i></div>
        <h1 class="text-3xl font-bold text-base-content">BoardgameBuddy</h1>
        <p class="text-base-content/60 mt-2">Your board game closet & play tracker</p>
      </div>

      <div class="card bg-base-200 w-full max-w-sm">
        <div class="card-body">
          ${configBanner}

          <div class="flex flex-col gap-2">
            <button type="button" class="btn btn-outline w-full" onclick="handleOAuthLogin('google')" ${oauthDisabled}>
              <svg class="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Continue with Google
            </button>
            <button type="button" class="btn btn-outline w-full" onclick="handleOAuthLogin('apple')" ${oauthDisabled}>
              <svg class="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                <path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.351 2.18-.117.073-2.617 1.51-2.617 4.5 0 3.43 3.083 4.65 3.213 4.69z"/>
              </svg>
              Continue with Apple
            </button>
          </div>

          <div class="divider text-xs text-base-content/50 my-4">or continue with email</div>

          <div class="tabs tabs-boxed mb-4">
            <button class="tab tab-active" id="tab-login" onclick="switchAuthTab('login')">Log In</button>
            <button class="tab" id="tab-signup" onclick="switchAuthTab('signup')">Sign Up</button>
          </div>

          <form id="auth-form" onsubmit="handleAuth(event)">
            <div class="form-control mb-3">
              <input type="email" id="auth-email" placeholder="Email" class="input input-bordered w-full" required />
            </div>
            <div class="form-control mb-4">
              <input type="password" id="auth-password" placeholder="Password" class="input input-bordered w-full" required minlength="6" />
            </div>
            <div id="signup-fields" class="hidden form-control mb-4">
              <input type="text" id="auth-display-name" placeholder="Display name" class="input input-bordered w-full" />
            </div>
            <div id="auth-error" class="text-error text-sm mb-3 hidden"></div>
            <button type="submit" id="auth-btn" class="btn btn-primary w-full" ${oauthDisabled}>Log In</button>
          </form>
        </div>
      </div>
    </div>
  `;

  if (window.lucide) window.lucide.createIcons();
}

async function handleOAuthLogin(provider) {
  const errorEl = document.getElementById("auth-error");
  errorEl.classList.add("hidden");

  if (!supabaseClient) {
    errorEl.textContent = "Auth is not configured. Cannot sign in.";
    errorEl.classList.remove("hidden");
    return;
  }

  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
  } catch (err) {
    errorEl.textContent = err.message || `${provider} sign-in failed`;
    errorEl.classList.remove("hidden");
  }
}

let authMode = "login";

function switchAuthTab(mode) {
  authMode = mode;
  document.getElementById("tab-login").classList.toggle("tab-active", mode === "login");
  document.getElementById("tab-signup").classList.toggle("tab-active", mode === "signup");
  document.getElementById("signup-fields").classList.toggle("hidden", mode === "login");
  document.getElementById("auth-btn").textContent = mode === "login" ? "Log In" : "Sign Up";
  document.getElementById("auth-error").classList.add("hidden");
}

async function handleAuth(e) {
  e.preventDefault();
  const btn = document.getElementById("auth-btn");
  const errorEl = document.getElementById("auth-error");
  errorEl.classList.add("hidden");

  if (!supabaseClient) {
    errorEl.textContent = "Auth is not configured. Cannot sign in.";
    errorEl.classList.remove("hidden");
    return;
  }

  const email = document.getElementById("auth-email").value;
  const password = document.getElementById("auth-password").value;

  btn.classList.add("loading");
  btn.disabled = true;

  try {
    if (authMode === "signup") {
      const { error } = await supabaseClient.auth.signUp({ email, password });
      if (error) throw error;
      showToast("Account created! Check your email to confirm.", "success");
    } else {
      const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      trackEvent("login");
      // Swap to the splash so the login form doesn't flash while /profile loads.
      // onAuthStateChange will fire SIGNED_IN → loadProfile() → showView("closet").
      showView("splash");
    }
  } catch (err) {
    errorEl.textContent = err.message || "Authentication failed";
    errorEl.classList.remove("hidden");
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}

async function handleLogout() {
  if (supabaseClient) {
    await supabaseClient.auth.signOut();
  }
  session = null;
  currentUser = null;
  activeSession = null;
  sessionExpanded = false;
  if (typeof refreshSessionFab === "function") refreshSessionFab();
  showAuthView();
}
