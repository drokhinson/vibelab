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

async function loadEagerData() {
  // Try cached user first, fall back to /auth/me
  const cachedUser = localStorage.getItem('dwp_user');
  let userData;
  if (cachedUser) {
    try { userData = JSON.parse(cachedUser); } catch (_) { userData = null; }
  }

  if (userData) {
    currentUser = userData;
    const groupsData = await apiFetch('/groups/mine');
    myGroups = groupsData.groups || [];
    // Refresh user profile in background (catches display_name changes, etc.)
    apiFetch('/auth/me').then(fresh => {
      currentUser = fresh;
      localStorage.setItem('dwp_user', JSON.stringify(fresh));
    }).catch(() => {});
  } else {
    const [freshUser, groupsData] = await Promise.all([
      apiFetch('/auth/me'),
      apiFetch('/groups/mine'),
    ]);
    currentUser = freshUser;
    localStorage.setItem('dwp_user', JSON.stringify(freshUser));
    myGroups = groupsData.groups || [];
  }

  // Restore or pick active group
  const stored = getStoredActiveGroup();
  activeGroupId = (stored && myGroups.find(g => g.id === stored))
    ? stored
    : myGroups[0]?.id || null;

  // Only fetch today's word for the active group (critical path)
  if (activeGroupId) {
    const data = await _fetchAndCacheToday(activeGroupId);
    if (data) {
      todayData = data;
      cachedDailyWord = data.word;
    }
  }
}

// Load non-essential data in background after first render.
// Re-renders only if the loaded data is relevant to the current view.
async function _loadDeferredData() {
  await Promise.all([
    // Other groups' today data
    ...myGroups.filter(g => g.id !== activeGroupId).map(g => _fetchAndCacheToday(g.id)),
    _bulkLoadYesterday(),
    _bulkLoadLeaderboards(),
    activeGroupId ? loadReusableSentences() : Promise.resolve(),
    loadHomeJoinRequests(),
  ]);

  // Re-render if deferred data affects the current view
  if (currentView === 'home' && activeWordTab === 'vote') {
    yesterdayData = dwpCache.get('yesterday', activeGroupId) || null;
    renderPageContent();
    initPageListeners();
  } else if (currentView === 'leaderboard') {
    leaderboardData = dwpCache.get('leaderboard', activeGroupId) || null;
    renderPageContent();
    initPageListeners();
  } else if (currentView === 'profile') {
    loadAllJoinRequests();
  }

  // Update settings badge with pending request count
  updateSettingsBadge();
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

  // Load only critical data before first render
  try {
    await loadEagerData();
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

  // Load remaining data in background (no await)
  _loadDeferredData();
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
    // Auto-load played words for the default "Played" view if not yet cached
    if (dictFilter === 'played' && playedWords.length === 0) {
      await loadPlayedWords();
      renderPageContent();
      initPageListeners();
    }
  });

  document.getElementById('tab-stats')?.addEventListener('click', async () => {
    currentView = 'leaderboard';
    renderPageContent();
    if (activeGroupId) await loadLeaderboard();
    renderPageContent();
    initPageListeners();
    updateTabBar();
  });

  document.getElementById('help-btn')?.addEventListener('click', () => {
    document.body.insertAdjacentHTML('beforeend', renderHelpModal());
    document.getElementById('help-modal-close')?.addEventListener('click', closeHelpModal);
    document.getElementById('help-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'help-modal-overlay') closeHelpModal();
    });
  });

  document.getElementById('profile-btn')?.addEventListener('click', () => {
    currentView = 'profile';
    renderPageContent();
    initPageListeners();
    updateTabBar();
  });

}
