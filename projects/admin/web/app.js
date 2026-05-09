// app.js — Vibelab Admin Dashboard
// All data comes from the shared backend API via fetch().
// API base URL is set in config.js as window.APP_CONFIG.apiBase

const API = window.APP_CONFIG?.apiBase ?? "http://localhost:8000";

// ── Auth ─────────────────────────────────────────────────────────────────────

function getAdminKey() { return sessionStorage.getItem("admin_key"); }
function setAdminKey(k) { sessionStorage.setItem("admin_key", k); }
function clearAdminKey() { sessionStorage.removeItem("admin_key"); }

// ── API helper ───────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...opts.headers };
  const key = getAdminKey();
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const res = await fetch(`${API}${path}`, { ...opts, headers });
  if (res.status === 401 || res.status === 403) {
    clearAdminKey();
    showLogin("Session expired or invalid key.");
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── View toggling ────────────────────────────────────────────────────────────

function showLogin(errorMsg) {
  document.getElementById("view-login").style.display = "";
  document.getElementById("view-dashboard").style.display = "none";
  document.getElementById("logout-btn").style.display = "none";
  const errEl = document.getElementById("login-error");
  if (errorMsg) {
    errEl.textContent = errorMsg;
    errEl.style.display = "";
  } else {
    errEl.style.display = "none";
  }
}

function showDashboard() {
  document.getElementById("view-login").style.display = "none";
  document.getElementById("view-dashboard").style.display = "";
  document.getElementById("logout-btn").style.display = "";
  loadAllSections();
}

// ── Login ────────────────────────────────────────────────────────────────────

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = document.getElementById("admin-key").value.trim();
  if (!key) return;
  setAdminKey(key);
  try {
    await apiFetch("/api/v1/admin/health");
    showDashboard();
  } catch {
    clearAdminKey();
    showLogin("Invalid admin key.");
  }
});

document.getElementById("logout-btn").addEventListener("click", (e) => {
  e.preventDefault();
  clearAdminKey();
  showLogin();
});

// ── Dashboard sections ───────────────────────────────────────────────────────

async function loadAllSections() {
  loadUsage();
  loadAppsWithUsers();
  loadStorage();
  loadApiLogs();
  loadApiLogsSummary();
}

// --- Section 1: App Usage ---

async function loadUsage() {
  const el = document.getElementById("usage-content");
  el.innerHTML = '<div class="loading">Loading usage data...</div>';
  try {
    const data = await apiFetch("/api/v1/analytics/summary");
    const apps = data.apps || {};
    const names = Object.keys(apps);
    if (names.length === 0) {
      el.innerHTML = "<p class='muted'>No usage data yet.</p>";
      return;
    }
    let html = `<div class="table-responsive"><table>
      <thead><tr><th>App</th><th>24h</th><th>7d</th><th>30d</th><th>All Time</th></tr></thead><tbody>`;
    for (const name of names.sort()) {
      const a = apps[name];
      html += `<tr>
        <td><strong>${esc(name)}</strong></td>
        <td>${a.last_24h}</td><td>${a.last_7d}</td><td>${a.last_30d}</td><td>${a.all_time}</td>
      </tr>`;
    }
    html += "</tbody></table></div>";
    el.innerHTML = html;
  } catch (err) {
    el.innerHTML = `<p class="error-text">Failed to load usage: ${esc(err.message)}</p>`;
  }
}

// --- Section 2: User Management ---

async function loadAppsWithUsers() {
  try {
    const data = await apiFetch("/api/v1/admin/apps-with-users");
    const select = document.getElementById("user-app-select");
    select.innerHTML = '<option value="">Select app...</option>';
    for (const app of data.apps || []) {
      const opt = document.createElement("option");
      opt.value = app;
      opt.textContent = app;
      select.appendChild(opt);
    }
  } catch {
    // silently fail — the dropdown just stays empty
  }
}

document.getElementById("user-app-select").addEventListener("change", (e) => {
  const app = e.target.value;
  if (app) loadUsers(app);
  else document.getElementById("users-content").innerHTML = "<p class='muted'>Select an app to view users.</p>";
});

async function loadUsers(appName) {
  const el = document.getElementById("users-content");
  el.innerHTML = '<div class="loading">Loading users...</div>';
  try {
    const data = await apiFetch(`/api/v1/admin/users?app=${encodeURIComponent(appName)}`);
    const users = data.users || [];
    if (users.length === 0) {
      el.innerHTML = "<p class='muted'>No users found.</p>";
      return;
    }
    let html = `<div class="table-responsive"><table>
      <thead><tr><th>Username</th><th>Display Name</th><th>Email</th><th>Created</th><th>Actions</th></tr></thead><tbody>`;
    for (const u of users) {
      const created = u.created_at ? new Date(u.created_at).toLocaleDateString() : "—";
      html += `<tr>
        <td>${esc(u.username)}</td>
        <td>${esc(u.display_name || "—")}</td>
        <td>${esc(u.email || "—")}</td>
        <td>${created}</td>
        <td>
          <button class="outline secondary reset-btn" data-uid="${esc(u.id)}" data-app="${esc(appName)}">Reset Code</button>
          <button class="outline delete-btn" data-uid="${esc(u.id)}" data-app="${esc(appName)}" data-username="${esc(u.username)}">Delete</button>
        </td>
      </tr>`;
    }
    html += "</tbody></table></div>";
    el.innerHTML = html;

    // Attach reset button handlers
    el.querySelectorAll(".reset-btn").forEach((btn) => {
      btn.addEventListener("click", () => generateResetCode(btn.dataset.uid, btn.dataset.app, btn));
    });

    // Attach delete button handlers
    el.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => confirmDeleteUser(btn.dataset.uid, btn.dataset.app, btn.dataset.username));
    });
  } catch (err) {
    el.innerHTML = `<p class="error-text">Failed to load users: ${esc(err.message)}</p>`;
  }
}

async function generateResetCode(userId, appName, btn) {
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;
  try {
    const data = await apiFetch(`/api/v1/admin/users/${userId}/reset-code?app=${encodeURIComponent(appName)}`, {
      method: "POST",
    });
    document.getElementById("reset-code-display").textContent = data.recovery_code;
    document.getElementById("reset-dialog").showModal();
  } catch (err) {
    alert("Failed to generate reset code: " + err.message);
  } finally {
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
  }
}

document.getElementById("reset-dialog-close").addEventListener("click", () => {
  document.getElementById("reset-dialog").close();
});

// --- Delete user ---

let pendingDelete = null;

function confirmDeleteUser(userId, appName, username) {
  pendingDelete = { userId, appName };
  document.getElementById("delete-username").textContent = username;
  document.getElementById("delete-app").textContent = appName;
  document.getElementById("delete-error").style.display = "none";
  document.getElementById("delete-dialog").showModal();
}

document.getElementById("delete-confirm-btn").addEventListener("click", async () => {
  if (!pendingDelete) return;
  const btn = document.getElementById("delete-confirm-btn");
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;
  document.getElementById("delete-error").style.display = "none";
  try {
    await apiFetch(`/api/v1/admin/users/${pendingDelete.userId}?app=${encodeURIComponent(pendingDelete.appName)}`, {
      method: "DELETE",
    });
    document.getElementById("delete-dialog").close();
    // Reload the user list
    loadUsers(pendingDelete.appName);
    pendingDelete = null;
  } catch (err) {
    document.getElementById("delete-error").textContent = "Failed to delete: " + err.message;
    document.getElementById("delete-error").style.display = "";
  } finally {
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
  }
});

document.getElementById("delete-cancel-btn").addEventListener("click", () => {
  pendingDelete = null;
  document.getElementById("delete-dialog").close();
});

// --- Section 3: Database Storage ---

async function loadStorage() {
  const el = document.getElementById("storage-content");
  el.innerHTML = '<div class="loading">Loading storage data...</div>';
  try {
    const data = await apiFetch("/api/v1/admin/storage");
    const apps = data.apps || {};
    const names = Object.keys(apps);
    if (names.length === 0) {
      el.innerHTML = "<p class='muted'>No tables found.</p>";
      return;
    }

    // Sort by total size descending
    names.sort((a, b) => (apps[b].total_bytes || 0) - (apps[a].total_bytes || 0));
    const maxBytes = Math.max(...names.map((n) => apps[n].total_bytes || 1));

    let html = "";
    for (const name of names) {
      const app = apps[name];
      const pct = Math.max(2, Math.round((app.total_bytes / maxBytes) * 100));
      html += `<details class="storage-app">
        <summary>
          <div class="storage-row">
            <span class="storage-name">${esc(name)}</span>
            <span class="storage-size">${formatBytes(app.total_bytes)}</span>
          </div>
          <div class="storage-bar-bg"><div class="storage-bar" style="width:${pct}%"></div></div>
        </summary>
        <div class="table-responsive"><table>
          <thead><tr><th>Table</th><th>Size</th><th>Rows (est.)</th></tr></thead><tbody>`;
      for (const t of app.tables || []) {
        html += `<tr>
          <td>${esc(t.table_name)}</td>
          <td>${formatBytes(t.total_bytes)}</td>
          <td>${t.row_estimate.toLocaleString()}</td>
        </tr>`;
      }
      html += "</tbody></table></div></details>";
    }
    el.innerHTML = html;
  } catch (err) {
    el.innerHTML = `<p class="error-text">Failed to load storage: ${esc(err.message)}</p>`;
  }
}

// --- Section 4: External API Logs ---

let apiLogsCache = [];

async function loadApiLogs() {
  const el = document.getElementById("api-logs-content");
  el.innerHTML = '<div class="loading">Loading logs...</div>';
  const appFilter = document.getElementById("api-logs-app-filter").value;
  const qs = appFilter ? `?app=${encodeURIComponent(appFilter)}&limit=200` : "?limit=200";
  try {
    const data = await apiFetch(`/api/v1/admin/api-logs${qs}`);
    const logs = data.logs || [];
    apiLogsCache = logs;
    populateApiLogsAppFilter(logs);
    if (logs.length === 0) {
      el.innerHTML = "<p class='muted'>No API calls logged yet.</p>";
      return;
    }
    let html = `<div class="table-responsive"><table>
      <thead><tr>
        <th>Time</th><th>App</th><th>API</th><th>Method</th><th>URL</th>
        <th>Status</th><th>Latency</th><th>Size</th><th>Error</th>
      </tr></thead><tbody>`;
    for (const r of logs) {
      const status = r.status_code;
      const cls = !status ? "api-log-status-err"
                : status >= 500 ? "api-log-status-err"
                : status >= 400 ? "api-log-status-warn"
                : "api-log-status-ok";
      const when = r.sent_at ? new Date(r.sent_at).toLocaleString() : "—";
      const url = r.url ? (r.url.length > 60 ? r.url.slice(0, 60) + "…" : r.url) : "—";
      const latency = r.response_time_ms != null ? `${r.response_time_ms} ms` : "—";
      const size = r.response_size_bytes != null ? formatBytes(r.response_size_bytes) : "—";
      const err = r.error_message ? esc(r.error_message.slice(0, 60)) : "";
      html += `<tr class="api-log-row" data-id="${r.id}">
        <td>${esc(when)}</td>
        <td>${esc(r.app)}</td>
        <td>${esc(r.api_name)}</td>
        <td>${esc(r.method)}</td>
        <td title="${esc(r.url)}">${esc(url)}</td>
        <td class="${cls}">${status ?? "—"}</td>
        <td>${latency}</td>
        <td>${size}</td>
        <td class="api-log-status-err">${err}</td>
      </tr>`;
    }
    html += "</tbody></table></div>";
    el.innerHTML = html;
    el.querySelectorAll(".api-log-row").forEach((row) => {
      row.addEventListener("click", () => openApiLogDialog(row.dataset.id));
    });
  } catch (err) {
    el.innerHTML = `<p class="error-text">Failed to load logs: ${esc(err.message)}</p>`;
  }
}

function populateApiLogsAppFilter(logs) {
  const select = document.getElementById("api-logs-app-filter");
  const current = select.value;
  const apps = Array.from(new Set(logs.map((l) => l.app).filter(Boolean))).sort();
  // Preserve any apps already in the dropdown so the option set is stable across reloads.
  for (const app of apps) {
    if (![...select.options].some((o) => o.value === app)) {
      const opt = document.createElement("option");
      opt.value = app;
      opt.textContent = app;
      select.appendChild(opt);
    }
  }
  select.value = current;
}

async function loadApiLogsSummary() {
  const el = document.getElementById("api-logs-summary");
  try {
    const data = await apiFetch("/api/v1/admin/api-logs/summary");
    const rows = data.summary || [];
    if (rows.length === 0) {
      el.innerHTML = "<span class='muted'>No calls in the last 30 days.</span>";
      return;
    }
    el.innerHTML = rows.map((r) => {
      const errBadge = r.errors > 0 ? ` <span class="err">${r.errors} err</span>` : "";
      return `<span class="api-log-summary-pill">
        <strong>${esc(r.app)} / ${esc(r.api_name)}</strong>
        ${r.calls} calls · ${formatBytes(r.bytes)}${errBadge}
      </span>`;
    }).join("");
  } catch (err) {
    el.innerHTML = `<span class="error-text">Summary failed: ${esc(err.message)}</span>`;
  }
}

function openApiLogDialog(id) {
  const r = apiLogsCache.find((x) => String(x.id) === String(id));
  if (!r) return;
  document.getElementById("api-log-dialog-title").textContent = `${r.method} ${r.api_name}`;
  const meta = [
    `app: ${r.app}`,
    `status: ${r.status_code ?? "—"}`,
    `latency: ${r.response_time_ms ?? "—"} ms`,
    `size: ${r.response_size_bytes != null ? formatBytes(r.response_size_bytes) : "—"}`,
    `sent: ${r.sent_at ? new Date(r.sent_at).toLocaleString() : "—"}`,
  ].join(" · ");
  document.getElementById("api-log-dialog-meta").textContent = meta;
  const parts = [];
  parts.push(`URL:\n${r.url}`);
  if (r.request_params) parts.push(`\nParams:\n${JSON.stringify(r.request_params, null, 2)}`);
  if (r.error_message) parts.push(`\nError:\n${r.error_message}`);
  parts.push(`\nResponse body${r.body_excerpt ? " (truncated to 8KB)" : " (cleared)"}:\n${r.body_excerpt ?? "(empty)"}`);
  document.getElementById("api-log-dialog-body").textContent = parts.join("\n");
  document.getElementById("api-log-dialog").showModal();
}

document.getElementById("api-log-dialog-close").addEventListener("click", () => {
  document.getElementById("api-log-dialog").close();
});

document.getElementById("api-logs-app-filter").addEventListener("change", () => {
  loadApiLogs();
});

document.querySelectorAll(".clear-bodies-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const age = btn.dataset.age;
    const label = btn.textContent.trim();
    if (!confirm(`Clear stored response bodies: ${label}? Timing/error stats are preserved.`)) return;
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
    try {
      const data = await apiFetch(`/api/v1/admin/api-logs/clear-bodies?older_than=${encodeURIComponent(age)}`, {
        method: "POST",
      });
      alert(`Cleared ${data.cleared} response body(ies).`);
      loadApiLogs();
      loadApiLogsSummary();
    } catch (err) {
      alert("Clear failed: " + err.message);
    } finally {
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
    }
  });
});

// ── Utilities ────────────────────────────────────────────────────────────────

function esc(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

// ── Init ─────────────────────────────────────────────────────────────────────

(function init() {
  if (getAdminKey()) {
    // Verify key is still valid
    apiFetch("/api/v1/admin/health")
      .then(() => showDashboard())
      .catch(() => showLogin());
  } else {
    showLogin();
  }
})();
