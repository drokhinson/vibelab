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

    // Load word history for dictionary
    await loadWordHistory();

    // Load today's word + reusable sentences for active group
    if (activeGroupId) {
      await loadTodayWord();
      await loadReusableSentences();
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
    case 'dictionary':
      initDictionaryListeners();
      break;
    case 'leaderboard':
      initLeaderboardListeners();
      break;
    case 'profile':
      initProfileListeners();
      break;
    case 'admin':
      initAdminListeners();
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

  initShellListeners();
  initPageListeners();
});

// ── Shell listeners (tabs, header buttons) ───────────────────────────────────
// Called once after renderApp() replaces the entire DOM.
function initShellListeners() {
  document.getElementById('tab-word')?.addEventListener('click', async () => {
    currentView = 'home';
    activeWordTab = 'today';
    if (!todayData && activeGroupId) await loadTodayWord();
    renderPageContent();
    initPageListeners();
    updateTabBar();
  });

  document.getElementById('tab-dict')?.addEventListener('click', async () => {
    currentView = 'dictionary';
    renderPageContent();
    initPageListeners();
    updateTabBar();
    await loadWordHistory();
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
    updateTabBar();
  });

  document.getElementById('profile-btn')?.addEventListener('click', () => {
    currentView = 'profile';
    renderPageContent();
    initPageListeners();
    updateTabBar();
  });

}
