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
          <button class="outline delete-btn" data-uid="${esc(u.id)}" data-app="${esc(appName)}" data-username="${esc(u.username)}">Delete</button>
        </td>
      </tr>`;
    }
    html += "</tbody></table></div>";
    el.innerHTML = html;

    // Attach delete button handlers
    el.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => confirmDeleteUser(btn.dataset.uid, btn.dataset.app, btn.dataset.username));
    });
  } catch (err) {
    el.innerHTML = `<p class="error-text">Failed to load users: ${esc(err.message)}</p>`;
  }
}

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
