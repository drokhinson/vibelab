// app.js — WealthMate
// All data comes from the shared backend API via fetch().
// API base URL is set in config.js as window.APP_CONFIG.apiBase

const API = window.APP_CONFIG?.apiBase ?? "http://localhost:8000";
const BASE = "/api/v1/wealthmate";

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser = null;   // { id, username, display_name }
let coupleInfo = null;    // { couple, members } or null
let activeCheckin = null;  // in-progress checkin or null
let previousValues = {};   // account_id -> { current_value, balance_owed }
let accounts = [];
let checkins = [];
let wealthHistory = [];
let nwChart = null;
let currentView = "dashboard";
let checkinStep = 1;

// ── Formatting helpers ────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null) return "--";
  const num = Number(n);
  if (isNaN(num)) return "--";
  return num.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtDate(d) {
  if (!d) return "";
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function typeLabel(t) {
  const map = {
    checking_personal: "Bank Account",
    checking_joint: "Bank Account",
    savings: "Savings",
    "401k": "401(k)",
    investment: "Investment",
    property_personal: "Property",
    property_rental: "Rental Property",
    car_loan: "Car Loan",
    mortgage: "Mortgage",
    other: "Other",
  };
  return map[t] || t;
}

function isLoanType(t) {
  return ["car_loan", "mortgage"].includes(t);
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
function getToken() {
  return localStorage.getItem("wm_token");
}
function setToken(t) {
  localStorage.setItem("wm_token", t);
}
function clearToken() {
  localStorage.removeItem("wm_token");
}
function isLoggedIn() {
  return !!getToken();
}

// ── API helpers ───────────────────────────────────────────────────────────────
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
    const body = {
      username: document.getElementById("login-username").value.trim(),
      password: document.getElementById("login-password").value,
    };
    const data = await apiFetch("/auth/login", { method: "POST", body });
    setToken(data.token);
    currentUser = data.user;
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
    const body = {
      username: document.getElementById("reg-username").value.trim(),
      password: document.getElementById("reg-password").value,
      display_name: document.getElementById("reg-display").value.trim(),
    };
    const data = await apiFetch("/auth/register", { method: "POST", body });
    setToken(data.token);
    currentUser = data.user;
    showView("dashboard");
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  } finally {
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
  }
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    // Fetch user info, couple, active checkin, and history in parallel
    const [me, couple, active, history] = await Promise.all([
      apiFetch("/auth/me"),
      apiFetch("/couple").catch(() => null),
      apiFetch("/checkins/active").catch(() => null),
      apiFetch("/wealth/history").catch(() => []),
    ]);

    currentUser = me;
    coupleInfo = couple;
    activeCheckin = active;
    wealthHistory = Array.isArray(history) ? history : [];

    document.getElementById("header-user").textContent = currentUser.display_name || currentUser.username;

    // Couple status bar
    renderCoupleBar();

    // Net worth card
    if (wealthHistory.length > 0) {
      const latest = wealthHistory[wealthHistory.length - 1];
      document.getElementById("nw-value").textContent = fmt(latest.net_worth);
      document.getElementById("nw-assets").textContent = fmt(latest.gross_assets);
      document.getElementById("nw-liabilities").textContent = fmt(latest.total_liabilities);
      document.getElementById("nw-date").textContent = `As of ${fmtDate(latest.checkin_date)}`;
    } else {
      document.getElementById("nw-value").textContent = "--";
      document.getElementById("nw-assets").textContent = "--";
      document.getElementById("nw-liabilities").textContent = "--";
      document.getElementById("nw-date").textContent = "No check-ins yet";
    }

    // Active checkin button
    const contBtn = document.getElementById("btn-continue-checkin");
    if (activeCheckin && activeCheckin.id) {
      contBtn.style.display = "block";
      contBtn.textContent = `Continue Check-In (${fmtDate(activeCheckin.checkin_date)})`;
    } else {
      contBtn.style.display = "none";
    }

    // Recent check-ins
    const recentList = document.getElementById("dash-recent-list");
    if (wealthHistory.length > 0) {
      recentList.innerHTML = wealthHistory.slice(-5).reverse().map(h => `
        <div class="recent-card">
          <span class="recent-card-date">${fmtDate(h.checkin_date)}</span>
          <span class="recent-card-nw">${fmt(h.net_worth)}</span>
        </div>
      `).join("");
    } else {
      recentList.innerHTML = '<div class="empty-state">No check-ins yet. Start your first one above!</div>';
    }
  } catch (err) {
    console.error("Dashboard load error:", err);
  }
}

function renderCoupleBar() {
  const el = document.getElementById("couple-status-bar");
  const members = (coupleInfo && coupleInfo.members) || [];
  const partner = members.find(m => m.user_id !== currentUser.id);
  if (partner) {
    el.innerHTML = `<div class="couple-bar">Merged with <strong>${partner.display_name || partner.username}</strong></div>`;
  } else {
    el.innerHTML = '<div class="couple-bar couple-bar-solo">Tracking solo — merge finances with a partner in Settings!</div>';
  }
}

// ── Check-In Flow ─────────────────────────────────────────────────────────────
async function startNewCheckin() {
  showView("checkin");
  setCheckinStep(1);
  // Default date to today
  document.getElementById("checkin-date").value = new Date().toISOString().split("T")[0];
}

async function continueCheckin() {
  if (!activeCheckin) return;
  showView("checkin");
  // Load accounts and previous values, then go to step 2
  try {
    showLoading(true);
    accounts = await apiFetch("/accounts");
    // Load checkin values
    const checkinData = await apiFetch(`/checkins/${activeCheckin.id}`);
    activeCheckin = checkinData;
    // Build previousValues from the checkin's returned previous_values if available
    await loadPreviousValues();
    showLoading(false);
    setCheckinStep(2);
    renderCheckinAccounts();
  } catch (err) {
    showLoading(false);
    alert("Error loading check-in: " + err.message);
  }
}

function setCheckinStep(step) {
  checkinStep = step;
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`checkin-step-${i}`);
    if (el) el.style.display = i === step ? "block" : "none";
  }
  // Update step indicators
  document.querySelectorAll("#wizard-steps .step").forEach(s => {
    const n = parseInt(s.dataset.step);
    s.classList.remove("active", "done");
    if (n === step) s.classList.add("active");
    if (n < step) s.classList.add("done");
  });
}

async function checkinStep1Next() {
  const dateVal = document.getElementById("checkin-date").value;
  if (!dateVal) { alert("Please pick a date."); return; }

  try {
    showLoading(true);
    // If no active checkin, create one
    if (!activeCheckin || !activeCheckin.id) {
      const data = await apiFetch("/checkins", { method: "POST", body: { checkin_date: dateVal } });
      activeCheckin = data.checkin || data;
      if (data.previous_values) {
        previousValues = {};
        (Array.isArray(data.previous_values) ? data.previous_values : []).forEach(pv => {
          previousValues[pv.account_id] = pv;
        });
      }
    }
    accounts = await apiFetch("/accounts");
    if (!Object.keys(previousValues).length) {
      await loadPreviousValues();
    }
    showLoading(false);
    setCheckinStep(2);
    renderCheckinAccounts();
  } catch (err) {
    showLoading(false);
    alert("Error: " + err.message);
  }
}

async function loadPreviousValues() {
  // Try to get previous values from the last submitted checkin
  try {
    const checkinsList = await apiFetch("/checkins");
    if (Array.isArray(checkinsList) && checkinsList.length > 0) {
      // Get the most recent submitted checkin
      const lastSubmitted = checkinsList[checkinsList.length - 1];
      if (lastSubmitted && lastSubmitted.id) {
        const detail = await apiFetch(`/checkins/${lastSubmitted.id}`);
        previousValues = {};
        const vals = detail.values || [];
        vals.forEach(v => {
          previousValues[v.account_id] = v;
        });
      }
    }
  } catch (e) {
    console.warn("Could not load previous values:", e);
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

function renderCheckinAccounts() {
  const container = document.getElementById("checkin-accounts-list");
  const grouped = groupAccounts(accounts);
  const currentValues = (activeCheckin && activeCheckin.values) || [];
  // Index current values by account_id
  const cvMap = {};
  currentValues.forEach(v => { cvMap[v.account_id] = v; });

  let html = "";

  const renderGroup = (label, accts) => {
    if (accts.length === 0) return "";
    let g = `<div class="checkin-account-group"><h5>${label}</h5>`;
    for (const a of accts) {
      const prev = previousValues[a.id];
      const cur = cvMap[a.id];
      const isLoan = isLoanType(a.account_type);
      const prevVal = prev ? prev.current_value : null;
      const prevOwed = prev ? prev.balance_owed : null;
      const curVal = cur ? cur.current_value : "";
      const curOwed = cur ? cur.balance_owed : "";

      g += `<div class="checkin-acct-card" data-account-id="${a.id}">
        <div class="checkin-acct-name">${a.name}</div>
        <div class="checkin-acct-type">${typeLabel(a.account_type)}</div>`;

      if (prev) {
        g += `<div class="checkin-acct-prev">Last: ${fmt(prevVal)}${isLoan && prevOwed != null ? ` | Owed: ${fmt(prevOwed)}` : ""}
          <button class="btn-use-prev" onclick="usePrevious('${a.id}')">Use Previous</button>
        </div>`;
      } else {
        g += `<div class="checkin-acct-prev">No previous value</div>`;
      }

      g += `<div class="checkin-acct-inputs">
        <div class="input-group">
          <label>${isLoan ? "Asset Value" : "Value"}</label>
          <input type="number" step="0.01" id="val-${a.id}" placeholder="0.00"
            value="${curVal !== null && curVal !== "" ? curVal : ""}"
            onchange="saveAccountValue('${a.id}')" />
        </div>`;

      if (isLoan) {
        g += `<div class="input-group">
          <label>Balance Owed</label>
          <input type="number" step="0.01" id="owed-${a.id}" placeholder="0.00"
            value="${curOwed !== null && curOwed !== "" ? curOwed : ""}"
            onchange="saveAccountValue('${a.id}')" />
        </div>`;
      }

      g += `</div>
        <span class="checkin-saved-indicator" id="saved-${a.id}">Saved</span>
      </div>`;
    }
    g += "</div>";
    return g;
  };

  html += renderGroup("Your Accounts", grouped.yours);
  html += renderGroup("Partner's Accounts", grouped.partner);
  html += renderGroup("Joint Accounts", grouped.joint);

  if (!grouped.yours.length && !grouped.partner.length && !grouped.joint.length) {
    html = '<div class="empty-state">No accounts yet. Add some in Step 3 or on the Accounts page.</div>';
  }

  container.innerHTML = html;
}

async function usePrevious(accountId) {
  const prev = previousValues[accountId];
  if (!prev) return;
  const valInput = document.getElementById(`val-${accountId}`);
  const owedInput = document.getElementById(`owed-${accountId}`);
  if (valInput && prev.current_value != null) valInput.value = prev.current_value;
  if (owedInput && prev.balance_owed != null) owedInput.value = prev.balance_owed;
  await saveAccountValue(accountId, "copied");
}

async function saveAccountValue(accountId, source = "manual") {
  if (!activeCheckin) return;
  const valInput = document.getElementById(`val-${accountId}`);
  const owedInput = document.getElementById(`owed-${accountId}`);
  const currentValue = valInput ? (valInput.value !== "" ? parseFloat(valInput.value) : null) : null;
  const balanceOwed = owedInput ? (owedInput.value !== "" ? parseFloat(owedInput.value) : null) : null;

  if (currentValue === null && balanceOwed === null) return;

  try {
    await apiFetch(`/checkins/${activeCheckin.id}/values/${accountId}`, {
      method: "PUT",
      body: { current_value: currentValue, balance_owed: balanceOwed, data_source: source },
    });
    // Show saved indicator
    const indicator = document.getElementById(`saved-${accountId}`);
    if (indicator) {
      indicator.classList.add("show");
      setTimeout(() => indicator.classList.remove("show"), 1500);
    }
  } catch (err) {
    console.error("Save error:", err);
  }
}

async function checkinStep3AddAccount() {
  const form = document.getElementById("checkin-new-account-form");
  const btn = document.getElementById("checkin-add-acct-btn");
  if (form.style.display === "none") {
    form.style.display = "block";
    btn.style.display = "none";
  }
}

async function saveNewAccountInCheckin() {
  const name = document.getElementById("new-acct-name").value.trim();
  const type = document.getElementById("new-acct-type").value;
  const owner = document.getElementById("new-acct-owner").value;

  if (!name) { alert("Please enter an account name."); return; }

  try {
    showLoading(true);
    const body = {
      name,
      account_type: type,
      owner_user_id: owner === "me" ? currentUser.id : null,
    };
    await apiFetch("/accounts", { method: "POST", body });
    // Reload accounts
    accounts = await apiFetch("/accounts");
    showLoading(false);
    // Reset form
    document.getElementById("new-acct-name").value = "";
    document.getElementById("checkin-new-account-form").style.display = "none";
    document.getElementById("checkin-add-acct-btn").style.display = "block";
    alert("Account added! You can enter its value when you go back to step 2 or in your next check-in.");
  } catch (err) {
    showLoading(false);
    alert("Error: " + err.message);
  }
}

function renderCheckinReview() {
  const container = document.getElementById("checkin-review-summary");
  const totalsEl = document.getElementById("checkin-review-totals");
  const grouped = groupAccounts(accounts);

  // Re-read values from inputs
  let totalAssets = 0;
  let totalLiabilities = 0;
  let html = "";
  let filledCount = 0;

  let totalAccounts = 0;
  const missingAccounts = [];

  const reviewGroup = (label, accts) => {
    if (accts.length === 0) return "";
    let g = `<div class="review-group"><h5>${label}</h5>`;
    for (const a of accts) {
      totalAccounts++;
      const valInput = document.getElementById(`val-${a.id}`);
      const owedInput = document.getElementById(`owed-${a.id}`);
      const val = valInput && valInput.value !== "" ? parseFloat(valInput.value) : null;
      const owed = owedInput && owedInput.value !== "" ? parseFloat(owedInput.value) : null;
      const isLoan = isLoanType(a.account_type);

      // An account is filled if it has a value, or for loans if it has balance_owed
      const isFilled = val != null || (isLoan && owed != null);
      if (!isFilled) missingAccounts.push(a.name);

      if (val != null) { totalAssets += val; filledCount++; }
      if (owed != null) { totalLiabilities += owed; }

      const rowClass = isFilled ? "" : "review-row-missing";
      g += `<div class="review-row ${rowClass}">
        <span class="review-row-name">${a.name}${!isFilled ? ' ⚠' : ''}</span>
        <span class="review-row-value">${val != null ? fmt(val) : "--"}${owed != null ? ` / Owed: ${fmt(owed)}` : ""}</span>
      </div>`;
    }
    g += "</div>";
    return g;
  };

  html += reviewGroup("Your Accounts", grouped.yours);
  html += reviewGroup("Partner's Accounts", grouped.partner);
  html += reviewGroup("Joint Accounts", grouped.joint);

  container.innerHTML = html;

  const netWorth = totalAssets - totalLiabilities;
  const submitBtn = document.getElementById("checkin-submit");

  if (missingAccounts.length > 0) {
    totalsEl.innerHTML = `
      <div class="review-warning">You must enter a value for every account before submitting.</div>
      <p class="muted">${missingAccounts.length} of ${totalAccounts} account(s) missing values</p>
    `;
    submitBtn.disabled = true;
  } else {
    totalsEl.innerHTML = `
      <p>Assets: <strong>${fmt(totalAssets)}</strong> | Liabilities: <strong>${fmt(totalLiabilities)}</strong></p>
      <p class="review-total-nw">${fmt(netWorth)}</p>
      <p class="muted">${filledCount} account(s) updated</p>
    `;
    submitBtn.disabled = false;
  }
}

async function submitCheckin() {
  if (!activeCheckin) return;
  try {
    showLoading(true);
    await apiFetch(`/checkins/${activeCheckin.id}/submit`, { method: "POST" });
    showLoading(false);
    activeCheckin = null;
    previousValues = {};
    alert("Check-in submitted!");
    showView("dashboard");
  } catch (err) {
    showLoading(false);
    alert("Error submitting: " + err.message);
  }
}

// ── Accounts Page ─────────────────────────────────────────────────────────────
async function loadAccounts() {
  const container = document.getElementById("accounts-list");
  container.innerHTML = '<div class="loading">Loading...</div>';
  try {
    accounts = await apiFetch("/accounts");
    renderAccountsList();
  } catch (err) {
    container.innerHTML = `<div class="error-banner">${err.message}</div>`;
  }
}

function renderAccountsList() {
  const container = document.getElementById("accounts-list");
  const grouped = groupAccounts(accounts);
  let html = "";

  const renderGroup = (label, accts) => {
    if (accts.length === 0) return "";
    let g = `<div class="account-group-label">${label}</div>`;
    for (const a of accts) {
      g += `<div class="account-card" onclick="openEditAccount('${a.id}')">
        <div class="account-card-info">
          <h5>${a.name}</h5>
          <span class="muted">${typeLabel(a.account_type)}</span>
        </div>
        <span class="account-card-arrow">&rsaquo;</span>
      </div>`;
    }
    return g;
  };

  html += renderGroup("Your Accounts", grouped.yours);
  html += renderGroup("Partner's Accounts", grouped.partner);
  html += renderGroup("Joint Accounts", grouped.joint);

  if (!html) {
    html = '<div class="empty-state">No accounts yet. Tap + Add to create one.</div>';
  }

  container.innerHTML = html;
}

let editingAccountId = null;

function openAddAccount() {
  editingAccountId = null;
  document.getElementById("account-dialog-title").textContent = "Add Account";
  document.getElementById("account-form").reset();
  document.getElementById("acct-deactivate-btn").style.display = "none";
  document.getElementById("loan-details-section").style.display = "none";
  document.getElementById("property-details-section").style.display = "none";
  document.getElementById("investment-details-section").style.display = "none";
  document.getElementById("acct-owed-col").style.display = "none";
  document.getElementById("acct-value-label").textContent = "Current Value";
  document.getElementById("initial-value-section").style.display = "block";
  document.getElementById("account-form-error").style.display = "none";
  // If partner exists, show partner option
  const ownerSelect = document.getElementById("acct-owner");
  if (coupleInfo && coupleInfo.members) {
    const partner = coupleInfo.members.find(m => m.user_id !== currentUser.id);
    if (partner) {
      ownerSelect.querySelector('[value="partner"]').textContent = `${partner.display_name || partner.username}'s (Personal)`;
    }
  }
  document.getElementById("account-dialog").showModal();
}

function openEditAccount(id) {
  const acct = accounts.find(a => a.id === id);
  if (!acct) return;
  editingAccountId = id;
  document.getElementById("account-dialog-title").textContent = "Edit Account";
  document.getElementById("acct-name").value = acct.name;
  document.getElementById("acct-type").value = acct.account_type;
  document.getElementById("acct-url").value = acct.url || "";
  document.getElementById("acct-notes").value = acct.notes || "";
  document.getElementById("account-form-error").style.display = "none";

  // Owner
  const ownerSelect = document.getElementById("acct-owner");
  if (!acct.owner_user_id) {
    ownerSelect.value = "joint";
  } else if (acct.owner_user_id === currentUser.id) {
    ownerSelect.value = "me";
  } else {
    ownerSelect.value = "partner";
  }

  // Hide initial value section when editing
  document.getElementById("initial-value-section").style.display = "none";

  // Type-specific details
  const isLoan = isLoanType(acct.account_type);
  const isProperty = isPropertyType(acct.account_type);
  const isInvestment = isInvestmentType(acct.account_type);
  document.getElementById("loan-details-section").style.display = isLoan ? "block" : "none";
  document.getElementById("property-details-section").style.display = isProperty ? "block" : "none";
  document.getElementById("investment-details-section").style.display = isInvestment ? "block" : "none";
  document.getElementById("acct-owed-col").style.display = "none";

  if (acct.loan_details) {
    document.getElementById("acct-loan-amount").value = acct.loan_details.original_loan_amount || "";
    document.getElementById("acct-loan-rate").value = acct.loan_details.interest_rate || "";
    document.getElementById("acct-loan-term").value = acct.loan_details.loan_term_months || "";
    document.getElementById("acct-loan-lender").value = acct.loan_details.lender_name || "";
  }

  document.getElementById("acct-deactivate-btn").style.display = "block";
  document.getElementById("account-dialog").showModal();
}

async function handleAccountSubmit(e) {
  e.preventDefault();
  const errEl = document.getElementById("account-form-error");
  errEl.style.display = "none";

  const ownerVal = document.getElementById("acct-owner").value;
  let ownerUserId = null;
  if (ownerVal === "me") ownerUserId = currentUser.id;
  else if (ownerVal === "partner" && coupleInfo && coupleInfo.members) {
    const partner = coupleInfo.members.find(m => m.user_id !== currentUser.id);
    ownerUserId = partner ? partner.user_id : null;
  }

  // Build notes from notes field + type-specific extras
  let notes = document.getElementById("acct-notes").value.trim() || "";
  const acctType = document.getElementById("acct-type").value;

  if (isPropertyType(acctType)) {
    const addr = document.getElementById("acct-property-address").value.trim();
    if (addr) notes = (notes ? notes + "\n" : "") + "Address: " + addr;
  }
  if (isInvestmentType(acctType)) {
    const brokerage = document.getElementById("acct-brokerage").value.trim();
    if (brokerage) notes = (notes ? notes + "\n" : "") + "Provider: " + brokerage;
  }

  const body = {
    name: document.getElementById("acct-name").value.trim(),
    account_type: acctType,
    owner_user_id: ownerUserId,
    url: document.getElementById("acct-url").value.trim() || null,
    notes: notes || null,
  };

  // Loan details
  if (isLoanType(body.account_type)) {
    body.original_loan_amount = parseFloat(document.getElementById("acct-loan-amount").value) || null;
    body.interest_rate = parseFloat(document.getElementById("acct-loan-rate").value) || null;
    body.loan_term_months = parseInt(document.getElementById("acct-loan-term").value) || null;
    body.lender_name = document.getElementById("acct-loan-lender").value.trim() || null;
  }

  // Initial value (only for new accounts)
  const initialValue = document.getElementById("acct-initial-value").value;
  const initialOwed = document.getElementById("acct-initial-owed").value;

  try {
    if (editingAccountId) {
      await apiFetch(`/accounts/${editingAccountId}`, { method: "PUT", body });
    } else {
      const created = await apiFetch("/accounts", { method: "POST", body });
      // If initial value provided and there's an active checkin, save it
      if (created && created.id && (initialValue || initialOwed)) {
        // Check for active checkin
        const active = await apiFetch("/checkins/active").catch(() => null);
        if (active && active.id) {
          await apiFetch(`/checkins/${active.id}/values/${created.id}`, {
            method: "PUT",
            body: {
              current_value: initialValue ? parseFloat(initialValue) : null,
              balance_owed: initialOwed ? parseFloat(initialOwed) : null,
              data_source: "manual",
            },
          }).catch(() => {});
        }
      }
    }
    document.getElementById("account-dialog").close();
    loadAccounts();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  }
}

async function deactivateAccount() {
  if (!editingAccountId) return;
  if (!confirm("Deactivate this account? It will be hidden from future check-ins.")) return;
  try {
    await apiFetch(`/accounts/${editingAccountId}`, { method: "DELETE" });
    document.getElementById("account-dialog").close();
    loadAccounts();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

// ── History Page ──────────────────────────────────────────────────────────────
async function loadHistory() {
  try {
    wealthHistory = await apiFetch("/wealth/history");
    if (!Array.isArray(wealthHistory)) wealthHistory = [];
    renderHistoryChart();
    renderHistoryTable();
  } catch (err) {
    console.error("History load error:", err);
  }
}

function renderHistoryChart() {
  const canvas = document.getElementById("nw-chart");
  if (nwChart) {
    nwChart.destroy();
    nwChart = null;
  }

  if (wealthHistory.length === 0) {
    return;
  }

  const labels = wealthHistory.map(h => fmtDate(h.checkin_date));
  const nwData = wealthHistory.map(h => h.net_worth || 0);
  const assetsData = wealthHistory.map(h => h.gross_assets || 0);
  const liabData = wealthHistory.map(h => h.total_liabilities || 0);

  nwChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Net Worth",
          data: nwData,
          borderColor: "#10b981",
          backgroundColor: "rgba(16, 185, 129, 0.1)",
          fill: true,
          tension: 0.3,
          pointRadius: 4,
        },
        {
          label: "Assets",
          data: assetsData,
          borderColor: "#34d399",
          borderDash: [5, 3],
          tension: 0.3,
          pointRadius: 2,
          fill: false,
        },
        {
          label: "Liabilities",
          data: liabData,
          borderColor: "#ef4444",
          borderDash: [5, 3],
          tension: 0.3,
          pointRadius: 2,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: "#9ca3af", font: { size: 11 } } },
      },
      scales: {
        x: { ticks: { color: "#6b7280", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } },
        y: {
          ticks: {
            color: "#6b7280",
            font: { size: 10 },
            callback: v => "$" + (v / 1000).toFixed(0) + "k",
          },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
      },
    },
  });
}

function renderHistoryTable() {
  const tbody = document.getElementById("history-tbody");
  if (wealthHistory.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state">No check-in history yet.</td></tr>';
    return;
  }

  let html = "";
  for (let i = wealthHistory.length - 1; i >= 0; i--) {
    const h = wealthHistory[i];
    const prev = i > 0 ? wealthHistory[i - 1] : null;
    const change = prev ? (h.net_worth || 0) - (prev.net_worth || 0) : null;
    const changeClass = change > 0 ? "change-positive" : change < 0 ? "change-negative" : "";
    const changeStr = change != null ? (change >= 0 ? "+" : "") + fmt(change) : "--";

    html += `<tr>
      <td>${fmtDate(h.checkin_date)}</td>
      <td>${fmt(h.net_worth)}</td>
      <td class="${changeClass}">${changeStr}</td>
    </tr>`;
  }
  tbody.innerHTML = html;
}

// ── Expenses Page ─────────────────────────────────────────────────────────────
let expenseGroups = [];
let currentExpenseGroup = null;

async function loadExpenses() {
  const container = document.getElementById("expense-groups-list");
  const detail = document.getElementById("expense-detail");
  detail.style.display = "none";
  container.style.display = "block";
  container.innerHTML = '<div class="loading">Loading...</div>';

  try {
    expenseGroups = await apiFetch("/expenses");
    if (!Array.isArray(expenseGroups)) expenseGroups = [];
    renderExpenseGroups();
  } catch (err) {
    container.innerHTML = `<div class="error-banner">${err.message}</div>`;
  }
}

function renderExpenseGroups() {
  const container = document.getElementById("expense-groups-list");
  if (expenseGroups.length === 0) {
    container.innerHTML = '<div class="empty-state">No expense groups yet. Create one to track large expenses.</div>';
    return;
  }

  container.innerHTML = expenseGroups.map(g => {
    const total = g.total || 0;
    return `<div class="expense-group-card" onclick="openExpenseGroup('${g.id}')">
      <h5>${g.name}</h5>
      <p class="muted">${g.description || "No description"}</p>
      <span class="expense-group-total">${fmt(total)}</span>
    </div>`;
  }).join("");
}

async function openExpenseGroup(id) {
  try {
    showLoading(true);
    currentExpenseGroup = await apiFetch(`/expenses/${id}`);
    showLoading(false);
    renderExpenseDetail();
  } catch (err) {
    showLoading(false);
    alert("Error: " + err.message);
  }
}

function renderExpenseDetail() {
  if (!currentExpenseGroup) return;
  document.getElementById("expense-groups-list").style.display = "none";
  document.getElementById("btn-add-expense-group").style.display = "none";
  const detail = document.getElementById("expense-detail");
  detail.style.display = "block";

  document.getElementById("expense-detail-name").textContent = currentExpenseGroup.name;
  document.getElementById("expense-detail-desc").textContent = currentExpenseGroup.description || "";

  const items = currentExpenseGroup.items || [];
  const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  document.getElementById("expense-detail-total").textContent = fmt(total);

  const list = document.getElementById("expense-items-list");
  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state">No items yet.</div>';
  } else {
    list.innerHTML = items.map(i => `<div class="expense-item-row">
      <div>
        <strong>${i.description}</strong>
        ${i.item_date ? `<span class="muted"> - ${fmtDate(i.item_date)}</span>` : ""}
      </div>
      <div>
        <span>${fmt(i.amount)}</span>
        <button class="expense-item-delete" onclick="deleteExpenseItem('${currentExpenseGroup.id}', '${i.id}')">&times;</button>
      </div>
    </div>`).join("");
  }
}

async function handleExpenseItemSubmit(e) {
  e.preventDefault();
  if (!currentExpenseGroup) return;
  const body = {
    description: document.getElementById("ei-desc").value.trim(),
    amount: parseFloat(document.getElementById("ei-amount").value),
    item_date: document.getElementById("ei-date").value || null,
  };
  if (!body.description || isNaN(body.amount)) return;

  try {
    showLoading(true);
    await apiFetch(`/expenses/${currentExpenseGroup.id}/items`, { method: "POST", body });
    currentExpenseGroup = await apiFetch(`/expenses/${currentExpenseGroup.id}`);
    showLoading(false);
    renderExpenseDetail();
    document.getElementById("expense-item-form").reset();
  } catch (err) {
    showLoading(false);
    alert("Error: " + err.message);
  }
}

async function deleteExpenseItem(groupId, itemId) {
  if (!confirm("Delete this item?")) return;
  try {
    await apiFetch(`/expenses/${groupId}/items/${itemId}`, { method: "DELETE" });
    currentExpenseGroup = await apiFetch(`/expenses/${groupId}`);
    renderExpenseDetail();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

function backToExpenseGroups() {
  currentExpenseGroup = null;
  document.getElementById("expense-detail").style.display = "none";
  document.getElementById("expense-groups-list").style.display = "block";
  document.getElementById("btn-add-expense-group").style.display = "inline-block";
}

async function handleExpenseGroupSubmit(e) {
  e.preventDefault();
  const errEl = document.getElementById("expense-group-error");
  errEl.style.display = "none";
  const body = {
    name: document.getElementById("eg-name").value.trim(),
    description: document.getElementById("eg-desc").value.trim() || null,
  };
  if (!body.name) return;

  try {
    await apiFetch("/expenses", { method: "POST", body });
    document.getElementById("expense-group-dialog").close();
    document.getElementById("expense-group-form").reset();
    loadExpenses();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  }
}

// ── Settings Page ─────────────────────────────────────────────────────────────
async function loadSettings() {
  document.getElementById("settings-display-name").textContent = currentUser?.display_name || "--";
  document.getElementById("settings-username").textContent = currentUser?.username || "--";

  // Couple info
  const coupleEl = document.getElementById("settings-couple-info");
  const inviteSection = document.getElementById("settings-invite-section");

  try {
    coupleInfo = await apiFetch("/couple").catch(() => null);
  } catch (e) { /* ignore */ }

  if (coupleInfo && coupleInfo.members) {
    const members = coupleInfo.members || [];
    const partner = members.find(m => m.user_id !== currentUser.id);
    coupleEl.innerHTML = partner
      ? `<p>Finances merged with <strong>${partner.display_name || partner.username}</strong></p>`
      : `<p>Tracking solo. Invite a partner below to merge finances!</p>`;
    inviteSection.style.display = partner ? "none" : "block";
  } else {
    coupleEl.innerHTML = "<p>Tracking solo. Invite a partner below to merge finances!</p>";
    inviteSection.style.display = "block";
  }

  // Pending invites
  await loadPendingInvites();
}

async function loadPendingInvites() {
  const container = document.getElementById("settings-pending-invites");
  try {
    const invites = await apiFetch("/couple/invites");
    if (!Array.isArray(invites) || invites.length === 0) {
      container.innerHTML = "";
      return;
    }
    container.innerHTML = "<h5 style='margin-top:1rem;'>Pending Invitations</h5>" +
      invites.filter(i => i.status === "pending").map(i => `
        <div class="invite-card">
          <span>From: <strong>${i.from_username || i.from_user_id}</strong></span>
          <div class="invite-actions">
            <button onclick="respondInvite('${i.id}', 'accept')" class="btn-sm">Accept</button>
            <button onclick="respondInvite('${i.id}', 'decline')" class="btn-sm btn-danger">Decline</button>
          </div>
        </div>
      `).join("");
  } catch (e) {
    container.innerHTML = "";
  }
}

async function respondInvite(id, action) {
  try {
    showLoading(true);
    await apiFetch(`/couple/invite/${id}/respond`, { method: "POST", body: { action } });
    showLoading(false);
    loadSettings();
  } catch (err) {
    showLoading(false);
    alert("Error: " + err.message);
  }
}

async function handleInvite(e) {
  e.preventDefault();
  const errEl = document.getElementById("invite-error");
  const sucEl = document.getElementById("invite-success");
  errEl.style.display = "none";
  sucEl.style.display = "none";

  const username = document.getElementById("invite-username").value.trim();
  if (!username) return;

  try {
    await apiFetch("/couple/invite", { method: "POST", body: { to_username: username } });
    sucEl.textContent = `Invitation sent to ${username}!`;
    sucEl.style.display = "block";
    document.getElementById("invite-username").value = "";
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  }
}

function logout() {
  clearToken();
  currentUser = null;
  coupleInfo = null;
  activeCheckin = null;
  previousValues = {};
  accounts = [];
  wealthHistory = [];
  showView("login");
}

// ── Account type change handler (show/hide loan fields) ───────────────────────
function isPropertyType(t) {
  return ["property_personal", "property_rental"].includes(t);
}

function isInvestmentType(t) {
  return ["401k", "investment"].includes(t);
}

function onAccountTypeChange() {
  const type = document.getElementById("acct-type").value;
  const isLoan = isLoanType(type);
  const isProperty = isPropertyType(type);
  const isInvestment = isInvestmentType(type);

  document.getElementById("loan-details-section").style.display = isLoan ? "block" : "none";
  document.getElementById("property-details-section").style.display = isProperty ? "block" : "none";
  document.getElementById("investment-details-section").style.display = isInvestment ? "block" : "none";
  document.getElementById("acct-owed-col").style.display = isLoan ? "block" : "none";

  // Update value label based on type
  const valLabel = document.getElementById("acct-value-label");
  if (isProperty) valLabel.textContent = "Estimated Value";
  else if (isLoan) valLabel.textContent = "Asset Value (optional)";
  else valLabel.textContent = "Current Value";
}

// ── Event Listeners ───────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Auth forms
  document.getElementById("login-form").addEventListener("submit", handleLogin);
  document.getElementById("register-form").addEventListener("submit", handleRegister);
  document.getElementById("show-register").addEventListener("click", e => { e.preventDefault(); showView("register"); });
  document.getElementById("show-login").addEventListener("click", e => { e.preventDefault(); showView("login"); });

  // Bottom nav
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });

  // Dashboard
  document.getElementById("btn-new-checkin").addEventListener("click", startNewCheckin);
  document.getElementById("btn-continue-checkin").addEventListener("click", continueCheckin);

  // Check-in wizard
  document.getElementById("checkin-back").addEventListener("click", () => {
    if (checkinStep > 1) {
      setCheckinStep(checkinStep - 1);
      if (checkinStep === 2) renderCheckinAccounts();
    } else {
      showView("dashboard");
    }
  });
  document.getElementById("checkin-step1-next").addEventListener("click", checkinStep1Next);
  document.getElementById("checkin-step2-next").addEventListener("click", () => {
    setCheckinStep(3);
  });
  document.getElementById("checkin-step3-next").addEventListener("click", () => {
    setCheckinStep(4);
    renderCheckinReview();
  });
  document.getElementById("checkin-add-acct-btn").addEventListener("click", checkinStep3AddAccount);
  document.getElementById("new-acct-save").addEventListener("click", saveNewAccountInCheckin);
  document.getElementById("checkin-submit").addEventListener("click", submitCheckin);

  // Accounts
  document.getElementById("btn-add-account").addEventListener("click", openAddAccount);
  document.getElementById("account-form").addEventListener("submit", handleAccountSubmit);
  document.getElementById("account-dialog-close").addEventListener("click", () => document.getElementById("account-dialog").close());
  document.getElementById("acct-deactivate-btn").addEventListener("click", deactivateAccount);
  document.getElementById("acct-type").addEventListener("change", onAccountTypeChange);

  // Expenses
  document.getElementById("btn-add-expense-group").addEventListener("click", () => document.getElementById("expense-group-dialog").showModal());
  document.getElementById("expense-group-dialog-close").addEventListener("click", () => document.getElementById("expense-group-dialog").close());
  document.getElementById("expense-group-form").addEventListener("submit", handleExpenseGroupSubmit);
  document.getElementById("expense-item-form").addEventListener("submit", handleExpenseItemSubmit);
  document.getElementById("expense-detail-back").addEventListener("click", backToExpenseGroups);

  // Settings
  document.getElementById("invite-form").addEventListener("submit", handleInvite);
  document.getElementById("btn-logout").addEventListener("click", logout);

  // Init: check if logged in
  if (isLoggedIn()) {
    showView("dashboard");
  } else {
    showView("login");
  }
});
