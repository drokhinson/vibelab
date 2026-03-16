// helpers.js — SpotMe shared utilities

// ── Proficiency helpers ──────────────────────────────────────────────────────
const PROFICIENCY_LABELS = {
  want_to_learn: "Want to Learn",
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
  expert: "Expert",
};

const PROFICIENCY_PEAKS = {
  want_to_learn: 0,
  beginner: 1,
  intermediate: 2,
  advanced: 3,
  expert: 4,
};

function proficiencyLabel(p) {
  return PROFICIENCY_LABELS[p] || p;
}

function proficiencyPeaks(p) {
  const count = PROFICIENCY_PEAKS[p] ?? 0;
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
function getToken() {
  return localStorage.getItem("sm_token");
}
function setToken(t) {
  localStorage.setItem("sm_token", t);
}
function clearToken() {
  localStorage.removeItem("sm_token");
}
function isLoggedIn() {
  return !!getToken();
}

// ── API helpers ──────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API}${BASE}${path}`, {
    ...opts,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    clearToken();
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
  const forgotView = document.getElementById("view-forgot-password");

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
  if (name === "forgot-password") {
    appShell.style.display = "none";
    forgotView.style.display = "block";
    return;
  }

  // App views
  appShell.style.display = "block";
  loginView.style.display = "none";
  registerView.style.display = "none";
  forgotView.style.display = "none";

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
    const body = {
      username: document.getElementById("login-username").value.trim(),
      password: document.getElementById("login-password").value,
    };
    const data = await apiFetch("/auth/login", { method: "POST", body });
    setToken(data.token);
    currentUser = data.user;
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
    const emailVal = document.getElementById("reg-email").value.trim();
    const body = {
      username: document.getElementById("reg-username").value.trim(),
      password: document.getElementById("reg-password").value,
      display_name: document.getElementById("reg-display").value.trim(),
    };
    if (emailVal) body.email = emailVal;
    const data = await apiFetch("/auth/register", { method: "POST", body });
    setToken(data.token);
    currentUser = data.user;
    showView("profile");
    if (data.recovery_code) {
      showRecoveryCode(data.recovery_code);
    }
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  } finally {
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
  }
}

function showRecoveryCode(code) {
  document.getElementById("recovery-code-value").textContent = code;
  document.getElementById("recovery-code-dialog").showModal();
}

async function handleForgotPassword(e) {
  e.preventDefault();
  const btn = document.getElementById("fp-btn");
  const errEl = document.getElementById("fp-error");
  errEl.style.display = "none";
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;

  try {
    const pw = document.getElementById("fp-new-password").value;
    const confirm = document.getElementById("fp-confirm-password").value;
    if (pw !== confirm) throw new Error("Passwords do not match");

    const body = {
      username: document.getElementById("fp-username").value.trim(),
      recovery_code: document.getElementById("fp-recovery-code").value.trim(),
      new_password: pw,
    };
    const data = await apiFetch("/auth/reset-password", { method: "POST", body });
    alert("Password reset successful! Your new recovery code: " + data.new_recovery_code);
    showView("login");
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  } finally {
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
  }
}

function logout() {
  clearToken();
  currentUser = null;
  showView("login");
}
