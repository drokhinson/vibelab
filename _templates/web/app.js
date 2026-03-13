// app.js — {{PROJECT_TITLE}}
// All data comes from the shared backend API via fetch().
// API base URL is set in config.js as window.APP_CONFIG.apiBase

const API = window.APP_CONFIG?.apiBase ?? "http://localhost:8000";
const app = document.getElementById("app");

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  loading: true,
  error: null,
  data: null
};

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  if (state.loading) {
    app.innerHTML = `<div class="loading">Loading…</div>`;
    return;
  }
  if (state.error) {
    app.innerHTML = `<div class="error-banner">⚠ ${state.error}</div>`;
    return;
  }
  // TODO: replace with your app's actual render logic
  app.innerHTML = `
    <article>
      <header><strong>{{PROJECT_TITLE}}</strong></header>
      <p>Replace this with your app UI. Data is loaded — check the console.</p>
      <pre>${JSON.stringify(state.data, null, 2)}</pre>
    </article>
  `;
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    // TODO: replace with your actual API call
    state.data = await apiFetch("/api/v1/{{PROJECT_ID}}/health");
    state.loading = false;
  } catch (err) {
    state.error = err.message;
    state.loading = false;
    console.error("Failed to load data:", err);
  }
  render();
}

init();
