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
      <button class="sm-tab ${tab === 'items' ? 'sm-tab-active' : ''}" onclick="setSauceManagerTab('items')">Items</button>
    </div>`;

  let bodyHTML = '';
  if (tab === 'sauces') bodyHTML = renderSaucesTab(isAdmin);
  else bodyHTML = renderItemsTab(isAdmin);

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

function renderItemsTab(isAdmin) {
  return renderItemSection('carbs', 'Carbs', state.carbs || [], isAdmin)
       + renderItemSection('proteins', 'Proteins', state.proteins || [], isAdmin);
}

function renderItemSection(key, label, list, isAdmin) {
  const open = !!state.itemSections[key];
  const body = open
    ? list.map(it => renderItemRow(it, key, isAdmin)).join('')
      + (isAdmin ? (key === 'carbs' ? renderAddCarbForm() : renderAddProteinForm()) : '')
    : '';
  return `
    <div class="admin-cuisine-group">
      <div class="admin-cuisine-header" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between" onclick="toggleItemSection('${key}')">
        <span>${label} <span class="admin-count">${list.length}</span></span>
        <i data-lucide="${open ? 'chevron-down' : 'chevron-right'}"></i>
      </div>
      ${body}
    </div>`;
}

function renderItemRow(it, sectionKey, isAdmin) {
  if (state.editItemForm && state.editItemForm.id === it.id) return renderEditItemForm();
  const safeName = (it.name || '').replace(/'/g, "\\'");
  const sub = sectionKey === 'carbs'
    ? `${it.cookTimeMinutes ? it.cookTimeMinutes + ' min' : ''}${it.cookTimeMinutes ? ' · ' : ''}${it.sauceCount || 0} sauce${it.sauceCount !== 1 ? 's' : ''}`
    : `~${it.estimatedTime || it.cookTimeMinutes || 0}m · ${it.desc || it.description || ''}`;
  return `
    <div class="admin-sauce-row">
      <span class="sm-carb-emoji">${it.emoji}</span>
      <div class="admin-sauce-info">
        <div class="admin-sauce-name">${it.name}</div>
        <div class="admin-sauce-carbs">${sub}</div>
      </div>
      ${isAdmin ? `
        <button class="admin-edit-btn" onclick="openEditItemForm('${it.id}', '${sectionKey}')">Edit</button>
        <button class="admin-delete-btn" onclick="adminDeleteItemAction('${it.id}', '${sectionKey}', '${safeName}')">Delete</button>
      ` : ''}
    </div>`;
}

function renderEditItemForm() {
  const f = state.editItemForm;
  const esc = s => (s || '').replace(/"/g, '&quot;');
  const isProtein = f.category === 'protein';
  const isCarb = f.category === 'carb';
  return `
    <div class="sm-add-form">
      <div class="sm-add-form-title">Edit ${isProtein ? 'Protein' : 'Carb'}</div>
      <input class="builder-input" placeholder="Name" value="${esc(f.name)}" oninput="state.editItemForm.name=this.value">
      <input class="builder-input" placeholder="Emoji" value="${esc(f.emoji)}" oninput="state.editItemForm.emoji=this.value">
      <input class="builder-input" placeholder="Description" value="${esc(f.description)}" oninput="state.editItemForm.description=this.value">
      <div style="display:flex;gap:8px">
        <input class="builder-input" type="number" placeholder="Cook time (min)" value="${f.cookTimeMinutes || ''}" style="flex:1" oninput="state.editItemForm.cookTimeMinutes=parseInt(this.value)||0">
        <input class="builder-input" type="number" placeholder="Portion (g/person)" value="${f.portionPerPerson || ''}" style="flex:1" oninput="state.editItemForm.portionPerPerson=parseFloat(this.value)||0">
      </div>
      ${isProtein ? `<textarea class="builder-input" placeholder="Instructions" style="min-height:80px;resize:vertical" oninput="state.editItemForm.instructions=this.value">${esc(f.instructions)}</textarea>` : ''}
      ${isCarb ? `<input class="builder-input" placeholder="Water ratio (e.g. 2:1, optional)" value="${esc(f.waterRatio)}" oninput="state.editItemForm.waterRatio=this.value">` : ''}
      ${f.error ? `<div class="settings-error">${f.error}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="builder-primary-btn" style="flex:1" onclick="adminUpdateItemAction()" ${f.saving ? 'disabled' : ''}>
          ${f.saving ? '<span class="spinner-sm"></span> Saving…' : 'Save'}
        </button>
        <button class="builder-secondary-btn" onclick="closeEditItemForm()">Cancel</button>
      </div>
    </div>`;
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
        <input class="builder-input" type="number" placeholder="Portion (g/person)" value="${f.portionPerPerson || ''}" style="flex:1" oninput="state.addCarbForm.portionPerPerson=parseFloat(this.value)||0">
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

function renderAddProteinForm() {
  const f = state.addProteinForm;
  if (!f) {
    return `<button class="add-step-btn" style="margin:12px 0" onclick="openAddProteinForm()">+ Add Protein</button>`;
  }
  const esc = s => (s || '').replace(/"/g, '&quot;');
  return `
    <div class="sm-add-form">
      <div class="sm-add-form-title">New Protein</div>
      <input class="builder-input" placeholder="Name (e.g. Shrimp)" value="${esc(f.name)}" oninput="state.addProteinForm.name=this.value">
      <input class="builder-input" placeholder="Emoji (e.g. 🍤)" value="${esc(f.emoji)}" oninput="state.addProteinForm.emoji=this.value">
      <input class="builder-input" placeholder="Short description" value="${esc(f.desc)}" oninput="state.addProteinForm.desc=this.value">
      <div style="display:flex;gap:8px">
        <input class="builder-input" type="number" placeholder="Cook time (min)" value="${f.estimatedTime || ''}" style="flex:1" oninput="state.addProteinForm.estimatedTime=parseInt(this.value)||0">
        <input class="builder-input" type="number" placeholder="Portion (g/person)" value="${f.portionPerPerson || ''}" style="flex:1" oninput="state.addProteinForm.portionPerPerson=parseFloat(this.value)||0">
      </div>
      <textarea class="builder-input" placeholder="Instructions" style="min-height:80px;resize:vertical" oninput="state.addProteinForm.instructions=this.value">${esc(f.instructions)}</textarea>
      ${f.error ? `<div class="settings-error">${f.error}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="builder-primary-btn" style="flex:1" onclick="adminAddProtein()" ${f.saving ? 'disabled' : ''}>
          ${f.saving ? '<span class="spinner-sm"></span> Saving…' : 'Add Protein'}
        </button>
        <button class="builder-secondary-btn" onclick="closeAddProteinForm()">Cancel</button>
      </div>
    </div>`;
}

// ─── Sauce Manager Actions ────────────────────────────────────────────────────
async function openSauceManager() {
  state.adminError = null;
  state.sauceManagerTab = 'sauces';
  state.addCarbForm = null;
  state.addProteinForm = null;
  state.editItemForm = null;
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
  state.addProteinForm = null;
  state.editItemForm = null;
  render();
}

function toggleItemSection(key) {
  state.itemSections[key] = !state.itemSections[key];
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
  state.addCarbForm = { name: '', emoji: '', description: '', cookTimeMinutes: 0, portionPerPerson: 100, saving: false, error: null };
  render();
}

function closeAddCarbForm() {
  state.addCarbForm = null;
  render();
}

async function adminAddCarb() {
  const f = state.addCarbForm;
  if (!f || !f.name.trim() || !f.emoji.trim() || !f.portionPerPerson) {
    if (f) f.error = 'Name, emoji, and portion are required.';
    render();
    return;
  }
  f.saving = true;
  f.error = null;
  render();
  try {
    const result = await adminCreateItem({
      category: 'carb',
      name: f.name.trim(),
      emoji: f.emoji.trim(),
      description: f.description.trim(),
      cookTimeMinutes: f.cookTimeMinutes || 0,
      portionPerPerson: f.portionPerPerson,
      portionUnit: 'g',
    }, state.adminKey);
    state.carbs.push({
      id: result.id,
      name: f.name.trim(),
      emoji: f.emoji.trim(),
      description: f.description.trim(),
      desc: f.description.trim(),
      cookTimeMinutes: f.cookTimeMinutes || 0,
      portionPerPerson: f.portionPerPerson,
      portionUnit: 'g',
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

// ─── Add Protein ──────────────────────────────────────────────────────────────
function openAddProteinForm() {
  state.addProteinForm = { name: '', emoji: '', desc: '', estimatedTime: 0, portionPerPerson: 150, instructions: '', saving: false, error: null };
  render();
}

function closeAddProteinForm() {
  state.addProteinForm = null;
  render();
}

async function adminAddProtein() {
  const f = state.addProteinForm;
  if (!f || !f.name.trim() || !f.emoji.trim() || !f.instructions.trim() || !f.estimatedTime) {
    if (f) f.error = 'Name, emoji, cook time, and instructions are required.';
    render();
    return;
  }
  f.saving = true;
  f.error = null;
  render();
  try {
    const result = await adminCreateItem({
      category: 'protein',
      name: f.name.trim(),
      emoji: f.emoji.trim(),
      description: f.desc.trim(),
      cookTimeMinutes: f.estimatedTime,
      instructions: f.instructions.trim(),
      portionPerPerson: f.portionPerPerson,
      portionUnit: 'g',
    }, state.adminKey);
    state.proteins.push({
      id: result.id,
      name: f.name.trim(),
      emoji: f.emoji.trim(),
      desc: f.desc.trim(),
      estimatedTime: f.estimatedTime,
      instructions: f.instructions.trim(),
      portionPerPerson: f.portionPerPerson,
      portionUnit: 'g',
      marinadeCount: 0,
    });
    state.addProteinForm = null;
    render();
  } catch (err) {
    f.saving = false;
    f.error = err.message;
    render();
  }
}

// ─── Edit / Delete Item ──────────────────────────────────────────────────────
function openEditItemForm(id, sectionKey) {
  const list = sectionKey === 'carbs' ? state.carbs : state.proteins;
  const it = (list || []).find(x => x.id === id);
  if (!it) return;
  const category = sectionKey === 'carbs' ? 'carb' : 'protein';
  state.editItemForm = {
    id: it.id,
    category,
    name: it.name || '',
    emoji: it.emoji || '',
    description: it.description || it.desc || '',
    cookTimeMinutes: it.cookTimeMinutes || it.estimatedTime || 0,
    portionPerPerson: it.portionPerPerson || 0,
    portionUnit: it.portionUnit || 'g',
    instructions: it.instructions || '',
    waterRatio: it.waterRatio || '',
    saving: false,
    error: null,
  };
  state.addCarbForm = null;
  state.addProteinForm = null;
  render();
}

function closeEditItemForm() {
  state.editItemForm = null;
  render();
}

async function adminUpdateItemAction() {
  const f = state.editItemForm;
  if (!f) return;
  if (!f.name.trim() || !f.emoji.trim()) {
    f.error = 'Name and emoji are required.';
    render();
    return;
  }
  f.saving = true;
  f.error = null;
  render();
  const payload = {
    name: f.name.trim(),
    emoji: f.emoji.trim(),
    description: f.description.trim(),
    cookTimeMinutes: f.cookTimeMinutes || 0,
    portionPerPerson: f.portionPerPerson || null,
    portionUnit: f.portionUnit || 'g',
  };
  if (f.category === 'protein') payload.instructions = f.instructions.trim();
  if (f.category === 'carb') payload.waterRatio = f.waterRatio ? f.waterRatio.trim() : null;
  try {
    await adminUpdateItem(f.id, payload, state.adminKey);
    const list = f.category === 'carb' ? state.carbs : state.proteins;
    const idx = list.findIndex(x => x.id === f.id);
    if (idx >= 0) {
      const existing = list[idx];
      list[idx] = {
        ...existing,
        name: payload.name,
        emoji: payload.emoji,
        description: payload.description,
        desc: payload.description,
        cookTimeMinutes: payload.cookTimeMinutes,
        estimatedTime: payload.cookTimeMinutes,
        portionPerPerson: payload.portionPerPerson || existing.portionPerPerson,
        portionUnit: payload.portionUnit,
        instructions: f.category === 'protein' ? payload.instructions : existing.instructions,
        waterRatio: f.category === 'carb' ? payload.waterRatio : existing.waterRatio,
      };
    }
    state.editItemForm = null;
    render();
  } catch (err) {
    f.saving = false;
    f.error = err.message;
    render();
  }
}

async function adminDeleteItemAction(id, sectionKey, name) {
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  try {
    await adminDeleteItem(id, state.adminKey);
    if (sectionKey === 'carbs') {
      state.carbs = state.carbs.filter(c => c.id !== id);
    } else {
      state.proteins = (state.proteins || []).filter(p => p.id !== id);
    }
    if (state.editItemForm && state.editItemForm.id === id) state.editItemForm = null;
    render();
  } catch (err) {
    state.adminError = `Failed to delete: ${err.message}`;
    render();
  }
}
