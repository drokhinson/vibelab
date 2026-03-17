'use strict';

// ── Boot sequence ─────────────────────────────────────────────────────────────
async function loadInitialData() {
  try {
    // Load user's groups
    const groupsData = await apiFetch('/groups/mine');
    myGroups = groupsData.groups || [];

    // Restore or pick active group
    const stored = getStoredActiveGroup();
    if (stored && myGroups.find(g => g.id === stored)) {
      activeGroupId = stored;
    } else if (myGroups.length > 0) {
      activeGroupId = myGroups[0].id;
    }

    // Load bookmarks
    const bkData = await apiFetch('/words/bookmarks');
    bookmarks = bkData.bookmarks || [];

    // Load today's word for active group
    if (activeGroupId) {
      await loadTodayWord();
    }
  } catch (err) {
    console.error('Failed to load initial data:', err);
  }
}

// ── Page listener dispatcher ──────────────────────────────────────────────────
function initPageListeners() {
  switch (currentView) {
    case 'home':
      initHomeListeners();
      break;
    case 'vote':
      initVoteListeners();
      break;
    case 'groups':
      initGroupsListeners();
      break;
    case 'dictionary':
      initDictionaryListeners();
      break;
    case 'leaderboard':
      initLeaderboardListeners();
      break;
    case 'profile':
      initProfileListeners();
      break;
  }
}

// ── DOMContentLoaded ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const token = getToken();

  if (!token) {
    // Not logged in — show auth screen
    renderApp();
    initAuthListeners();
    return;
  }

  // Verify token by fetching /auth/me
  try {
    const userData = await apiFetch('/auth/me');
    currentUser = userData;
    await loadInitialData();
  } catch (err) {
    // Token expired or invalid
    clearToken();
    currentUser = null;
  }

  renderApp();

  if (!currentUser) {
    initAuthListeners();
    return;
  }

  initPageListeners();

  // Set up lazy loading for views that need it
  setupViewLoading();
});

// ── Lazy loading setup ────────────────────────────────────────────────────────
function setupViewLoading() {
  // When leaderboard becomes visible for the first time, load data
  const origRenderPage = renderPageContent;

  // Override renderPageContent to also init listeners and lazy-load data
  window._lastView = currentView;
}

// ── Tab switching with data loading ──────────────────────────────────────────
// Override updateTabBar to also load data when switching views
const _origUpdateTabBar = updateTabBar;
function updateTabBar() {
  _origUpdateTabBar();

  document.getElementById('tab-word')?.addEventListener('click', async () => {
    const prev = currentView;
    currentView = 'home';
    if (!todayData && activeGroupId) await loadTodayWord();
    renderPageContent();
    initPageListeners();
    document.getElementById('tab-word')?.classList.add('active');
    document.getElementById('tab-groups')?.classList.remove('active');
    document.getElementById('tab-stats')?.classList.remove('active');
  });

  document.getElementById('tab-groups')?.addEventListener('click', async () => {
    currentView = 'groups';
    if (!groupsSearchResults.length) await searchGroups('');
    renderPageContent();
    initPageListeners();
  });

  document.getElementById('tab-stats')?.addEventListener('click', async () => {
    currentView = 'leaderboard';
    leaderboardData = null;
    renderPageContent();
    if (activeGroupId) await loadLeaderboard();
    renderPageContent();
    initPageListeners();
  });

  document.getElementById('profile-btn')?.addEventListener('click', () => {
    currentView = 'profile';
    renderPageContent();
    initPageListeners();
  });

  document.getElementById('dict-btn-header')?.addEventListener('click', () => {
    currentView = 'dictionary';
    renderPageContent();
    initPageListeners();
  });
}
