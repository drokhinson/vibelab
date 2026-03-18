'use strict';

// ── Auth token ────────────────────────────────────────────────────────────────
function getToken() { return localStorage.getItem('dwp_token'); }
function setToken(t) { localStorage.setItem('dwp_token', t); }
function clearToken() { localStorage.removeItem('dwp_token'); }

function getStoredActiveGroup() { return localStorage.getItem('dwp_active_group'); }
function setStoredActiveGroup(id) { localStorage.setItem('dwp_active_group', id); }

// ── API Fetch ─────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API}${BASE}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    clearToken();
    currentUser = null;
    renderApp();
    throw new Error('Session expired. Please log in again.');
  }
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

// ── View navigation ───────────────────────────────────────────────────────────
function showView(view) {
  currentView = view;
  renderApp();
}

// ── Date formatting ───────────────────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// ── SVG icons ─────────────────────────────────────────────────────────────────
const icons = {
  person: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  bookmark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`,
  bookmarkFill: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`,
  heart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
  share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  grid: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
  trophy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 21 12 17 16 21"/><line x1="12" y1="17" x2="12" y2="11"/><path d="M7 4H4a1 1 0 0 0-1 1v3a4 4 0 0 0 4 4h1"/><path d="M17 4h3a1 1 0 0 1 1 1v3a4 4 0 0 1-4 4h-1"/><rect x="7" y="2" width="10" height="9" rx="1"/></svg>`,
  users: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  book: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  volume: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
  chevronRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
  thumbsUp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
};

// ── Render helpers ────────────────────────────────────────────────────────────
function renderError(msg) {
  return `<div class="error-banner">${msg}</div>`;
}

function renderSuccess(msg) {
  return `<div class="success-banner">${msg}</div>`;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Main render orchestrator ──────────────────────────────────────────────────
function renderApp() {
  const root = document.getElementById('root');
  if (!root) return;

  if (!currentUser) {
    root.innerHTML = renderAuthScreen();
    return;
  }

  root.innerHTML = renderShell();
  updateTabBar();
}

function renderShell() {
  return `
    <div id="app-shell">
      ${renderTopHeader()}
      <div class="page-content" id="page-content">
        ${renderCurrentPage()}
      </div>
      ${renderTabBar()}
    </div>
  `;
}

function renderTopHeader() {
  return `
    <div class="top-header">
      <span class="app-title">Day WordPlay</span>
      <div class="header-right">
        <button class="avatar-btn" id="profile-btn" aria-label="Settings">
          ${icons.settings}
        </button>
      </div>
    </div>
  `;
}

function renderTabBar() {
  const isDict = currentView === 'dictionary';
  const isVote = currentView === 'vote';
  const isLb = currentView === 'leaderboard';
  const wordActive = currentView === 'home' || isVote;

  return `
    <div class="tab-bar">
      <button class="tab-btn ${isDict ? 'active' : ''}" id="tab-dict">
        ${icons.bookmark}
        <span>Dictionary</span>
      </button>
      <button class="tab-btn tab-center ${wordActive ? 'active' : ''}" id="tab-word">
        ${icons.book}
        <span>Word</span>
      </button>
      <button class="tab-btn ${isLb ? 'active' : ''}" id="tab-stats">
        ${icons.trophy}
        <span>Stats</span>
      </button>
    </div>
  `;
}

function updateTabBar() {
  const wordActive = currentView === 'home' || currentView === 'vote';
  document.getElementById('tab-word')?.classList.toggle('active', wordActive);
  document.getElementById('tab-dict')?.classList.toggle('active', currentView === 'dictionary');
  document.getElementById('tab-stats')?.classList.toggle('active', currentView === 'leaderboard');
}

function renderPageContent() {
  const content = document.getElementById('page-content');
  if (content) content.innerHTML = renderCurrentPage();
}

function renderCurrentPage() {
  switch (currentView) {
    case 'home': return renderHomeView();
    case 'vote': return renderVoteView();
    case 'dictionary': return renderDictionaryView();
    case 'leaderboard': return renderLeaderboardView();
    case 'profile': return renderProfileView();
    default: return renderHomeView();
  }
}
