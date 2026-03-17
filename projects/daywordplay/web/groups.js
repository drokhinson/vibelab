'use strict';

let showCreateGroupModal = false;
let showJoinGroupModal = false;
let groupSearchQuery = '';
let groupsSearchResults = [];
let groupsLoading = false;

async function searchGroups(q = '') {
  groupsLoading = true;
  try {
    const data = await apiFetch(`/groups?q=${encodeURIComponent(q)}`);
    groupsSearchResults = data.groups || [];
  } catch (err) {
    groupsSearchResults = [];
  }
  groupsLoading = false;
}

function renderGroupsView() {
  return `
    <div class="section-header">
      <span class="section-title">Groups</span>
      <div style="display:flex; gap:8px;">
        <button class="icon-btn" id="join-code-btn">${icons.plus} Join</button>
        <button class="icon-btn" id="create-group-btn">Create</button>
      </div>
    </div>

    ${myGroups.length > 0 ? `
      <h3 style="font-size:13px; font-weight:600; text-transform:uppercase; letter-spacing:.8px; color:var(--text-muted); margin-bottom:10px;">My Groups</h3>
      <div class="group-list" style="margin-bottom:24px;">
        ${myGroups.map(g => renderMyGroupCard(g)).join('')}
      </div>
    ` : ''}

    <h3 style="font-size:13px; font-weight:600; text-transform:uppercase; letter-spacing:.8px; color:var(--text-muted); margin-bottom:10px;">Discover Groups</h3>
    <div class="search-wrap">
      <span class="search-icon">${icons.search}</span>
      <input type="text" id="group-search-input" placeholder="Search groups…" value="${escHtml(groupSearchQuery)}" />
    </div>
    <div class="group-list" id="group-search-results">
      ${groupsLoading
        ? `<div class="loading" style="height:120px"></div>`
        : groupsSearchResults.map(g => renderDiscoveryGroupCard(g)).join('')
      }
      ${!groupsLoading && !groupsSearchResults.length && groupSearchQuery
        ? `<div class="text-muted text-center" style="padding:24px 0">No groups found for "${escHtml(groupSearchQuery)}"</div>`
        : ''}
    </div>

    ${showJoinGroupModal ? renderJoinModal() : ''}
    ${showCreateGroupModal ? renderCreateModal() : ''}
  `;
}

function renderMyGroupCard(g) {
  const isActive = g.id === activeGroupId;
  return `
    <div class="group-card ${isActive ? 'active' : ''}" data-switch-group="${g.id}">
      <div class="group-card-info">
        <div class="group-name">${escHtml(g.name)}</div>
        <div class="group-meta">${isActive ? 'Active group' : 'Tap to switch'}</div>
      </div>
      <div class="group-code-badge">${escHtml(g.code)}</div>
    </div>
  `;
}

function renderDiscoveryGroupCard(g) {
  const isMember = g.is_member;
  return `
    <div class="group-card">
      <div class="group-card-info">
        <div class="group-name">${escHtml(g.name)}</div>
        <div class="group-meta">${g.member_count} member${g.member_count !== 1 ? 's' : ''}</div>
      </div>
      ${isMember
        ? `<span style="font-size:13px; color:var(--accent); font-weight:600;">${icons.check} Joined</span>`
        : `<button class="join-btn" data-join-group="${g.id}">Join</button>`
      }
    </div>
  `;
}

function renderJoinModal() {
  return `
    <div class="modal-overlay" id="join-modal-overlay">
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-title">Join by Code</div>
        <p class="text-muted" style="margin-bottom:16px;">Enter the 4-letter code shown on your friend's group leaderboard.</p>
        <div class="form-field">
          <label>Group Code</label>
          <input type="text" id="join-code-input" placeholder="ABCD" maxlength="4" style="text-transform:uppercase; font-family:monospace; font-size:20px; letter-spacing:4px; text-align:center;" />
        </div>
        <div id="join-error"></div>
        <button class="btn-primary full-width" id="join-code-submit" style="margin-top:8px;">Join Group</button>
        <button class="danger-btn" id="join-modal-close" style="margin-top:8px; color:var(--text-muted); border-color:var(--border);">Cancel</button>
      </div>
    </div>
  `;
}

function renderCreateModal() {
  return `
    <div class="modal-overlay" id="create-modal-overlay">
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-title">Create a Group</div>
        <p class="text-muted" style="margin-bottom:16px;">Give your group a name. Share the 4-letter code so friends can join.</p>
        <div class="form-field">
          <label>Group Name</label>
          <input type="text" id="create-name-input" placeholder="e.g. Weekend Warriors" maxlength="40" />
        </div>
        <div id="create-error"></div>
        <button class="btn-primary full-width" id="create-group-submit" style="margin-top:8px;">Create Group</button>
        <button class="danger-btn" id="create-modal-close" style="margin-top:8px; color:var(--text-muted); border-color:var(--border);">Cancel</button>
      </div>
    </div>
  `;
}

function initGroupsListeners() {
  // Search
  const searchInput = document.getElementById('group-search-input');
  if (searchInput) {
    let searchTimer;
    searchInput.addEventListener('input', (e) => {
      groupSearchQuery = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        await searchGroups(groupSearchQuery);
        const resultsEl = document.getElementById('group-search-results');
        if (resultsEl) {
          resultsEl.innerHTML = groupsSearchResults.map(g => renderDiscoveryGroupCard(g)).join('');
          attachDiscoveryJoinListeners();
        }
      }, 400);
    });
  }

  // My group switcher
  document.querySelectorAll('[data-switch-group]').forEach(card => {
    card.addEventListener('click', async () => {
      activeGroupId = card.dataset.switchGroup;
      setStoredActiveGroup(activeGroupId);
      todayData = null;
      currentView = 'home';
      renderPageContent();
      await loadTodayWord();
      renderPageContent();
      initPageListeners();
      updateTabBar();
    });
  });

  // Open join modal
  document.getElementById('join-code-btn')?.addEventListener('click', () => {
    showJoinGroupModal = true;
    showCreateGroupModal = false;
    renderPageContent();
    initGroupsListeners();
  });

  // Open create modal
  document.getElementById('create-group-btn')?.addEventListener('click', () => {
    showCreateGroupModal = true;
    showJoinGroupModal = false;
    renderPageContent();
    initGroupsListeners();
  });

  // Close modals
  document.getElementById('join-modal-close')?.addEventListener('click', () => {
    showJoinGroupModal = false; renderPageContent(); initGroupsListeners();
  });
  document.getElementById('create-modal-close')?.addEventListener('click', () => {
    showCreateGroupModal = false; renderPageContent(); initGroupsListeners();
  });
  document.getElementById('join-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'join-modal-overlay') { showJoinGroupModal = false; renderPageContent(); initGroupsListeners(); }
  });
  document.getElementById('create-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'create-modal-overlay') { showCreateGroupModal = false; renderPageContent(); initGroupsListeners(); }
  });

  // Join by code
  const codeInput = document.getElementById('join-code-input');
  if (codeInput) {
    codeInput.addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
  }

  document.getElementById('join-code-submit')?.addEventListener('click', async () => {
    const code = document.getElementById('join-code-input')?.value.trim().toUpperCase();
    const errEl = document.getElementById('join-error');
    if (!code || code.length !== 4) {
      if (errEl) errEl.innerHTML = renderError('Enter a valid 4-character code.');
      return;
    }
    const btn = document.getElementById('join-code-submit');
    btn.disabled = true;
    btn.textContent = 'Joining…';
    try {
      const data = await apiFetch('/groups/join', { method: 'POST', body: JSON.stringify({ code }) });
      const newGroup = data.group;
      myGroups.push(newGroup);
      activeGroupId = newGroup.id;
      setStoredActiveGroup(activeGroupId);
      showJoinGroupModal = false;
      todayData = null;
      currentView = 'home';
      await loadTodayWord();
      renderPageContent();
      initPageListeners();
      updateTabBar();
    } catch (err) {
      if (errEl) errEl.innerHTML = renderError(err.message);
      btn.disabled = false;
      btn.textContent = 'Join Group';
    }
  });

  // Create group
  document.getElementById('create-group-submit')?.addEventListener('click', async () => {
    const name = document.getElementById('create-name-input')?.value.trim();
    const errEl = document.getElementById('create-error');
    if (!name || name.length < 2) {
      if (errEl) errEl.innerHTML = renderError('Please enter a group name (at least 2 characters).');
      return;
    }
    const btn = document.getElementById('create-group-submit');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const data = await apiFetch('/groups', { method: 'POST', body: JSON.stringify({ name }) });
      const newGroup = data.group;
      myGroups.push(newGroup);
      activeGroupId = newGroup.id;
      setStoredActiveGroup(activeGroupId);
      showCreateGroupModal = false;
      todayData = null;
      currentView = 'home';
      await loadTodayWord();
      renderPageContent();
      initPageListeners();
      updateTabBar();
    } catch (err) {
      if (errEl) errEl.innerHTML = renderError(err.message);
      btn.disabled = false;
      btn.textContent = 'Create Group';
    }
  });

  // Discovery join buttons
  attachDiscoveryJoinListeners();
}

function attachDiscoveryJoinListeners() {
  document.querySelectorAll('[data-join-group]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const groupId = btn.dataset.joinGroup;
      const group = groupsSearchResults.find(g => g.id === groupId);
      if (!group) return;
      btn.disabled = true;
      btn.textContent = 'Joining…';
      try {
        await apiFetch('/groups/join', { method: 'POST', body: JSON.stringify({ code: group.code }) });
        const groupData = await apiFetch(`/groups/${groupId}`);
        myGroups.push(groupData.group || group);
        if (!activeGroupId) {
          activeGroupId = groupId;
          setStoredActiveGroup(activeGroupId);
        }
        // Mark as member in results
        const idx = groupsSearchResults.findIndex(g => g.id === groupId);
        if (idx >= 0) groupsSearchResults[idx].is_member = true;
        renderPageContent();
        initPageListeners();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Join';
        btn.closest('.group-card')?.insertAdjacentHTML('afterend', renderError(err.message));
      }
    });
  });
}
