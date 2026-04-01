// auth.js — Supabase Auth: login, signup, session management

function initSupabase() {
  const cfg = window.APP_CONFIG;
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
}

async function loadProfile() {
  try {
    currentUser = await apiFetch("/profile");
  } catch {
    // Profile doesn't exist yet — create it
    try {
      const email = session.user?.email || "";
      const name = email.split("@")[0] || "Player";
      await apiFetch("/profile", {
        method: "POST",
        body: { display_name: name },
      });
      currentUser = await apiFetch("/profile");
    } catch (e) {
      console.error("Profile error:", e);
      showToast("Could not connect to server. Please try again.", "error");
      session = null;
      showView("auth");
      return;
    }
  }
  showView("browse");
  loadGames();
  updateProfileUI();
}

function updateProfileUI() {
  const el = document.getElementById("profile-name");
  if (el && currentUser) {
    el.textContent = currentUser.display_name;
  }
}

function renderAuth() {
  const container = document.getElementById("auth-container");
  container.innerHTML = `
    <div class="flex flex-col items-center justify-center min-h-[60vh] px-4">
      <div class="mb-8 text-center">
        <div class="text-6xl mb-4">🎲</div>
        <h1 class="text-3xl font-bold text-base-content">BoardgameBuddy</h1>
        <p class="text-base-content/60 mt-2">Your board game closet & play tracker</p>
      </div>

      <div class="card bg-base-200 w-full max-w-sm">
        <div class="card-body">
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
            <button type="submit" id="auth-btn" class="btn btn-primary w-full">Log In</button>
          </form>
        </div>
      </div>
    </div>
  `;
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
  await supabaseClient.auth.signOut();
  session = null;
  currentUser = null;
  showView("auth");
  renderAuth();
}
