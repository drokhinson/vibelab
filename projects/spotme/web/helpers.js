// helpers.js — SpotMe shared utilities

// ── Supabase client ──────────────────────────────────────────────────────────
sb = window.supabase.createClient(
  window.APP_CONFIG.supabaseUrl,
  window.APP_CONFIG.supabaseAnonKey
);

// ── Proficiency helpers ──────────────────────────────────────────────────────
// levels: array of {value, label} from the API. Falls back gracefully.

function proficiencyLabel(p, levels) {
  if (levels) {
    const match = levels.find(l => l.value === p);
    if (match) return match.label;
  }
  // Legacy fallback for values stored before hobby-specific levels
  const LEGACY = {
    want_to_learn: "Want to Learn", beginner: "Beginner",
    intermediate: "Intermediate",  advanced: "Advanced", expert: "Expert",
  };
  return LEGACY[p] || p;
}

function proficiencyPeaks(p, levels) {
  if (levels) {
    const idx = levels.findIndex(l => l.value === p);
    if (idx === 0) {
      // First level is always "want to learn"
      return `<span class="peaks want-to-learn" title="${levels[0].label}">&#9734;</span>`;
    }
    if (idx > 0) {
      const max = levels.length - 1; // exclude want_to_learn slot
      let html = "";
      for (let i = 1; i <= max; i++) {
        html += i <= idx
          ? '<span class="peak filled">&#9650;</span>'
          : '<span class="peak empty">&#9650;</span>';
      }
      return html;
    }
  }
  // Legacy fallback
  const LEGACY_PEAKS = { want_to_learn: 0, beginner: 1, intermediate: 2, advanced: 3, expert: 4 };
  const count = LEGACY_PEAKS[p] ?? 0;
  if (count === 0) return '<span class="peaks want-to-learn" title="Want to Learn">&#9734;</span>';
  let html = "";
  for (let i = 0; i < 4; i++) {
    html += i < count
      ? '<span class="peak filled">&#9650;</span>'
      : '<span class="peak empty">&#9650;</span>';
  }
  return html;
}

// ── Auth helpers ─────────────────────────────────────────────────────────────
async function getToken() {
  const session = (await sb.auth.getSession()).data.session;
  return session ? session.access_token : null;
}
function clearToken() {}
async function isLoggedIn() {
  const session = (await sb.auth.getSession()).data.session;
  return !!session;
}

// ── API helpers ──────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const token = await getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API}${BASE}${path}`, {
    ...opts,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    await sb.auth.signOut();
    currentUser = null;
    showView("login");
    throw new Error("Session expired. Please log in again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || data.message || `HTTP ${res.status}`);
  }
  return data;
}

// ── View switching ───────────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll(".view").forEach(v => (v.style.display = "none"));
  const appShell = document.getElementById("app-shell");
  const loginView = document.getElementById("view-login");
  const registerView = document.getElementById("view-register");

  if (name === "login") {
    appShell.style.display = "none";
    loginView.style.display = "block";
    return;
  }
  if (name === "register") {
    appShell.style.display = "none";
    registerView.style.display = "block";
    return;
  }

  // App views
  appShell.style.display = "block";
  loginView.style.display = "none";
  registerView.style.display = "none";

  const el = document.getElementById(`view-${name}`);
  if (el) el.style.display = "block";

  currentView = name;

  // Update nav
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });

  // Load data for view
  if (name === "profile") loadProfile();
  if (name === "hobbies") loadHobbies();
  if (name === "settings") loadSettings();
}

function showLoading(show) {
  document.getElementById("global-loading").style.display = show ? "flex" : "none";
}

// ── Auth flows ───────────────────────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById("login-btn");
  const errEl = document.getElementById("login-error");
  errEl.style.display = "none";
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;

  try {
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    currentUser = await apiFetch("/auth/me");
    showView("profile");
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  } finally {
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const btn = document.getElementById("register-btn");
  const errEl = document.getElementById("register-error");
  errEl.style.display = "none";
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;

  try {
    const email = document.getElementById("reg-email").value.trim();
    const password = document.getElementById("reg-password").value;
    const username = document.getElementById("reg-username").value.trim();
    const display_name = document.getElementById("reg-display").value.trim();

    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw new Error(error.message);
    if (!data.session) throw new Error("Check your email to confirm your account.");

    // Create profile in backend
    const profileData = await apiFetch("/auth/profile", {
      method: "POST",
      body: { username, display_name: display_name || username, email },
    });
    currentUser = profileData.user;
    showView("profile");
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  } finally {
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
  }
}

async function logout() {
  await sb.auth.signOut();
  currentUser = null;
  showView("login");
}
