'use strict';

function renderProfileView() {
  if (!currentUser) return '';

  const displayName = currentUser.display_name || currentUser.username;
  const initial = displayName[0]?.toUpperCase() || '?';

  return `
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

    <div style="margin-top:24px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
        <span style="font-size:20px; font-weight:700; color:var(--text-primary);">My Groups</span>
        <div style="display:flex; gap:8px;">
          <button class="icon-btn" id="profile-join-btn" style="padding:6px 12px; font-size:12px;">${icons.plus} Join</button>
          <button class="icon-btn" id="profile-create-btn" style="padding:6px 12px; font-size:12px;">Create</button>
        </div>
      </div>

      ${myGroups.length > 0 ? `
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:10px;">Swipe right to share · swipe left to leave</p>
        <div class="group-list" id="profile-group-list">
          ${myGroups.map(g => renderProfileGroupCard(g)).join('')}
        </div>
      ` : `<p class="text-muted">You haven't joined any groups yet.</p>`}
    </div>

    <div style="margin-top:32px; padding-bottom:24px;">
      <button class="danger-btn" id="logout-btn">Log Out</button>
      <div style="margin-top:12px; text-align:center;">
        <button id="admin-access-btn" style="background:none; border:none; font-size:12px; color:var(--text-muted); cursor:pointer; padding:4px;">Admin</button>
      </div>
    </div>

    ${showJoinGroupModal ? renderJoinModal() : ''}
    ${showCreateGroupModal ? renderCreateModal() : ''}
  `;
}

function renderProfileGroupCard(g) {
  return `
    <div class="swipe-card-wrap" data-group-id="${escHtml(g.id)}">
      <div class="swipe-action swipe-action-left">
        ${icons.share}
        <span>Share</span>
      </div>
      <div class="swipe-action swipe-action-right">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        <span>Leave</span>
      </div>
      <div class="group-card swipe-card" style="cursor:default;" data-swipe-group="${escHtml(g.id)}" data-group-name="${escHtml(g.name)}" data-group-code="${escHtml(g.code)}">
        <div class="group-card-info">
          <div class="group-name">${escHtml(g.name)}</div>
        </div>
        <div class="group-code-badge">${escHtml(g.code)}</div>
      </div>
    </div>
  `;
}

function initProfileListeners() {
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

  // Join group button
  document.getElementById('profile-join-btn')?.addEventListener('click', () => {
    showJoinGroupModal = true;
    showCreateGroupModal = false;
    renderPageContent();
    initProfileListeners();
  });

  // Create group button
  document.getElementById('profile-create-btn')?.addEventListener('click', () => {
    showCreateGroupModal = true;
    showJoinGroupModal = false;
    renderPageContent();
    initProfileListeners();
  });

  // Modal close buttons
  document.getElementById('join-modal-close')?.addEventListener('click', () => {
    showJoinGroupModal = false;
    renderPageContent();
    initProfileListeners();
  });
  document.getElementById('create-modal-close')?.addEventListener('click', () => {
    showCreateGroupModal = false;
    renderPageContent();
    initProfileListeners();
  });
  document.getElementById('join-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'join-modal-overlay') { showJoinGroupModal = false; renderPageContent(); initProfileListeners(); }
  });
  document.getElementById('create-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'create-modal-overlay') { showCreateGroupModal = false; renderPageContent(); initProfileListeners(); }
  });

  // Join code input uppercase
  const codeInput = document.getElementById('join-code-input');
  if (codeInput) {
    codeInput.addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
  }

  // Join submit
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
      if (!activeGroupId) {
        activeGroupId = newGroup.id;
        setStoredActiveGroup(activeGroupId);
      }
      showJoinGroupModal = false;
      todayData = null;
      renderPageContent();
      initProfileListeners();
    } catch (err) {
      if (errEl) errEl.innerHTML = renderError(err.message);
      btn.disabled = false;
      btn.textContent = 'Join Group';
    }
  });

  // Create submit
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
      renderPageContent();
      initProfileListeners();
    } catch (err) {
      if (errEl) errEl.innerHTML = renderError(err.message);
      btn.disabled = false;
      btn.textContent = 'Create Group';
    }
  });

  // Admin access
  document.getElementById('admin-access-btn')?.addEventListener('click', () => {
    const existingKey = getAdminKey();
    if (existingKey) {
      currentView = 'admin';
      renderPageContent();
      initPageListeners();
      return;
    }
    const key = prompt('Enter admin code:');
    if (!key) return;
    setAdminKey(key);
    currentView = 'admin';
    renderPageContent();
    initPageListeners();
  });

  // Swipe gestures on group cards
  document.querySelectorAll('.swipe-card-wrap').forEach(wrap => {
    const card = wrap.querySelector('.swipe-card');
    if (!card) return;

    let startX = 0;
    let currentX = 0;
    let isDragging = false;
    const THRESHOLD = 60;

    function onTouchStart(e) {
      startX = e.touches[0].clientX;
      currentX = 0;
      isDragging = true;
      card.style.transition = 'none';
    }

    function onTouchMove(e) {
      if (!isDragging) return;
      currentX = e.touches[0].clientX - startX;
      // Clamp movement
      const clamped = Math.max(-120, Math.min(120, currentX));
      card.style.transform = `translateX(${clamped}px)`;

      // Show relevant action
      wrap.querySelector('.swipe-action-left').style.opacity = currentX > 10 ? Math.min(1, (currentX - 10) / 50) : 0;
      wrap.querySelector('.swipe-action-right').style.opacity = currentX < -10 ? Math.min(1, (-currentX - 10) / 50) : 0;
    }

    function onTouchEnd() {
      if (!isDragging) return;
      isDragging = false;
      card.style.transition = 'transform 0.2s ease';
      card.style.transform = 'translateX(0)';
      wrap.querySelector('.swipe-action-left').style.opacity = 0;
      wrap.querySelector('.swipe-action-right').style.opacity = 0;

      const groupId = wrap.dataset.groupId;
      const groupName = card.dataset.groupName;
      const groupCode = card.dataset.groupCode;

      if (currentX > THRESHOLD) {
        // Swipe right → share
        const appUrl = window.location.href.split('?')[0];
        const text = `I'm inviting you to play Day WordPlay! See who's the better wordsmith.\n\nFollow the link below and join my group, ${groupName} using code: ${groupCode}\n\n${appUrl}`;
        navigator.clipboard.writeText(text).then(() => {
          showCopiedToast(card);
        }).catch(() => {});
        if (navigator.share) {
          navigator.share({ title: 'Day WordPlay', text }).catch(() => {});
        }
      } else if (currentX < -THRESHOLD) {
        // Swipe left → leave
        if (confirm(`Leave "${groupName}"?`)) {
          leaveGroup(groupId);
        }
      }
    }

    card.addEventListener('touchstart', onTouchStart, { passive: true });
    card.addEventListener('touchmove', onTouchMove, { passive: true });
    card.addEventListener('touchend', onTouchEnd);
  });
}

function showCopiedToast(card) {
  const toast = document.createElement('div');
  toast.textContent = 'Link copied!';
  toast.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;padding:8px 16px;border-radius:20px;font-size:14px;font-weight:600;z-index:1000;pointer-events:none;';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

async function leaveGroup(groupId) {
  try {
    await apiFetch(`/groups/${groupId}/leave`, { method: 'DELETE' });
    myGroups = myGroups.filter(g => g.id !== groupId);
    if (activeGroupId === groupId) {
      activeGroupId = myGroups.length > 0 ? myGroups[0].id : null;
      setStoredActiveGroup(activeGroupId);
      todayData = null;
    }
    renderPageContent();
    initProfileListeners();
  } catch (err) {
    alert(`Could not leave group: ${err.message}`);
  }
}
