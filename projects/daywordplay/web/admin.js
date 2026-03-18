'use strict';

// ── Admin key storage (sessionStorage — clears when tab closes) ───────────────
function getAdminKey() { return sessionStorage.getItem('dwp_admin_key'); }
function setAdminKey(k) { sessionStorage.setItem('dwp_admin_key', k); }
function clearAdminKey() { sessionStorage.removeItem('dwp_admin_key'); }

// ── Admin API fetch (sends key as Bearer token) ───────────────────────────────
async function adminFetch(path, opts = {}) {
  const key = getAdminKey();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(`${API}${BASE}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

// ── Admin view ────────────────────────────────────────────────────────────────
function renderAdminView() {
  return `
    <div style="padding:16px 16px 100px;">
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:24px;">
        <button class="icon-btn" id="admin-back-btn" aria-label="Back">
          ${icons.back}
        </button>
        <span style="font-size:20px; font-weight:700; color:var(--text-primary);">Admin</span>
        <button id="admin-logout-btn" style="margin-left:auto; background:none; border:none; font-size:12px; color:var(--text-muted); cursor:pointer;">Sign out</button>
      </div>

      <!-- Add Word -->
      <div class="card" style="margin-bottom:24px;">
        <h3 style="margin:0 0 16px; font-size:16px;">Add Word</h3>
        <div style="display:flex; flex-direction:column; gap:10px;">
          <input id="admin-word" type="text" placeholder="Word *" style="width:100%; box-sizing:border-box;" />
          <input id="admin-pos" type="text" placeholder="Part of speech * (e.g. noun)" style="width:100%; box-sizing:border-box;" />
          <textarea id="admin-def" placeholder="Definition *" rows="2" style="width:100%; box-sizing:border-box; resize:vertical;"></textarea>
          <input id="admin-pron" type="text" placeholder="Pronunciation (optional)" style="width:100%; box-sizing:border-box;" />
          <textarea id="admin-etym" placeholder="Etymology (optional)" rows="2" style="width:100%; box-sizing:border-box; resize:vertical;"></textarea>
          <button class="btn-primary" id="admin-add-word-btn">Add Word</button>
          <div id="admin-word-msg"></div>
        </div>
      </div>

      <!-- Groups list -->
      <div>
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
          <h3 style="margin:0; font-size:16px;">All Groups</h3>
          <button class="icon-btn" id="admin-refresh-groups-btn" style="font-size:12px;">Refresh</button>
        </div>
        <div id="admin-groups-list">
          <div class="loading" style="height:60px;"></div>
        </div>
      </div>
    </div>
  `;
}

function renderAdminGroupRow(g) {
  return `
    <div class="card" style="display:flex; align-items:center; gap:8px; padding:10px 14px; margin-bottom:8px;" data-admin-group-id="${escHtml(g.id)}">
      <div style="flex:1; min-width:0;">
        <div style="font-weight:600; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escHtml(g.name)}</div>
        <div style="font-size:12px; color:var(--text-muted);">${escHtml(g.code)} · ${g.member_count} member${g.member_count !== 1 ? 's' : ''}</div>
      </div>
      <button class="danger-btn admin-delete-group-btn" data-group-id="${escHtml(g.id)}" data-group-name="${escHtml(g.name)}"
        style="padding:4px 10px; font-size:12px; white-space:nowrap;">Delete</button>
    </div>
  `;
}

async function loadAdminGroups() {
  const container = document.getElementById('admin-groups-list');
  if (!container) return;
  try {
    const data = await adminFetch('/admin/groups');
    const groups = data.groups || [];
    if (groups.length === 0) {
      container.innerHTML = `<p class="text-muted" style="font-size:14px;">No groups yet.</p>`;
    } else {
      container.innerHTML = groups.map(renderAdminGroupRow).join('');
    }
    attachAdminGroupListeners();
  } catch (err) {
    container.innerHTML = `<div class="error-banner">${escHtml(err.message)}</div>`;
  }
}

function attachAdminGroupListeners() {
  document.querySelectorAll('.admin-delete-group-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const groupId = btn.dataset.groupId;
      const groupName = btn.dataset.groupName;
      if (!confirm(`Delete group "${groupName}" and all its data? This cannot be undone.`)) return;
      btn.disabled = true;
      btn.textContent = 'Deleting…';
      try {
        await adminFetch(`/admin/groups/${groupId}`, { method: 'DELETE' });
        const row = document.querySelector(`[data-admin-group-id="${groupId}"]`);
        if (row) row.remove();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Delete';
        alert(`Error: ${err.message}`);
      }
    });
  });
}

function initAdminListeners() {
  // Back button
  document.getElementById('admin-back-btn')?.addEventListener('click', () => {
    currentView = 'profile';
    renderPageContent();
    initPageListeners();
  });

  // Sign out of admin
  document.getElementById('admin-logout-btn')?.addEventListener('click', () => {
    clearAdminKey();
    currentView = 'profile';
    renderPageContent();
    initPageListeners();
  });

  // Add word submit
  document.getElementById('admin-add-word-btn')?.addEventListener('click', async () => {
    const word = document.getElementById('admin-word')?.value.trim();
    const pos = document.getElementById('admin-pos')?.value.trim();
    const def = document.getElementById('admin-def')?.value.trim();
    const pron = document.getElementById('admin-pron')?.value.trim() || null;
    const etym = document.getElementById('admin-etym')?.value.trim() || null;
    const msgEl = document.getElementById('admin-word-msg');

    if (!word || !pos || !def) {
      if (msgEl) msgEl.innerHTML = renderError('Word, part of speech, and definition are required.');
      return;
    }

    const btn = document.getElementById('admin-add-word-btn');
    btn.disabled = true;
    btn.textContent = 'Adding…';

    try {
      await adminFetch('/admin/words', {
        method: 'POST',
        body: JSON.stringify({ word, part_of_speech: pos, definition: def, pronunciation: pron, etymology: etym }),
      });
      if (msgEl) msgEl.innerHTML = renderSuccess(`"${escHtml(word)}" added to word bank.`);
      // Clear form
      ['admin-word', 'admin-pos', 'admin-def', 'admin-pron', 'admin-etym'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
    } catch (err) {
      if (msgEl) msgEl.innerHTML = renderError(err.message);
    }

    btn.disabled = false;
    btn.textContent = 'Add Word';
  });

  // Refresh groups
  document.getElementById('admin-refresh-groups-btn')?.addEventListener('click', loadAdminGroups);

  // Load groups on open
  loadAdminGroups();
}
