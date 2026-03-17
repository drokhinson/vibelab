'use strict';

// ─── Settings / Admin Screens ─────────────────────────────────────────────────
function renderSettings() {
  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('carb-selector')">‹ Back</button>
      <div class="logo"><span>⚙</span>Admin Access</div>
      <div class="subtitle">Enter the admin password to manage sauces</div>
    </div>
    <div class="scroll-body">
      <div class="settings-form">
        <input
          id="admin-password-input"
          type="password"
          class="builder-input settings-password-input"
          placeholder="Admin password"
          autocomplete="current-password"
          onkeydown="if(event.key==='Enter') submitAdminPassword()"
        >
        ${state.adminError ? `<div class="settings-error">${state.adminError}</div>` : ''}
        <button class="builder-primary-btn" onclick="submitAdminPassword()" id="settings-submit-btn">
          ${state.adminLoading ? '<span class="spinner-sm"></span> Verifying…' : 'Enter'}
        </button>
      </div>
    </div>
  `;
}

function renderAdmin() {
  const grouped = {};
  for (const sauce of state.adminSauces) {
    if (!grouped[sauce.cuisine]) grouped[sauce.cuisine] = [];
    grouped[sauce.cuisine].push(sauce);
  }
  const cuisines = Object.keys(grouped).sort();

  const listHTML = cuisines.map(cuisine => `
    <div class="admin-cuisine-group">
      <div class="admin-cuisine-header">${cuisine} <span class="admin-count">${grouped[cuisine].length}</span></div>
      ${grouped[cuisine].map(s => `
        <div class="admin-sauce-row" id="admin-sauce-${s.id}">
          <span class="sauce-dot" style="background:${s.color || '#999'}"></span>
          <div class="admin-sauce-info">
            <div class="admin-sauce-name">${s.name}</div>
            <div class="admin-sauce-carbs">${(s.compatible_carbs || []).join(' · ')}</div>
          </div>
          <button class="admin-delete-btn" onclick="adminDeleteSauce('${s.id}', '${s.name.replace(/'/g, "\\'")}')">Delete</button>
        </div>
      `).join('')}
    </div>
  `).join('');

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('carb-selector')">‹ Back</button>
      <div class="logo"><span>⚙</span>Sauce Manager</div>
      <div class="subtitle">${state.adminSauces.length} sauces total</div>
    </div>
    <div class="scroll-body">
      ${state.adminError ? `<div class="settings-error" style="margin:12px 16px">${state.adminError}</div>` : ''}
      ${listHTML || '<p style="padding:16px;color:#888">No sauces found.</p>'}
    </div>
  `;
}

// ─── Admin Actions ────────────────────────────────────────────────────────────
function openSettings() {
  state.adminError = null;
  navigate('settings');
}

async function submitAdminPassword() {
  const input = document.getElementById('admin-password-input');
  if (!input || !input.value.trim()) return;
  const key = input.value.trim();
  state.adminLoading = true;
  state.adminError = null;
  render();
  try {
    const sauces = await fetchAdminSauces(key);
    state.adminKey = key;
    state.adminSauces = sauces;
    state.adminLoading = false;
    state.adminError = null;
    navigate('admin');
  } catch (err) {
    state.adminLoading = false;
    state.adminError = err.message.includes('403') || err.message.includes('401')
      ? 'Incorrect password. Try again.'
      : `Error: ${err.message}`;
    render();
  }
}

async function adminDeleteSauce(id, name) {
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  try {
    await deleteAdminSauce(id, state.adminKey);
    state.adminSauces = state.adminSauces.filter(s => s.id !== id);
    state.adminError = null;
    render();
  } catch (err) {
    state.adminError = `Failed to delete: ${err.message}`;
    render();
  }
}
