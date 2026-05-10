'use strict';
// @ts-check
//
// Bottom-bar tab navigation for the saucebook redesign. Three tabs:
//   • browse    — read-only listing of all sauces; available to anon users
//   • saucebook — current user's library; locked for anon
//   • pantry    — current user's missing-ingredient list; locked for anon
//
// The nav lives in #bottom-nav (rendered into a fixed slot in index.html, so
// it persists across screen renders). `setActiveTab` is the single entry
// point for tab changes — it gates the locked tabs on `currentUser` and
// opens the auth modal instead of switching when the user is anonymous.

const TAB_DEFS = [
  { id: 'browse',    label: 'Browse',    icon: 'compass',   requiresAuth: false },
  { id: 'saucebook', label: 'Saucebook', icon: 'book-open', requiresAuth: true  },
  { id: 'pantry',    label: 'Pantry',    icon: 'archive',   requiresAuth: true  },
];

function renderBottomNav() {
  const nav = document.getElementById('bottom-nav');
  if (!nav) return;
  const tabs = TAB_DEFS.map(t => {
    const locked = t.requiresAuth && !currentUser;
    const active = state.activeTab === t.id;
    return `
      <button
        class="btm-nav-btn ${active ? 'btm-nav-btn--active' : ''} ${locked ? 'btm-nav-btn--locked' : ''}"
        data-tab="${t.id}"
        aria-label="${t.label}${locked ? ' (sign in required)' : ''}"
        aria-current="${active ? 'page' : 'false'}"
      >
        <span class="btm-nav-icon-wrap">
          <i data-lucide="${t.icon}"></i>
          ${locked ? '<span class="btm-nav-lock"><i data-lucide="lock"></i></span>' : ''}
        </span>
        <span class="btm-nav-label">${t.label}</span>
      </button>
    `;
  }).join('');
  nav.innerHTML = `<div class="btm-nav-row">${tabs}</div>`;
  if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
}

function setActiveTab(name, opts = {}) {
  const def = TAB_DEFS.find(t => t.id === name);
  if (!def) return;
  if (def.requiresAuth && !currentUser) {
    if (typeof openAuthModal === 'function') openAuthModal();
    return;
  }
  state.activeTab = name;
  // Tabs always render via the tab-shell screen; if a per-screen flow was
  // open (meal-builder, recipe view, etc.), tapping a tab returns the user
  // to the tab content.
  state.screen = 'tab-shell';
  if (!opts.silent) {
    history.replaceState({ screen: 'tab-shell', tab: name, sb: true }, '', '#' + name);
  }
  // Browse needs an explicit kick the first time the user lands on it (the
  // tab is loaded only on demand to avoid hitting the API on every page
  // load). The fetch is a no-op if the items list is already populated.
  if (name === 'browse' && typeof browseEnsureLoaded === 'function') {
    browseEnsureLoaded();
  }
  // Pantry groups by ingredient.category, which migration 015 folds into
  // each row of the /pantry response — no separate /ingredient-categories
  // fetch needed on the pantry path. The recipe-builder lazy-load
  // (ensureBuilderRefData) still covers the full global map.
  render();
}

// Wire the bottom-nav click handler once on boot. `tabs.js` loads before
// init.js, but we wait for DOMContentLoaded so the #bottom-nav element exists
// before we attach the listener.
document.addEventListener('DOMContentLoaded', () => {
  const nav = document.getElementById('bottom-nav');
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    setActiveTab(btn.dataset.tab);
  });
});
