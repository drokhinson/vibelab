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
  document.body.classList.remove("dashboard-fullbleed");
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
  document.body.classList.add("dashboard-fullbleed");
  loadAllSections();
  setActiveTab(sessionStorage.getItem("admin_tab") || "api");
}

// ── Tab switching ────────────────────────────────────────────────────────────

function setActiveTab(name) {
  // Validate against the actual buttons so a stale sessionStorage value can't
  // leave every panel hidden.
  const known = [...document.querySelectorAll(".tab-btn")].map((b) => b.dataset.tab);
  const target = known.includes(name) ? name : known[0];
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === target);
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.classList.toggle("active", p.dataset.tab === target);
  });
  sessionStorage.setItem("admin_tab", target);
}

document.querySelector(".tab-bar").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (btn) setActiveTab(btn.dataset.tab);
});

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
  loadApiLogUsers();   // populate user filter dropdown
  loadApiLogs();       // initial load (default: last 5 min)
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

// id → log row, populated when the table renders so the body-viewer dialog
// can look up any rendered row.
const apiLogsCache = new Map();

// Two consecutive log rows collapse into one expanding row when these fields
// match. URL is compared without its query string so signed CDN URLs (each
// with a fresh signature) still group together.
function apiLogFingerprint(log) {
  const url = (log.url || "").split("?")[0];
  return [log.app, log.api_name, log.method, url, log.status_code ?? "x", log.user_id ?? "x"].join("|");
}

function groupConsecutiveLogs(logs) {
  const groups = [];
  let current = null;
  for (const log of logs) {
    const fp = apiLogFingerprint(log);
    if (current && current.fp === fp) {
      current.members.push(log);
    } else {
      current = { fp, members: [log] };
      groups.push(current);
    }
  }
  return groups;
}

function readApiLogFilters() {
  return {
    app:    document.getElementById("api-logs-app-filter").value,
    since:  document.getElementById("api-logs-since-filter").value,
    userId: document.getElementById("api-logs-user-filter").value,
  };
}

async function loadApiLogs() {
  const el = document.getElementById("api-logs-content");
  el.innerHTML = '<div class="loading">Loading logs...</div>';
  const { app, since, userId } = readApiLogFilters();
  const params = new URLSearchParams({ limit: "200" });
  if (app) params.set("app", app);
  if (since) params.set("since", since);
  if (userId) params.set("user_id", userId);
  try {
    const data = await apiFetch(`/api/v1/admin/api-logs?${params}`);
    const logs = data.logs || [];
    apiLogsCache.clear();
    for (const log of logs) apiLogsCache.set(String(log.id), log);
    populateApiLogsAppFilterFromLogs(logs);
    if (logs.length === 0) {
      el.innerHTML = "<p class='muted'>No calls match the current filters.</p>";
      return;
    }
    el.innerHTML = renderLogTable(logs);
    wireLogTableHandlers(el);
  } catch (err) {
    el.innerHTML = `<p class="error-text">Failed to load logs: ${esc(err.message)}</p>`;
  }
}

async function loadApiLogUsers() {
  try {
    const data = await apiFetch("/api/v1/admin/api-logs/users");
    const users = data.users || [];
    const select = document.getElementById("api-logs-user-filter");
    const current = select.value;
    // Reset to "All users" + any users we just fetched.
    select.innerHTML = '<option value="">All users</option>';
    for (const u of users) {
      const opt = document.createElement("option");
      opt.value = u.user_id;
      opt.textContent = u.user_label || u.user_id;
      select.appendChild(opt);
    }
    if ([...select.options].some((o) => o.value === current)) select.value = current;
  } catch {
    // dropdown stays at "All users" — non-fatal
  }
}

function renderLogTable(logs) {
  const groups = groupConsecutiveLogs(logs);
  let html = `<div class="table-responsive"><table>
    <thead><tr>
      <th></th>
      <th>Time</th><th>App</th><th>User</th><th>API</th><th>Method</th><th>URL</th>
      <th>Status</th><th>Latency</th><th>Size</th><th>Error</th>
    </tr></thead><tbody>`;
  groups.forEach((group, gi) => {
    html += renderLogGroup(group, gi);
  });
  html += "</tbody></table></div>";
  return html;
}

function wireLogTableHandlers(scope) {
  scope.querySelectorAll("tr[data-id]").forEach((row) => {
    row.addEventListener("click", (ev) => {
      if (ev.target.closest(".api-log-toggle")) return;
      openApiLogDialog(row.dataset.id);
    });
  });
  scope.querySelectorAll(".api-log-toggle").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const gi = btn.dataset.gi;
      const expanded = btn.classList.toggle("expanded");
      scope.querySelectorAll(`tr.api-log-child[data-gi="${gi}"]`).forEach((row) => {
        row.style.display = expanded ? "" : "none";
      });
    });
  });
}

function populateApiLogsAppFilterFromLogs(logs) {
  const select = document.getElementById("api-logs-app-filter");
  const current = select.value;
  const apps = Array.from(new Set(logs.map((l) => l.app).filter(Boolean))).sort();
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

function renderLogGroup(group, gi) {
  const lead = group.members[0]; // newest in the group (input is sorted desc)
  const count = group.members.length;
  const status = lead.status_code;
  const cls = !status ? "api-log-status-err"
            : status >= 500 ? "api-log-status-err"
            : status >= 400 ? "api-log-status-warn"
            : "api-log-status-ok";
  const url = lead.url ? (lead.url.length > 60 ? lead.url.slice(0, 60) + "…" : lead.url) : "—";

  if (count === 1) {
    return renderLogRow(lead, { toggleCell: '<td></td>' });
  }

  // Aggregate metrics across the group for the summary row.
  const latencies = group.members.map((m) => m.response_time_ms).filter((v) => v != null);
  const sizes = group.members.map((m) => m.response_size_bytes).filter((v) => v != null);
  const errors = group.members.filter((m) => m.error_message).length;
  const latencyLabel = latencies.length
    ? (Math.min(...latencies) === Math.max(...latencies)
        ? `${latencies[0]} ms`
        : `${Math.min(...latencies)}–${Math.max(...latencies)} ms`)
    : "—";
  const totalSize = sizes.reduce((a, b) => a + b, 0);
  const sizeLabel = sizes.length ? formatBytes(totalSize) : "—";
  const when = lead.sent_at ? new Date(lead.sent_at).toLocaleString() : "—";
  const errLabel = errors > 0 ? `${errors}/${count} failed` : "";

  const userLabel = lead.user_label || lead.user_id || "anonymous";
  const summaryRow = `<tr class="api-log-row api-log-summary" data-gi="${gi}">
    <td><button class="api-log-toggle" data-gi="${gi}" aria-label="Expand"><span class="chev">▸</span></button></td>
    <td>${esc(when)}</td>
    <td>${esc(lead.app)}</td>
    <td>${esc(userLabel)}</td>
    <td>${esc(lead.api_name)} <span class="api-log-count">×${count}</span></td>
    <td>${esc(lead.method)}</td>
    <td title="${esc(lead.url)}">${esc(url)}</td>
    <td class="${cls}">${status ?? "—"}</td>
    <td>${latencyLabel}</td>
    <td>${sizeLabel}</td>
    <td class="api-log-status-err">${esc(errLabel)}</td>
  </tr>`;

  const childRows = group.members.map((m) =>
    renderLogRow(m, { toggleCell: '<td></td>', extraClass: "api-log-child", gi })
  ).join("");

  return summaryRow + childRows;
}

function renderLogRow(r, { toggleCell = "", extraClass = "", gi = null } = {}) {
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
  const giAttr = gi != null ? ` data-gi="${gi}"` : "";
  const styleAttr = extraClass.includes("api-log-child") ? ' style="display:none;"' : "";
  const userLabel = r.user_label || r.user_id || "anonymous";
  return `<tr class="api-log-row ${extraClass}" data-id="${r.id}"${giAttr}${styleAttr}>
    ${toggleCell}
    <td>${esc(when)}</td>
    <td>${esc(r.app)}</td>
    <td>${esc(userLabel)}</td>
    <td>${esc(r.api_name)}</td>
    <td>${esc(r.method)}</td>
    <td title="${esc(r.url)}">${esc(url)}</td>
    <td class="${cls}">${status ?? "—"}</td>
    <td>${latency}</td>
    <td>${size}</td>
    <td class="api-log-status-err">${err}</td>
  </tr>`;
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
  const r = apiLogsCache.get(String(id));
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

["api-logs-app-filter", "api-logs-since-filter", "api-logs-user-filter"].forEach((id) => {
  document.getElementById(id).addEventListener("change", () => loadApiLogs());
});

document.getElementById("api-logs-refresh-btn").addEventListener("click", () => {
  loadApiLogs();
  loadApiLogsSummary();
});

let _clearStatusTimer = null;
function showClearStatus(message, isError) {
  const el = document.getElementById("api-logs-clear-status");
  if (!el) return;
  el.textContent = message;
  el.style.display = "";
  el.classList.toggle("error-text", !!isError);
  if (_clearStatusTimer) clearTimeout(_clearStatusTimer);
  _clearStatusTimer = setTimeout(() => {
    el.style.display = "none";
    el.classList.remove("error-text");
  }, 2500);
}

document.querySelectorAll(".clear-bodies-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const age = btn.dataset.age;
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
    try {
      const data = await apiFetch(`/api/v1/admin/api-logs/clear-bodies?older_than=${encodeURIComponent(age)}`, {
        method: "POST",
      });
      showClearStatus(`Cleared ${data.cleared} response body${data.cleared === 1 ? "" : "(ies)"}.`, false);
      loadApiLogs();
      loadApiLogsSummary();
    } catch (err) {
      showClearStatus("Clear failed: " + err.message, true);
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
