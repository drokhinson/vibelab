// app.js — {{PROJECT_TITLE}}
// All data comes from the shared backend API via fetch().
// API base URL is set in config.js as window.APP_CONFIG.apiBase

const API = window.APP_CONFIG?.apiBase ?? "http://localhost:8000";
const app = document.getElementById("app");

// A dead network rejects fetch() promptly; a STALLED one never settles, and no
// browser imposes a useful timeout — so an awaited first-paint call is a
// potential permanent hang. See .claude/rules/web-frontend.md.
const REQUEST_TIMEOUT_MS = 15000;

// ── State ─────────────────────────────────────────────────────────────────────
// loading / error / data are three separate branches, not two. Never let a
// failed load fall through to the empty state: it is wrong, it looks permanent,
// and it leaves the viewer no way to ask again short of relaunching.
let state = {
  loading: true,
  error: null,
  data: null
};

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiFetch(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    // The deadline stays armed through the body read — a socket can stall there
    // just as easily as during the handshake.
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  if (state.loading) {
    app.innerHTML = `
      <div class="loading-screen">
        <span class="loading loading-spinner loading-lg"></span>
      </div>`;
    return;
  }

  if (state.error) {
    app.innerHTML = `
      <div class="error-banner">
        <span>Couldn't load. ${state.error}</span>
      </div>
      <button class="btn btn-primary" onclick="retry()">Try again</button>`;
    return;
  }

  // TODO: replace with your app's actual render logic.
  app.innerHTML = `
    <article class="card-grid">
      <header><strong>{{PROJECT_TITLE}}</strong></header>
      <p>Replace this with your app UI. Data is loaded — check the console.</p>
      <pre>${JSON.stringify(state.data, null, 2)}</pre>
    </article>
  `;
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function load() {
  state.loading = true;
  state.error = null;
  render();
  try {
    // TODO: replace with your actual API call
    state.data = await apiFetch("/api/v1/{{PROJECT_ID}}/health");
  } catch (err) {
    state.error = err.name === "AbortError" ? "The request timed out." : err.message;
    console.error("Failed to load data:", err);
  }
  state.loading = false;
  render();
}

function retry() {
  load();
}

document.addEventListener("DOMContentLoaded", () => {
  // Owns theme changes from here on; index.html's inline boot set the initial
  // attribute before first paint.
  window.Theme.start();
  load();
  // Connectivity came back — a load that failed while offline should not need
  // the user to find the retry button.
  window.addEventListener("online", () => {
    if (state.error) load();
  });
});
