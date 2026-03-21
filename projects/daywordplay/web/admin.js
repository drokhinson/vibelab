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

function renderAdminLoading() {
  return `<div style="display:flex; align-items:center; gap:8px; padding:16px 0; color:var(--text-muted); font-size:14px;">
    <div class="loading-spinner" style="width:16px; height:16px; border-width:2px; flex-shrink:0;"></div>
    Loading…
  </div>`;
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

      <!-- Proposed Words -->
      <div style="margin-bottom:24px;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
          <h3 style="margin:0; font-size:16px;">Proposed Words</h3>
          <button class="icon-btn" id="admin-refresh-proposals-btn" style="font-size:12px;">Refresh</button>
        </div>
        <div id="admin-proposals-list">
          ${renderAdminLoading()}
        </div>
      </div>

      <!-- Groups list -->
      <div>
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
          <h3 style="margin:0; font-size:16px;">All Groups</h3>
          <button class="icon-btn" id="admin-refresh-groups-btn" style="font-size:12px;">Refresh</button>
        </div>
        <div id="admin-groups-list">
          ${renderAdminLoading()}
        </div>
      </div>
    </div>
  `;
}

function renderAdminGroupRow(g) {
  return `
    <div class="card" style="padding:10px 14px; margin-bottom:8px;" data-admin-group-id="${escHtml(g.id)}">
      <div style="font-weight:600; font-size:14px; margin-bottom:2px;">${escHtml(g.name)}</div>
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:10px;">${escHtml(g.code)} · ${g.member_count} member${g.member_count !== 1 ? 's' : ''}</div>
      <button class="danger-btn admin-delete-group-btn" data-group-id="${escHtml(g.id)}" data-group-name="${escHtml(g.name)}"
        style="width:100%; padding:6px 10px; font-size:13px;">Delete</button>
    </div>
  `;
}

async function loadAdminGroups() {
  const container = document.getElementById('admin-groups-list');
  if (!container) return;
  container.innerHTML = renderAdminLoading();
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

function renderAdminProposalRow(p) {
  const proposer = escHtml(p.proposer_display_name || p.proposer_username || 'unknown');
  return `
    <div class="card" style="margin-bottom:10px;" data-admin-proposal-id="${escHtml(p.id)}">
      <div style="display:flex; align-items:flex-start; gap:8px;">
        <div style="flex:1; min-width:0;">
          <div style="font-weight:700; font-size:15px;">${escHtml(p.word)}</div>
          <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">${escHtml(p.part_of_speech)} · proposed by ${proposer}</div>
          <div style="font-size:13px; color:var(--text-secondary); line-height:1.5;">${escHtml(p.definition)}</div>
          ${p.pronunciation ? `<div style="font-size:12px; color:var(--text-muted); margin-top:4px;">${escHtml(p.pronunciation)}</div>` : ''}
          ${p.etymology ? `<div style="font-size:12px; color:var(--text-muted); margin-top:2px;"><em>Origin:</em> ${escHtml(p.etymology)}</div>` : ''}
        </div>
      </div>
      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="btn-primary admin-approve-proposal-btn" data-proposal-id="${escHtml(p.id)}" data-proposal-word="${escHtml(p.word)}"
          style="flex:1; padding:8px; font-size:13px;">Approve</button>
        <button class="danger-btn admin-reject-proposal-btn" data-proposal-id="${escHtml(p.id)}" data-proposal-word="${escHtml(p.word)}"
          style="flex:1; padding:8px; font-size:13px;">Reject</button>
      </div>
      <div class="admin-proposal-msg" style="margin-top:6px;"></div>
    </div>
  `;
}

async function loadAdminProposals() {
  const container = document.getElementById('admin-proposals-list');
  if (!container) return;
  container.innerHTML = renderAdminLoading();
  try {
    const data = await adminFetch('/admin/proposed-words');
    const proposals = data.proposals || [];
    if (proposals.length === 0) {
      container.innerHTML = `<p class="text-muted" style="font-size:14px;">No pending proposals.</p>`;
    } else {
      container.innerHTML = proposals.map(renderAdminProposalRow).join('');
    }
    attachAdminProposalListeners();
  } catch (err) {
    container.innerHTML = `<div class="error-banner">${escHtml(err.message)}</div>`;
  }
}

function attachAdminProposalListeners() {
  document.querySelectorAll('.admin-approve-proposal-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const proposalId = btn.dataset.proposalId;
      const word = btn.dataset.proposalWord;
      const row = document.querySelector(`[data-admin-proposal-id="${proposalId}"]`);
      const msgEl = row?.querySelector('.admin-proposal-msg');
      btn.disabled = true;
      btn.textContent = 'Approving…';
      try {
        await adminFetch(`/admin/proposed-words/${proposalId}/approve`, { method: 'POST' });
        if (row) {
          row.innerHTML = `<div class="success-banner" style="margin:0;">"${escHtml(word)}" approved and added to the dictionary.</div>`;
        }
      } catch (err) {
        if (msgEl) msgEl.innerHTML = renderError(err.message);
        btn.disabled = false;
        btn.textContent = 'Approve';
      }
    });
  });

  document.querySelectorAll('.admin-reject-proposal-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const proposalId = btn.dataset.proposalId;
      const word = btn.dataset.proposalWord;
      if (!confirm(`Reject proposal for "${word}"?`)) return;
      const row = document.querySelector(`[data-admin-proposal-id="${proposalId}"]`);
      const msgEl = row?.querySelector('.admin-proposal-msg');
      btn.disabled = true;
      btn.textContent = 'Rejecting…';
      try {
        await adminFetch(`/admin/proposed-words/${proposalId}/reject`, { method: 'POST' });
        if (row) row.remove();
      } catch (err) {
        if (msgEl) msgEl.innerHTML = renderError(err.message);
        btn.disabled = false;
        btn.textContent = 'Reject';
      }
    });
  });
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

  // Refresh proposals
  document.getElementById('admin-refresh-proposals-btn')?.addEventListener('click', loadAdminProposals);

  // Load data on open
  loadAdminProposals();
  loadAdminGroups();
}
