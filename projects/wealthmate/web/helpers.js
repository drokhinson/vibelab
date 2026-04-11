// helpers.js — WealthMate shared utilities

// ── Formatting helpers ────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null) return "--";
  const num = Number(n);
  if (isNaN(num)) return "--";
  return num.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtDate(d) {
  if (!d) return "";
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function typeLabel(t) {
  const map = {
    checking_personal: "Bank Account",
    checking_joint: "Bank Account",
    savings: "Bank Account",
    "401k": "401(k)",
    roth_ira: "Roth IRA",
    retirement_other: "Retirement",
    investment: "Investment",
    property_personal: "Property",
    property_rental: "Rental Property",
    car_loan: "Car Loan",
    mortgage: "Mortgage",
    loan: "Loan",
    other: "Other Account",
    other_liability: "Other Liability",
  };
  return map[t] || t;
}

function isLoanType(t) {
  return ["car_loan", "mortgage", "loan"].includes(t);
}

function isLiabilityType(t) {
  return ["car_loan", "mortgage", "loan", "other_liability"].includes(t);
}

// Map UI category + sub-type to DB account_type
function resolveAccountType(category, form) {
  switch (category) {
    case "bank": return "savings";
    case "retirement": return document.getElementById("acct-retirement-type").value;
    case "investment": return "investment";
    case "property": return document.getElementById("acct-property-type").value;
    case "loan": return document.getElementById("acct-loan-type").value;
    case "other_asset": return "other";
    case "other_liability": return "other_liability";
    default: return "other";
  }
}

// Map DB account_type back to UI category
function typeToCategory(t) {
  if (["checking_personal", "checking_joint", "savings"].includes(t)) return "bank";
  if (["401k", "roth_ira", "retirement_other"].includes(t)) return "retirement";
  if (t === "investment") return "investment";
  if (["property_personal", "property_rental"].includes(t)) return "property";
  if (["car_loan", "mortgage", "loan"].includes(t)) return "loan";
  if (t === "other_liability") return "other_liability";
  return "other_asset";
}

// ── Supabase client ──────────────────────────────────────────────────────────
sb = window.supabase.createClient(
  window.APP_CONFIG.supabaseUrl,
  window.APP_CONFIG.supabaseAnonKey
);

// ── Auth helpers ──────────────────────────────────────────────────────────────
async function getToken() {
  const session = (await sb.auth.getSession()).data.session;
  return session ? session.access_token : null;
}
async function isLoggedIn() {
  const session = (await sb.auth.getSession()).data.session;
  return !!session;
}

// ── API helpers ───────────────────────────────────────────────────────────────
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

// ── View switching ────────────────────────────────────────────────────────────
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
  if (name === "dashboard") loadDashboard();
  if (name === "accounts") loadAccounts();
  if (name === "history") loadHistory();
  if (name === "expenses") loadExpenses();
  if (name === "settings") loadSettings();
}

function showLoading(show) {
  document.getElementById("global-loading").style.display = show ? "flex" : "none";
}

// ── Auth flows ────────────────────────────────────────────────────────────────
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
    showView("dashboard");
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
    showView("dashboard");
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  } finally {
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
  }
}

function groupAccounts(accts) {
  const groups = { yours: [], partner: [], joint: [] };
  const activeAccounts = (accts || []).filter(a => a.is_active !== false);
  for (const a of activeAccounts) {
    if (!a.owner_user_id) {
      groups.joint.push(a);
    } else if (a.owner_user_id === currentUser.id) {
      groups.yours.push(a);
    } else {
      groups.partner.push(a);
    }
  }
  return groups;
}
