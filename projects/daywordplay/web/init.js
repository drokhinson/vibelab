'use strict';

// ── Boot sequence ─────────────────────────────────────────────────────────────

// Fetch today's data for one group and cache it. Swallows per-group errors.
async function _fetchAndCacheToday(groupId) {
  try {
    const data = await apiFetch(`/groups/${groupId}/today`);
    dwpCache.set('today', groupId, data);
    return data;
  } catch (_) {
    return null;
  }
}

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

    // Bulk-load today's word for ALL groups + dictionary in parallel
    const parallel = [loadAllWords(), ...myGroups.map(g => _fetchAndCacheToday(g.id))];
    await Promise.all(parallel);

    // Set todayData from cache — no extra fetch needed
    if (activeGroupId) {
      const cached = dwpCache.get('today', activeGroupId);
      if (cached) {
        todayData = cached;
        cachedDailyWord = cached.word;
      }
    }

    // loadReusableSentences depends on todayData, so run after
    if (activeGroupId) {
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
    await loadAllWords();
    renderPageContent();
    initPageListeners();
  });

  document.getElementById('tab-stats')?.addEventListener('click', async () => {
    currentView = 'leaderboard';
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
