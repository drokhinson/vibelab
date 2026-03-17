'use strict';

function renderProfileView() {
  if (!currentUser) return '';

  const displayName = currentUser.display_name || currentUser.username;
  const initial = displayName[0]?.toUpperCase() || '?';

  return `
    <button class="icon-btn" id="back-from-profile" style="margin-top:16px;">
      ${icons.back} Back
    </button>
    <div class="profile-header">
      <div class="profile-avatar">${initial}</div>
      <div class="profile-name">${escHtml(displayName)}</div>
      <div class="profile-username">@${escHtml(currentUser.username)}</div>
    </div>
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">${bookmarks.length}</div>
        <div class="stat-label">Saved Words</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${myGroups.length}</div>
        <div class="stat-label">Groups</div>
      </div>
    </div>
    <div style="margin-top:32px;">
      <h3 style="font-size:13px; font-weight:600; text-transform:uppercase; letter-spacing:.8px; color:var(--text-muted); margin-bottom:12px;">My Groups</h3>
      ${myGroups.length
        ? `<div class="group-list">${myGroups.map(g => `
            <div class="group-card" style="cursor:default;">
              <div class="group-card-info">
                <div class="group-name">${escHtml(g.name)}</div>
              </div>
              <div class="group-code-badge">${escHtml(g.code)}</div>
            </div>
          `).join('')}</div>`
        : `<p class="text-muted">You haven't joined any groups yet.</p>`
      }
    </div>
    <div style="margin-top:32px; padding-bottom:24px;">
      <button class="danger-btn" id="logout-btn">Log Out</button>
    </div>
  `;
}

function initProfileListeners() {
  document.getElementById('back-from-profile')?.addEventListener('click', () => {
    currentView = 'home';
    renderPageContent();
    initPageListeners();
    updateTabBar();
  });

  document.getElementById('logout-btn')?.addEventListener('click', () => {
    if (!confirm('Log out of Day Word Play?')) return;
    clearToken();
    currentUser = null;
    myGroups = [];
    activeGroupId = null;
    todayData = null;
    yesterdayData = null;
    bookmarks = [];
    currentView = 'home';
    renderApp();
  });
}
