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
  // Round trip 1: verify auth + fetch groups in parallel
  const [userData, groupsData] = await Promise.all([
    apiFetch('/auth/me'),
    apiFetch('/groups/mine'),
  ]);
  currentUser = userData;
  myGroups = groupsData.groups || [];

  // Restore or pick active group
  const stored = getStoredActiveGroup();
  activeGroupId = (stored && myGroups.find(g => g.id === stored))
    ? stored
    : myGroups[0]?.id || null;

  // Round trip 2: all group data in parallel (no dictionary)
  await Promise.all([
    ...myGroups.map(g => _fetchAndCacheToday(g.id)),
    _bulkLoadYesterday(),
    _bulkLoadLeaderboards(),
    activeGroupId ? loadReusableSentences() : Promise.resolve(),
  ]);

  // Set todayData from cache — no extra fetch needed
  if (activeGroupId) {
    const cached = dwpCache.get('today', activeGroupId);
    if (cached) {
      todayData = cached;
      cachedDailyWord = cached.word;
    }
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

  // Verify token + load all initial data in parallel rounds
  try {
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

  document.getElementById('profile-btn')?.addEventListener('click', () => {
    currentView = 'profile';
    renderPageContent();
    initPageListeners();
    updateTabBar();
  });

}
