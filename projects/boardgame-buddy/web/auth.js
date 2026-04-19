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
        showView("auth");
      }
    });
  } catch (err) {
    console.error("Supabase init failed:", err);
    authConfigError = err.message || "Supabase auth could not be initialized.";
    showView("auth");
  }
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
        showView("auth");
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
        showView("auth");
        return;
      }
    }
    showView("closet");
    loadCloset();
    updateProfileUI();
  } finally {
    profileLoadInFlight = false;
  }
}

function updateProfileUI() {
  const el = document.getElementById("profile-name");
  if (el && currentUser) {
    el.textContent = currentUser.display_name;
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
        <div class="text-6xl mb-4">🎲</div>
        <h1 class="text-3xl font-bold text-base-content">BoardgameBuddy</h1>
        <p class="text-base-content/60 mt-2">Your board game closet & play tracker</p>
      </div>

      <div class="card bg-base-200 w-full max-w-sm">
        <div class="card-body">
          ${configBanner}

          <div class="flex flex-col gap-2">
            <button type="button" class="btn btn-outline w-full" onclick="handleOAuthLogin('google')" ${oauthDisabled}>
              <i data-lucide="chrome" class="w-4 h-4"></i>
              Continue with Google
            </button>
            <button type="button" class="btn btn-outline w-full" onclick="handleOAuthLogin('apple')" ${oauthDisabled}>
              <i data-lucide="apple" class="w-4 h-4"></i>
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
  showView("auth");
  renderAuth();
}
