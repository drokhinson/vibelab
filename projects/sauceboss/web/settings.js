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
  const search = state.sauceManagerSearch || '';
  const typeFilter = state.sauceManagerTypeFilter || 'all';

  const tabBar = `
    <div class="sauce-manager-tabs">
      <button class="sm-tab ${tab === 'sauces' ? 'sm-tab-active' : ''}" onclick="setSauceManagerTab('sauces')">Sauces</button>
      <button class="sm-tab ${tab === 'dish' ? 'sm-tab-active' : ''}" onclick="setSauceManagerTab('dish')">Dish</button>
    </div>`;

  const searchPlaceholder = tab === 'sauces' ? 'Search sauces, cuisine, ingredients…' : 'Search items…';
  const searchBar = `
    <div class="sm-search-wrap">
      <span class="sm-search-icon"><i data-lucide="search"></i></span>
      <input
        id="sm-search-input"
        type="text"
        class="sm-search-input"
        placeholder="${searchPlaceholder}"
        value="${search.replace(/"/g, '&quot;')}"
        oninput="setSauceManagerSearch(this.value)"
      >
      ${search ? `<button class="sm-search-clear" onclick="setSauceManagerSearch('')" aria-label="Clear search"><i data-lucide="x"></i></button>` : ''}
    </div>`;

  const typeFilterRow = tab === 'sauces' ? `
    <div class="sm-type-filter">
      <button class="sm-type-pill ${typeFilter === 'all' ? 'sm-type-pill-active' : ''}" onclick="setSauceManagerTypeFilter('all')">All</button>
      ${SAUCE_TYPES.map(t => `
        <button class="sm-type-pill ${typeFilter === t.value ? 'sm-type-pill-active' : ''}" onclick="setSauceManagerTypeFilter('${t.value}')">${t.label}</button>
      `).join('')}
    </div>` : '';

  let bodyHTML = '';
  if (tab === 'sauces') bodyHTML = renderSaucesTab(isAdmin);
  else bodyHTML = renderDishTab(isAdmin);

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
    ${searchBar}
    ${typeFilterRow}
    <div class="scroll-body">
      ${bodyHTML}
    </div>
  `;
}

function renderSaucesTab(isAdmin) {
  const typeFilter = state.sauceManagerTypeFilter || 'all';
  const q = (state.sauceManagerSearch || '').trim().toLowerCase();

  const filtered = state.adminSauces.filter(s => {
    if (typeFilter !== 'all' && (s.sauceType || 'sauce') !== typeFilter) return false;
    if (!q) return true;
    const haystack = [
      s.name || '',
      s.cuisine || '',
      (s.compatibleItems || []).join(' '),
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });

  if (state.adminSauces.length === 0) {
    return '<p style="padding:16px;color:#888">No sauces found.</p>';
  }
  if (filtered.length === 0) {
    return '<p style="padding:16px;color:#888">No sauces match your filters.</p>';
  }

  const grouped = {};
  for (const sauce of filtered) {
    if (!grouped[sauce.cuisine]) grouped[sauce.cuisine] = [];
    grouped[sauce.cuisine].push(sauce);
  }
  const cuisines = Object.keys(grouped).sort();

  return cuisines.map(cuisine => `
    <div class="admin-cuisine-group">
      <div class="admin-cuisine-header">${cuisine} <span class="admin-count">${grouped[cuisine].length}</span></div>
      ${grouped[cuisine].map(s => {
        const safeName = s.name.replace(/'/g, "\\'");
        const typeValue = s.sauceType || 'sauce';
        const typeMeta = SAUCE_TYPES.find(t => t.value === typeValue) || SAUCE_TYPES[0];
        return `
        <div class="admin-sauce-row" onclick="selectSauceFromManager('${s.id}')">
          <span class="sauce-dot" style="background:${s.color || '#999'}"></span>
          <div class="admin-sauce-info">
            <div class="admin-sauce-name">${s.name}</div>
            <div class="admin-sauce-carbs">${(s.compatibleItems || []).join(' · ')}</div>
          </div>
          <span class="sauce-type-tag sauce-type-${typeValue}">${typeMeta.label}</span>
          ${isAdmin ? `
            <button class="admin-edit-btn" onclick="event.stopPropagation(); openBuilderEdit('${s.id}')">Edit</button>
            <button class="admin-delete-btn" onclick="event.stopPropagation(); adminDeleteSauce('${s.id}', '${safeName}')">Delete</button>
          ` : ''}
        </div>`;
      }).join('')}
    </div>
  `).join('');
}

// ─── Dish Tab (carbs / proteins / salads as parents with variants) ───────────
const SECTION_META = [
  { key: 'carbs',    label: 'Carbs',    category: 'carb',    addLabel: 'Carb' },
  { key: 'proteins', label: 'Proteins', category: 'protein', addLabel: 'Protein' },
  { key: 'salads',   label: 'Salads',   category: 'salad',   addLabel: 'Salad' },
];

function renderDishTab(isAdmin) {
  const items = state.adminItems || { carbs: [], proteins: [], salads: [] };
  const q = (state.sauceManagerSearch || '').trim().toLowerCase();
  const matches = name => (name || '').toLowerCase().includes(q);

  const filteredBySection = {};
  let totalShown = 0;
  for (const sec of SECTION_META) {
    const list = items[sec.key] || [];
    if (!q) {
      filteredBySection[sec.key] = list;
      totalShown += list.length;
      continue;
    }
    const kept = [];
    for (const parent of list) {
      const parentMatch = matches(parent.name);
      const matchedVariants = (parent.variants || []).filter(v => matches(v.name));
      if (parentMatch) {
        kept.push(parent);
      } else if (matchedVariants.length > 0) {
        state.expandedParents[parent.id] = true;
        kept.push({ ...parent, variants: matchedVariants });
      }
    }
    filteredBySection[sec.key] = kept;
    totalShown += kept.length;
  }

  if (q && totalShown === 0) {
    return '<p style="padding:16px;color:#888">No items match your search.</p>';
  }

  return SECTION_META
    .map(sec => renderDishSection(sec, filteredBySection[sec.key] || [], isAdmin))
    .join('');
}

function renderDishSection(sec, parents, isAdmin) {
  const open = !!state.itemSections[sec.key];
  const f = state.itemForm;
  const showAddForm = open && isAdmin && f && f.mode === 'add' && f.category === sec.category && !f.parentId;
  const totalCount = parents.reduce((n, p) => n + 1 + (p.variants ? p.variants.length : 0), 0);
  const body = open ? `
      ${showAddForm ? renderItemForm() : ''}
      ${parents.map(p => renderParent(p, sec, isAdmin)).join('')}
      ${isAdmin && !showAddForm ? `
        <button class="add-step-btn" style="margin:12px 16px" onclick="openAddItemForm('${sec.category}', null)">+ Add ${sec.addLabel}</button>
      ` : ''}
    ` : '';
  return `
    <div class="admin-cuisine-group">
      <div class="admin-cuisine-header" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between" onclick="toggleItemSection('${sec.key}')">
        <span>${sec.label} <span class="admin-count">${totalCount}</span></span>
        <i data-lucide="${open ? 'chevron-down' : 'chevron-right'}"></i>
      </div>
      ${body}
    </div>`;
}

function renderParent(parent, sec, isAdmin) {
  const f = state.itemForm;
  const isEditing = f && f.mode === 'edit' && f.id === parent.id;
  const showAddVariantForm = isAdmin && f && f.mode === 'add' && f.parentId === parent.id;
  const expanded = !!state.expandedParents[parent.id];
  const variants = parent.variants || [];
  const hasVariants = variants.length > 0;
  const canExpand = hasVariants || isAdmin;
  if (isEditing) return `<div style="padding:0 16px">${renderItemForm()}</div>`;
  const safeName = (parent.name || '').replace(/'/g, "\\'");
  const sub = sec.category === 'carb'
    ? `${variants.length} variant${variants.length !== 1 ? 's' : ''}${parent.cookTimeMinutes ? ' · ' + parent.cookTimeMinutes + ' min' : ''}`
    : sec.category === 'protein'
      ? `${variants.length} variant${variants.length !== 1 ? 's' : ''}${parent.cookTimeMinutes ? ' · ' + parent.cookTimeMinutes + ' min' : ''}`
      : `${variants.length} variant${variants.length !== 1 ? 's' : ''}`;
  return `
    <div class="admin-parent-row" style="padding:10px 16px;border-top:1px solid #f0e6d6;display:flex;align-items:center;gap:8px;cursor:${canExpand ? 'pointer' : 'default'}" ${canExpand ? `onclick="toggleParentExpansion('${parent.id}')"` : ''}>
      <span class="parent-chevron" style="display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;${canExpand ? '' : 'visibility:hidden'}"><i data-lucide="${expanded ? 'chevron-down' : 'chevron-right'}"></i></span>
      <span class="sm-carb-emoji">${parent.emoji || ''}</span>
      <div class="admin-sauce-info" style="flex:1">
        <div class="admin-sauce-name">${parent.name}</div>
        <div class="admin-sauce-carbs">${sub}</div>
      </div>
      ${isAdmin ? `
        <button class="admin-edit-btn" onclick="event.stopPropagation(); openEditItemFormById('${parent.id}')">Edit</button>
        <button class="admin-delete-btn" onclick="event.stopPropagation(); adminDeleteItemAction('${parent.id}','${safeName}',${hasVariants ? 'true' : 'false'})">Delete</button>
      ` : ''}
    </div>
    ${expanded ? `
      <div style="padding-left:12px">
        ${showAddVariantForm ? `<div style="padding:0 16px">${renderItemForm()}</div>` : ''}
        ${variants.map(v => renderVariantRow(v, sec, isAdmin)).join('')}
        ${isAdmin && !showAddVariantForm ? `
          <button class="add-step-btn" style="margin:8px 16px" onclick="event.stopPropagation(); openAddItemForm('${sec.category}','${parent.id}')">+ Add Variant</button>
        ` : ''}
      </div>
    ` : ''}`;
}

function renderVariantRow(v, sec, isAdmin) {
  const f = state.itemForm;
  if (f && f.mode === 'edit' && f.id === v.id) return `<div style="padding:0 16px">${renderItemForm()}</div>`;
  const safeName = (v.name || '').replace(/'/g, "\\'");
  const sub = `${v.cookTimeMinutes ? v.cookTimeMinutes + ' min' : ''}${v.cookTimeMinutes && v.description ? ' · ' : ''}${v.description || ''}`;
  return `
    <div class="admin-sauce-row" style="padding-left:38px">
      <span class="sm-carb-emoji">${v.emoji || ''}</span>
      <div class="admin-sauce-info">
        <div class="admin-sauce-name">${v.name}</div>
        <div class="admin-sauce-carbs">${sub}</div>
      </div>
      ${isAdmin ? `
        <button class="admin-edit-btn" onclick="openEditItemFormById('${v.id}')">Edit</button>
        <button class="admin-delete-btn" onclick="adminDeleteItemAction('${v.id}','${safeName}',false)">Delete</button>
      ` : ''}
    </div>`;
}

// ─── Shared Add/Edit Item Form ────────────────────────────────────────────────
function renderItemForm() {
  const f = state.itemForm;
  if (!f) return '';
  const esc = s => (s || '').replace(/"/g, '&quot;');
  const isVariant = !!f.parentId;
  const isProtein = f.category === 'protein';
  const isCarb = f.category === 'carb';
  const titleCategory = f.category === 'carb' ? 'Carb' : f.category === 'protein' ? 'Protein' : 'Salad';
  const titleKind = isVariant ? 'Variant' : titleCategory;
  const titleAction = f.mode === 'edit' ? 'Edit' : `New`;
  return `
    <div class="sm-add-form">
      <div class="sm-add-form-title">${titleAction} ${titleKind}${isVariant && f.mode === 'add' ? ` of ${f.parentName || ''}` : ''}</div>
      <input class="builder-input" placeholder="Name (e.g. ${isVariant ? 'Strips' : 'Beef'})" value="${esc(f.name)}" oninput="state.itemForm.name=this.value">
      <input class="builder-input" placeholder="Emoji" value="${esc(f.emoji)}" oninput="state.itemForm.emoji=this.value">
      <input class="builder-input" placeholder="Description" value="${esc(f.description)}" oninput="state.itemForm.description=this.value">
      <div style="display:flex;gap:8px">
        <input class="builder-input" type="number" placeholder="Cook time (min)" value="${f.cookTimeMinutes || ''}" style="flex:1" oninput="state.itemForm.cookTimeMinutes=parseInt(this.value)||0">
        <input class="builder-input" type="number" placeholder="Portion (g/person)" value="${f.portionPerPerson || ''}" style="flex:1" oninput="state.itemForm.portionPerPerson=parseFloat(this.value)||0">
      </div>
      ${isProtein || isVariant ? `<textarea class="builder-input" placeholder="Instructions${isVariant ? ' (how to cook this variant)' : ''}" style="min-height:80px;resize:vertical" oninput="state.itemForm.instructions=this.value">${esc(f.instructions)}</textarea>` : ''}
      ${isCarb ? `<input class="builder-input" placeholder="Water ratio (e.g. 2:1, optional)" value="${esc(f.waterRatio)}" oninput="state.itemForm.waterRatio=this.value">` : ''}
      ${f.error ? `<div class="settings-error">${f.error}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="builder-primary-btn" style="flex:1" onclick="adminSaveItemAction()" ${f.saving ? 'disabled' : ''}>
          ${f.saving ? '<span class="spinner-sm"></span> Saving…' : (f.mode === 'edit' ? 'Save' : `Add ${titleKind}`)}
        </button>
        <button class="builder-secondary-btn" onclick="closeItemForm()">Cancel</button>
      </div>
    </div>`;
}

// ─── Sauce Manager Lifecycle ──────────────────────────────────────────────────
async function openSauceManager() {
  state.adminError = null;
  state.sauceManagerTab = 'sauces';
  state.sauceManagerSearch = '';
  state.sauceManagerTypeFilter = 'all';
  state.itemForm = null;
  try {
    const [sauces, items] = await Promise.all([
      fetchAllSauces(),
      fetchItems().catch(() => null),
    ]);
    state.adminSauces = sauces;
    if (items) state.adminItems = { carbs: items.carbs || [], proteins: items.proteins || [], salads: items.salads || [] };
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
  state.itemForm = null;
  render();
  if (tab === 'dish') {
    refreshAdminItems();
  }
}

function setSauceManagerSearch(value) {
  state.sauceManagerSearch = value || '';
  const wasFocused = document.activeElement && document.activeElement.id === 'sm-search-input';
  const caret = wasFocused ? document.activeElement.selectionStart : null;
  render();
  if (wasFocused) {
    const el = document.getElementById('sm-search-input');
    if (el) {
      el.focus();
      if (caret != null) {
        try { el.setSelectionRange(caret, caret); } catch (e) {}
      }
    }
  }
}

function setSauceManagerTypeFilter(value) {
  state.sauceManagerTypeFilter = value || 'all';
  render();
}

async function refreshAdminItems() {
  try {
    const items = await fetchItems();
    state.adminItems = { carbs: items.carbs || [], proteins: items.proteins || [], salads: items.salads || [] };
    render();
  } catch (err) {
    state.adminError = `Failed to load items: ${err.message}`;
    render();
  }
}

function toggleItemSection(key) {
  state.itemSections[key] = !state.itemSections[key];
  render();
}

function toggleParentExpansion(parentId) {
  state.expandedParents[parentId] = !state.expandedParents[parentId];
  render();
}

function selectSauceFromManager(id) {
  const sauce = state.adminSauces.find(s => s.id === id);
  if (!sauce) return;
  if (!sauce.ingredientNames) {
    sauce.ingredientNames = new Set((sauce.ingredients || []).map(i => i.name));
  }
  state.selectedSauce       = sauce;
  state.selectedItem        = null;
  state.selectedPrep        = null;
  state.disabledIngredients = new Set();
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
    sauceType: sauce.sauceType || 'sauce',
    itemIds: sauce.compatibleItems || [],
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

// ─── Admin Auth ───────────────────────────────────────────────────────────────
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

// ─── Sauce Delete ─────────────────────────────────────────────────────────────
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

// ─── Item Add / Edit / Delete (parents and variants) ─────────────────────────
function findItemAndContext(id) {
  for (const sec of SECTION_META) {
    const list = (state.adminItems && state.adminItems[sec.key]) || [];
    for (const parent of list) {
      if (parent.id === id) return { item: parent, sec, isVariant: false, parent: null };
      if (parent.variants) {
        const variant = parent.variants.find(v => v.id === id);
        if (variant) return { item: variant, sec, isVariant: true, parent };
      }
    }
  }
  return null;
}

function defaultPortion(category) {
  if (category === 'carb') return 100;
  if (category === 'protein') return 150;
  return 80; // salad
}

function openAddItemForm(category, parentId) {
  let parentName = '';
  if (parentId) {
    const ctx = findItemAndContext(parentId);
    if (ctx) parentName = ctx.item.name;
  }
  state.itemForm = {
    mode: 'add',
    id: null,
    category,
    parentId: parentId || null,
    parentName,
    name: '',
    emoji: '',
    description: '',
    cookTimeMinutes: 0,
    instructions: '',
    waterRatio: '',
    portionPerPerson: defaultPortion(category),
    portionUnit: 'g',
    saving: false,
    error: null,
  };
  if (parentId) state.expandedParents[parentId] = true;
  render();
}

function openEditItemFormById(id) {
  const ctx = findItemAndContext(id);
  if (!ctx) return;
  const it = ctx.item;
  state.itemForm = {
    mode: 'edit',
    id: it.id,
    category: it.category,
    parentId: it.parentId || null,
    parentName: ctx.parent ? ctx.parent.name : '',
    name: it.name || '',
    emoji: it.emoji || '',
    description: it.description || '',
    cookTimeMinutes: it.cookTimeMinutes || 0,
    instructions: it.instructions || '',
    waterRatio: it.waterRatio || '',
    portionPerPerson: it.portionPerPerson || defaultPortion(it.category),
    portionUnit: it.portionUnit || 'g',
    saving: false,
    error: null,
  };
  if (ctx.parent) state.expandedParents[ctx.parent.id] = true;
  render();
}

function closeItemForm() {
  state.itemForm = null;
  render();
}

async function adminSaveItemAction() {
  const f = state.itemForm;
  if (!f) return;
  if (!f.name.trim() || !f.emoji.trim()) {
    f.error = 'Name and emoji are required.';
    render();
    return;
  }
  f.saving = true;
  f.error = null;
  render();
  const isVariant = !!f.parentId;
  const payload = {
    name: f.name.trim(),
    emoji: f.emoji.trim(),
    description: f.description.trim(),
    portionPerPerson: f.portionPerPerson || defaultPortion(f.category),
    portionUnit: f.portionUnit || 'g',
  };
  if (f.cookTimeMinutes) payload.cookTimeMinutes = f.cookTimeMinutes;
  if (isVariant || f.category === 'protein') {
    if (f.instructions && f.instructions.trim()) payload.instructions = f.instructions.trim();
  }
  if (f.category === 'carb' && f.waterRatio && f.waterRatio.trim()) {
    payload.waterRatio = f.waterRatio.trim();
  }
  try {
    if (f.mode === 'edit') {
      await adminUpdateItem(f.id, payload, state.adminKey);
    } else {
      payload.category = f.category;
      payload.parentId = f.parentId || null;
      await adminCreateItem(payload, state.adminKey);
    }
    await refreshAdminItems();
    state.itemForm = null;
    render();
  } catch (err) {
    f.saving = false;
    f.error = err.message;
    render();
  }
}

async function adminDeleteItemAction(id, name, hasVariants) {
  const warn = hasVariants
    ? `Delete "${name}" and ALL its variants? This cannot be undone.`
    : `Delete "${name}"? This cannot be undone.`;
  if (!confirm(warn)) return;
  try {
    await adminDeleteItem(id, state.adminKey);
    if (state.itemForm && state.itemForm.id === id) state.itemForm = null;
    delete state.expandedParents[id];
    await refreshAdminItems();
  } catch (err) {
    state.adminError = `Failed to delete: ${err.message}`;
    render();
  }
}
