'use strict';

// ─── Settings / Admin Screens ─────────────────────────────────────────────────
function renderSettings() {
  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('admin')"><i data-lucide="chevron-left"></i> Back</button>
      <div class="logo"><span><i data-lucide="settings-2"></i></span>Admin Login</div>
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
  const isAdmin = !!state.adminKey;
  const tab = state.sauceManagerTab || 'sauces';

  const tabBar = `
    <div class="sauce-manager-tabs">
      <button class="sm-tab ${tab === 'sauces' ? 'sm-tab-active' : ''}" onclick="setSauceManagerTab('sauces')">Sauces</button>
      <button class="sm-tab ${tab === 'carbs' ? 'sm-tab-active' : ''}" onclick="setSauceManagerTab('carbs')">Carbs</button>
      <button class="sm-tab ${tab === 'addons' ? 'sm-tab-active' : ''}" onclick="setSauceManagerTab('addons')">Add-ons</button>
    </div>`;

  let bodyHTML = '';
  if (tab === 'sauces') bodyHTML = renderSaucesTab(isAdmin);
  else if (tab === 'carbs') bodyHTML = renderCarbsTab(isAdmin);
  else bodyHTML = renderAddonsTab(isAdmin);

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('meal-builder')"><i data-lucide="chevron-left"></i> Back</button>
      <div class="logo"><span><i data-lucide="settings-2"></i></span>Sauce Manager</div>
      <div class="subtitle">${isAdmin ? 'Admin mode' : ''}</div>
      ${!isAdmin ? `<button class="settings-btn" onclick="openSettings()" title="Admin login"><i data-lucide="key-round"></i></button>` : ''}
    </div>
    ${state.adminError ? `<div class="settings-error" style="margin:8px 16px">${state.adminError}</div>` : ''}
    ${tabBar}
    <div class="scroll-body">
      ${bodyHTML}
    </div>
  `;
}

function renderSaucesTab(isAdmin) {
  const grouped = {};
  for (const sauce of state.adminSauces) {
    if (!grouped[sauce.cuisine]) grouped[sauce.cuisine] = [];
    grouped[sauce.cuisine].push(sauce);
  }
  const cuisines = Object.keys(grouped).sort();

  if (cuisines.length === 0) {
    return '<p style="padding:16px;color:#888">No sauces found.</p>';
  }

  return cuisines.map(cuisine => `
    <div class="admin-cuisine-group">
      <div class="admin-cuisine-header">${cuisine} <span class="admin-count">${grouped[cuisine].length}</span></div>
      ${grouped[cuisine].map(s => {
        const safeName = s.name.replace(/'/g, "\\'");
        return `
        <div class="admin-sauce-row" onclick="selectSauceFromManager('${s.id}')">
          <span class="sauce-dot" style="background:${s.color || '#999'}"></span>
          <div class="admin-sauce-info">
            <div class="admin-sauce-name">${s.name}</div>
            <div class="admin-sauce-carbs">${(s.compatibleCarbs || s.compatible_carbs || []).join(' · ')}</div>
          </div>
          ${isAdmin ? `
            <button class="admin-edit-btn" onclick="event.stopPropagation(); openBuilderEdit('${s.id}')">Edit</button>
            <button class="admin-delete-btn" onclick="event.stopPropagation(); adminDeleteSauce('${s.id}', '${safeName}')">Delete</button>
          ` : ''}
        </div>`;
      }).join('')}
    </div>
  `).join('');
}

function renderCarbsTab(isAdmin) {
  const carbRows = state.carbs.map(c => {
    const preps = (state.carbPreparations || {})[c.id] || [];
    const prepRows = preps.map(p => `
      <div class="admin-sauce-row" style="padding-left:32px;opacity:0.8">
        <span class="sm-carb-emoji" style="font-size:14px">${p.emoji || '↳'}</span>
        <div class="admin-sauce-info">
          <div class="admin-sauce-name" style="font-size:13px">${p.name}</div>
          <div class="admin-sauce-carbs">${p.cookTime || ''}</div>
        </div>
      </div>
    `).join('');
    return `
    <div class="admin-sauce-row">
      <span class="sm-carb-emoji">${c.emoji}</span>
      <div class="admin-sauce-info">
        <div class="admin-sauce-name">${c.name}</div>
        <div class="admin-sauce-carbs">${c.cookTimeLabel || (c.cookTimeMinutes ? c.cookTimeMinutes + ' min' : '')} · ${c.sauceCount || 0} sauce${c.sauceCount !== 1 ? 's' : ''}</div>
      </div>
    </div>
    ${prepRows}`;
  }).join('');

  const loadingNote = !state.carbPreparations
    ? '<p style="padding:8px 16px;color:#888;font-size:13px">Loading sub-carbs…</p>'
    : '';

  const addForm = isAdmin ? renderAddCarbForm() : '';

  return carbRows + loadingNote + addForm;
}

function renderAddCarbForm() {
  const f = state.addCarbForm;
  if (!f) {
    return `<button class="add-step-btn" style="margin:12px 0" onclick="openAddCarbForm()">+ Add Carb</button>`;
  }
  const esc = s => (s || '').replace(/"/g, '&quot;');
  return `
    <div class="sm-add-form">
      <div class="sm-add-form-title">New Carb</div>
      <input class="builder-input" placeholder="Name (e.g. Quinoa)" value="${esc(f.name)}" oninput="state.addCarbForm.name=this.value">
      <input class="builder-input" placeholder="Emoji (e.g. 🌾)" value="${esc(f.emoji)}" oninput="state.addCarbForm.emoji=this.value">
      <input class="builder-input" placeholder="Description" value="${esc(f.description)}" oninput="state.addCarbForm.description=this.value">
      <div style="display:flex;gap:8px">
        <input class="builder-input" type="number" placeholder="Cook time (min)" value="${f.cookTimeMinutes || ''}" style="flex:1" oninput="state.addCarbForm.cookTimeMinutes=parseInt(this.value)||0">
        <input class="builder-input" placeholder="Label (e.g. 15 min)" value="${esc(f.cookTimeLabel)}" style="flex:1" oninput="state.addCarbForm.cookTimeLabel=this.value">
      </div>
      ${f.error ? `<div class="settings-error">${f.error}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="builder-primary-btn" style="flex:1" onclick="adminAddCarb()" ${f.saving ? 'disabled' : ''}>
          ${f.saving ? '<span class="spinner-sm"></span> Saving…' : 'Add Carb'}
        </button>
        <button class="builder-secondary-btn" onclick="closeAddCarbForm()">Cancel</button>
      </div>
    </div>`;
}

function renderAddonsTab(isAdmin) {
  const src = state.addons || { proteins: [], veggies: [] };
  const addonRow = (a) => `
    <div class="admin-sauce-row">
      <span class="sm-carb-emoji">${a.emoji}</span>
      <div class="admin-sauce-info">
        <div class="admin-sauce-name">${a.name} <span class="sm-type-badge sm-type-${a.type}">${a.type}</span></div>
        <div class="admin-sauce-carbs">~${a.estimatedTime}m · ${a.desc}</div>
      </div>
    </div>`;

  const rows = [...src.proteins, ...src.veggies].map(addonRow).join('');
  const addForm = isAdmin ? renderAddAddonForm() : '';

  return rows + addForm;
}

function renderAddAddonForm() {
  const f = state.addAddonForm;
  if (!f) {
    return `<button class="add-step-btn" style="margin:12px 0" onclick="openAddAddonForm()">+ Add Add-on</button>`;
  }
  const esc = s => (s || '').replace(/"/g, '&quot;');
  return `
    <div class="sm-add-form">
      <div class="sm-add-form-title">New Add-on</div>
      <select class="ing-unit" style="width:100%;margin-bottom:8px" onchange="state.addAddonForm.type=this.value">
        <option value="protein" ${f.type === 'protein' ? 'selected' : ''}>Protein</option>
        <option value="veggie" ${f.type === 'veggie' ? 'selected' : ''}>Veggie</option>
      </select>
      <input class="builder-input" placeholder="Name (e.g. Shrimp)" value="${esc(f.name)}" oninput="state.addAddonForm.name=this.value">
      <input class="builder-input" placeholder="Emoji (e.g. 🍤)" value="${esc(f.emoji)}" oninput="state.addAddonForm.emoji=this.value">
      <input class="builder-input" placeholder="Short description" value="${esc(f.desc)}" oninput="state.addAddonForm.desc=this.value">
      <input class="builder-input" type="number" placeholder="Cook time (min)" value="${f.estimatedTime || ''}" oninput="state.addAddonForm.estimatedTime=parseInt(this.value)||0">
      <textarea class="builder-input" placeholder="Instructions" style="min-height:80px;resize:vertical" oninput="state.addAddonForm.instructions=this.value">${esc(f.instructions)}</textarea>
      ${f.error ? `<div class="settings-error">${f.error}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="builder-primary-btn" style="flex:1" onclick="adminAddAddon()" ${f.saving ? 'disabled' : ''}>
          ${f.saving ? '<span class="spinner-sm"></span> Saving…' : 'Add Add-on'}
        </button>
        <button class="builder-secondary-btn" onclick="closeAddAddonForm()">Cancel</button>
      </div>
    </div>`;
}

// ─── Sauce Manager Actions ────────────────────────────────────────────────────
async function openSauceManager() {
  state.adminError = null;
  state.sauceManagerTab = 'sauces';
  state.addCarbForm = null;
  state.addAddonForm = null;
  state.carbPreparations = null;
  try {
    state.adminSauces = await fetchAllSauces();
  } catch (err) {
    state.adminSauces = [];
    state.adminError = `Failed to load sauces: ${err.message}`;
  }
  navigate('admin');
}

function openSettings() {
  state.adminError = null;
  navigate('settings');
}

function setSauceManagerTab(tab) {
  state.sauceManagerTab = tab;
  state.addCarbForm = null;
  state.addAddonForm = null;
  if (tab === 'carbs' && !state.carbPreparations) loadCarbPreparations();
  render();
}

async function loadCarbPreparations() {
  const pairs = await Promise.all(
    state.carbs.map(c =>
      fetchPreparationsForCarb(c.id)
        .then(preps => [c.id, preps])
        .catch(() => [c.id, []])
    )
  );
  state.carbPreparations = Object.fromEntries(pairs);
  render();
}

function selectSauceFromManager(id) {
  const sauce = state.adminSauces.find(s => s.id === id);
  if (!sauce) return;
  state.selectedSauce = sauce;
  state.selectedCarb = null;
  state.selectedPrep = null;
  navigate('recipe');
}

function openBuilderEdit(id) {
  const sauce = state.adminSauces.find(s => s.id === id);
  if (!sauce) return;
  state.builder = {
    ...defaultBuilder(),
    name: sauce.name,
    cuisine: sauce.cuisine,
    cuisineEmoji: sauce.cuisineEmoji || '',
    color: sauce.color || '#E85D04',
    description: sauce.description || '',
    carbIds: sauce.compatibleCarbs || [],
    steps: (sauce.steps || []).map(s => ({
      title: s.title,
      inputFromStep: s.inputFromStep || null,
      ingredients: (s.ingredients || []).map(i => ({
        name: i.name, amount: i.amount, unit: i.unit,
      })),
    })),
  };
  navigate('builder');
}

// ─── Admin Auth ────────────────────────────────────────────────────────────────
async function submitAdminPassword() {
  const input = document.getElementById('admin-password-input');
  if (!input || !input.value.trim()) return;
  const key = input.value.trim();
  state.adminLoading = true;
  state.adminError = null;
  render();
  try {
    await fetchAdminSauces(key); // verify the key
    state.adminKey = key;
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

// ─── Sauce Delete ──────────────────────────────────────────────────────────────
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

// ─── Add Carb ─────────────────────────────────────────────────────────────────
function openAddCarbForm() {
  state.addCarbForm = { name: '', emoji: '', description: '', cookTimeMinutes: 0, cookTimeLabel: '', saving: false, error: null };
  render();
}

function closeAddCarbForm() {
  state.addCarbForm = null;
  render();
}

async function adminAddCarb() {
  const f = state.addCarbForm;
  if (!f || !f.name.trim() || !f.emoji.trim()) {
    if (f) f.error = 'Name and emoji are required.';
    render();
    return;
  }
  f.saving = true;
  f.error = null;
  render();
  try {
    const result = await adminCreateCarb({
      name: f.name.trim(),
      emoji: f.emoji.trim(),
      description: f.description.trim(),
      cookTimeMinutes: f.cookTimeMinutes || 0,
      cookTimeLabel: f.cookTimeLabel.trim(),
    }, state.adminKey);
    state.carbs.push({
      id: result.id,
      name: f.name.trim(),
      emoji: f.emoji.trim(),
      desc: f.description.trim(),
      cookTimeMinutes: f.cookTimeMinutes || 0,
      cookTimeLabel: f.cookTimeLabel.trim(),
      sauceCount: 0,
    });
    state.addCarbForm = null;
    render();
  } catch (err) {
    f.saving = false;
    f.error = err.message;
    render();
  }
}

// ─── Add Add-on ───────────────────────────────────────────────────────────────
function openAddAddonForm() {
  state.addAddonForm = { type: 'protein', name: '', emoji: '', desc: '', estimatedTime: 0, instructions: '', saving: false, error: null };
  render();
}

function closeAddAddonForm() {
  state.addAddonForm = null;
  render();
}

async function adminAddAddon() {
  const f = state.addAddonForm;
  if (!f || !f.name.trim() || !f.emoji.trim() || !f.instructions.trim() || !f.estimatedTime) {
    if (f) f.error = 'Name, emoji, cook time, and instructions are required.';
    render();
    return;
  }
  f.saving = true;
  f.error = null;
  render();
  try {
    const result = await adminCreateAddon({
      type: f.type,
      name: f.name.trim(),
      emoji: f.emoji.trim(),
      desc: f.desc.trim(),
      estimatedTime: f.estimatedTime,
      instructions: f.instructions.trim(),
    }, state.adminKey);
    const newAddon = {
      id: result.id,
      type: f.type,
      name: f.name.trim(),
      emoji: f.emoji.trim(),
      desc: f.desc.trim(),
      estimatedTime: f.estimatedTime,
      instructions: f.instructions.trim(),
    };
    if (!state.addons) state.addons = { proteins: [], veggies: [] };
    if (f.type === 'protein') state.addons.proteins.push(newAddon);
    else state.addons.veggies.push(newAddon);
    state.addAddonForm = null;
    render();
  } catch (err) {
    f.saving = false;
    f.error = err.message;
    render();
  }
}
