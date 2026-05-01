'use strict';

function tabLoadingHTML(text) {
  return `
    <div class="loading-inline">
      <div class="loading-pot">${potSVG()}</div>
      <p class="loading-text">${text || 'Loading…'}</p>
    </div>`;
}

function scrollFormIntoView() {
  requestAnimationFrame(() => {
    const formEl = document.querySelector('.scroll-body .sm-add-form');
    if (formEl) formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

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
      <button class="sm-tab ${tab === 'ingredients' ? 'sm-tab-active' : ''}" onclick="setSauceManagerTab('ingredients')">Ingredients</button>
    </div>`;

  const searchPlaceholder = tab === 'sauces'
    ? 'Search sauces, cuisine, ingredients…'
    : tab === 'ingredients'
      ? 'Search ingredients…'
      : 'Search items…';
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
  else if (tab === 'ingredients') bodyHTML = renderIngredientsTab(isAdmin);
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
    ${tab === 'sauces' ? `
      <button class="fab" aria-label="Add a sauce" onclick="openBuilder()">
        <i data-lucide="plus"></i>
      </button>
    ` : ''}
    ${tab === 'ingredients' && isAdmin && !state.foodMerge && !state.foodForm ? `
      <button class="fab" aria-label="Add ingredient" onclick="openFoodForm()">
        <i data-lucide="plus"></i>
      </button>
    ` : ''}
  `;
}

function renderSaucesTab(isAdmin) {
  if (state.adminSaucesLoading) return tabLoadingHTML('Loading sauces…');

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
        const inner = `
          <span class="sauce-dot" style="background:${s.color || '#999'}"></span>
          <div class="admin-sauce-info">
            <div class="admin-sauce-name">${s.name}</div>
            <div class="admin-sauce-carbs">${(s.compatibleItems || []).join(' · ')}</div>
          </div>
          <span class="sauce-type-tag sauce-type-${typeValue}">${typeMeta.label}</span>`;
        if (!isAdmin) {
          return `<div class="admin-sauce-row" onclick="selectSauceFromManager('${s.id}')">${inner}</div>`;
        }
        return `
        <div class="swipe-row" data-swipe
             data-tap-action="selectSauceFromManager('${s.id}')"
             data-edit-action="openBuilderEdit('${s.id}')"
             data-delete-action="adminDeleteSauce('${s.id}', '${safeName}')">
          <div class="swipe-action swipe-action-edit"   aria-hidden="true">Edit</div>
          <div class="swipe-action swipe-action-delete" aria-hidden="true">Delete</div>
          <div class="swipe-content admin-sauce-row">${inner}</div>
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
  if (state.adminItemsLoading) return tabLoadingHTML('Loading dishes…');

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
  const parentRowStyle = `padding:10px 16px;border-top:1px solid #f0e6d6;display:flex;align-items:center;gap:8px;cursor:${canExpand ? 'pointer' : 'default'}`;
  const parentInner = `
      <span class="parent-chevron" style="display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;${canExpand ? '' : 'visibility:hidden'}"><i data-lucide="${expanded ? 'chevron-down' : 'chevron-right'}"></i></span>
      <span class="sm-carb-emoji">${parent.emoji || ''}</span>
      <div class="admin-sauce-info" style="flex:1">
        <div class="admin-sauce-name">${parent.name}</div>
        <div class="admin-sauce-carbs">${sub}</div>
      </div>`;
  const parentRow = !isAdmin
    ? `<div class="admin-parent-row" style="${parentRowStyle}" ${canExpand ? `onclick="toggleParentExpansion('${parent.id}')"` : ''}>${parentInner}</div>`
    : `<div class="swipe-row" data-swipe
           ${canExpand ? `data-tap-action="toggleParentExpansion('${parent.id}')"` : ''}
           data-edit-action="openEditItemFormById('${parent.id}')"
           data-delete-action="adminDeleteItemAction('${parent.id}','${safeName}',${hasVariants ? 'true' : 'false'})">
        <div class="swipe-action swipe-action-edit"   aria-hidden="true">Edit</div>
        <div class="swipe-action swipe-action-delete" aria-hidden="true">Delete</div>
        <div class="swipe-content admin-parent-row" style="${parentRowStyle}">${parentInner}</div>
      </div>`;
  return `
    ${parentRow}
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
  const inner = `
      <span class="sm-carb-emoji">${v.emoji || ''}</span>
      <div class="admin-sauce-info">
        <div class="admin-sauce-name">${v.name}</div>
        <div class="admin-sauce-carbs">${sub}</div>
      </div>`;
  if (!isAdmin) {
    return `<div class="admin-sauce-row" style="padding-left:38px">${inner}</div>`;
  }
  return `
    <div class="swipe-row" data-swipe
         data-edit-action="openEditItemFormById('${v.id}')"
         data-delete-action="adminDeleteItemAction('${v.id}','${safeName}',false)">
      <div class="swipe-action swipe-action-edit"   aria-hidden="true">Edit</div>
      <div class="swipe-action swipe-action-delete" aria-hidden="true">Delete</div>
      <div class="swipe-content admin-sauce-row" style="padding-left:38px">${inner}</div>
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
function openSauceManager() {
  state.adminError = null;
  state.sauceManagerTab = 'sauces';
  state.sauceManagerSearch = '';
  state.sauceManagerTypeFilter = 'all';
  state.itemForm = null;
  state.foodForm = null;
  state.foodMerge = null;
  state.adminSauces = [];
  state.adminSaucesLoading = true;
  state.adminItemsLoading = true;
  navigate('admin');

  fetchAllSauces()
    .then(sauces => { state.adminSauces = sauces; })
    .catch(err => { state.adminError = `Failed to load sauces: ${err.message}`; })
    .finally(() => { state.adminSaucesLoading = false; render(); });

  fetchItems()
    .then(items => {
      state.adminItems = { carbs: items.carbs || [], proteins: items.proteins || [], salads: items.salads || [] };
    })
    .catch(() => {})
    .finally(() => { state.adminItemsLoading = false; render(); });
}

function openSettings() {
  state.adminError = null;
  navigate('settings');
}

function setSauceManagerTab(tab) {
  state.sauceManagerTab = tab;
  state.itemForm = null;
  state.foodForm = null;
  state.foodMerge = null;
  if (tab === 'dish') {
    state.adminItemsLoading = true;
    render();
    refreshAdminItems();
  } else if (tab === 'ingredients') {
    state.adminFoodsLoading = true;
    render();
    refreshAdminFoods();
  } else {
    render();
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
  } catch (err) {
    state.adminError = `Failed to load items: ${err.message}`;
  } finally {
    state.adminItemsLoading = false;
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
  scrollFormIntoView();
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
  scrollFormIntoView();
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

// ─── Ingredients tab ─────────────────────────────────────────────────────────
function renderIngredientsTab(isAdmin) {
  const foods = state.adminFoods || [];
  const q = (state.sauceManagerSearch || '').trim().toLowerCase();
  const merge = state.foodMerge;
  const form = state.foodForm;
  const filtered = q ? foods.filter(f => (f.name || '').toLowerCase().includes(q)) : foods;

  const formHTML = isAdmin && form ? renderFoodForm() : '';
  const mergeHTML = isAdmin && merge ? renderMergePanel() : '';

  if (state.adminFoodsLoading) {
    return `${formHTML}${mergeHTML}${tabLoadingHTML('Loading ingredients…')}`;
  }

  if (foods.length === 0) {
    return `${formHTML}<p style="padding:16px;color:#888">No ingredients yet.</p>`;
  }
  if (filtered.length === 0) {
    return `${formHTML}<p style="padding:16px;color:#888">No ingredients match your search.</p>`;
  }

  const groups = groupFoodsByCategory(filtered);
  const groupsHTML = groups.map(g => renderIngredientCategoryGroup(g, isAdmin, merge, !!q)).join('');

  const mergeBar = isAdmin && merge && merge.mergeIds.size > 0 ? `
    <div class="food-merge-bar">
      <span>${merge.mergeIds.size} selected to merge into <strong>${(foods.find(x => x.id === merge.keepId) || {}).name || '?'}</strong></span>
      <div style="display:flex;gap:6px">
        <button class="builder-secondary-btn" onclick="cancelFoodMerge()">Cancel</button>
        <button class="builder-primary-btn" onclick="submitFoodMerge()" ${merge.saving ? 'disabled' : ''}>
          ${merge.saving ? '<span class="spinner-sm"></span> Merging…' : 'Merge'}
        </button>
      </div>
      ${merge.error ? `<div class="settings-error" style="flex-basis:100%">${merge.error}</div>` : ''}
    </div>` : '';

  return `
    ${formHTML}
    ${mergeHTML}
    <div class="food-list">${groupsHTML}</div>
    ${mergeBar}`;
}

function groupFoodsByCategory(foods) {
  const UNCATEGORIZED = 'Uncategorized';
  const buckets = {};
  for (const f of foods) {
    const cat = state.ingredientCategories[(f.name || '').toLowerCase()] || UNCATEGORIZED;
    if (!buckets[cat]) buckets[cat] = [];
    buckets[cat].push(f);
  }

  const ordered = [];
  for (const c of CATEGORY_ORDER) {
    if (buckets[c]) { ordered.push({ category: c, items: buckets[c] }); delete buckets[c]; }
  }
  const userDefined = Object.keys(buckets)
    .filter(c => c !== UNCATEGORIZED)
    .sort((a, b) => a.localeCompare(b));
  for (const c of userDefined) ordered.push({ category: c, items: buckets[c] });
  if (buckets[UNCATEGORIZED]) ordered.push({ category: UNCATEGORIZED, items: buckets[UNCATEGORIZED] });
  return ordered;
}

function renderIngredientCategoryGroup(group, isAdmin, merge, forceOpen) {
  const { category, items } = group;
  const explicitlyClosed = state.ingredientSections[category] === false;
  const open = forceOpen || !explicitlyClosed;
  const chevron = open ? '▾' : '▸';
  const safeCat = category.replace(/'/g, "\\'");
  const rowsHTML = open ? items.map(f => renderFoodRow(f, isAdmin, merge)).join('') : '';
  return `
    <div class="ingredient-category-group">
      <div class="ingredient-category-header" onclick="toggleIngredientSection('${safeCat}')">
        <span class="ingredient-category-chevron">${chevron}</span>
        <span class="ingredient-category-name">${category}</span>
        <span class="ingredient-category-count">${items.length}</span>
      </div>
      ${open ? `<div class="ingredient-category-body">${rowsHTML}</div>` : ''}
    </div>`;
}

function toggleIngredientSection(category) {
  const current = state.ingredientSections[category];
  state.ingredientSections[category] = current === false ? true : false;
  render();
}

function renderFoodRow(f, isAdmin, merge) {
  const safeName = (f.name || '').replace(/'/g, "\\'");
  const usage = f.usageCount || 0;
  const sauces = f.sauceCount || 0;
  const sub = usage === 0
    ? '<span style="color:#888">unused</span>'
    : `${usage} step row${usage !== 1 ? 's' : ''} · ${sauces} sauce${sauces !== 1 ? 's' : ''}`;
  const mergeMode = !!merge;
  const isKeep = merge && merge.keepId === f.id;
  const isPicked = merge && merge.mergeIds.has(f.id);
  const inner = `
    <div class="admin-sauce-info" style="flex:1">
      <div class="admin-sauce-name">${f.name}</div>
      <div class="admin-sauce-carbs">${sub}</div>
    </div>
    ${mergeMode ? `
      ${isKeep ? '<span class="food-merge-tag food-merge-tag-keep">keep</span>'
              : isPicked ? '<span class="food-merge-tag food-merge-tag-merge">will merge</span>'
              : ''}
    ` : ''}`;
  if (mergeMode) {
    return `<div class="food-row${isKeep ? ' food-row-keep' : ''}${isPicked ? ' food-row-picked' : ''}"
                 onclick="toggleFoodMergePick('${f.id}')">${inner}</div>`;
  }
  if (!isAdmin) {
    return `<div class="food-row">${inner}</div>`;
  }
  return `
    <div class="swipe-row" data-swipe
         data-edit-action="openFoodForm('${f.id}')"
         data-delete-action="adminDeleteFoodAction('${f.id}','${safeName}',${usage})">
      <div class="swipe-action swipe-action-edit"   aria-hidden="true">Edit</div>
      <div class="swipe-action swipe-action-delete" aria-hidden="true">Delete</div>
      <div class="swipe-content food-row">
        ${inner}
        <button class="food-merge-start" title="Merge other ingredients into this one"
                onclick="event.stopPropagation(); startFoodMerge('${f.id}')">Merge…</button>
      </div>
    </div>`;
}

function renderFoodForm() {
  const f = state.foodForm;
  const esc = s => (s || '').replace(/"/g, '&quot;');
  const titleAction = f.mode === 'edit' ? 'Edit' : 'New';

  const userCats = new Set(Object.values(state.ingredientCategories || {}));
  for (const c of CATEGORY_ORDER) userCats.delete(c);
  const extraCats = [...userCats].sort((a, b) => a.localeCompare(b));
  const allCats = [...CATEGORY_ORDER, ...extraCats];
  const sel = f.category || '';
  const optHTML = allCats.map(c =>
    `<option value="${esc(c)}" ${sel === c ? 'selected' : ''}>${c}</option>`
  ).join('');

  return `
    <div class="sm-add-form">
      <div class="sm-add-form-title">${titleAction} Ingredient</div>
      <select class="builder-input" onchange="onFoodFormCategoryChange(this.value)">
        <option value="" ${sel === '' ? 'selected' : ''}>— Select category —</option>
        ${optHTML}
        <option value="__new__" ${sel === '__new__' ? 'selected' : ''}>+ New category…</option>
      </select>
      ${sel === '__new__' ? `
        <input class="builder-input" placeholder="New category name"
               value="${esc(f.categoryDraft)}"
               oninput="state.foodForm.categoryDraft=this.value">
      ` : ''}
      <input class="builder-input" placeholder="Name (e.g. tomato)" value="${esc(f.name)}" oninput="state.foodForm.name=this.value">
      <input class="builder-input" placeholder="Plural (optional, e.g. tomatoes)" value="${esc(f.plural)}" oninput="state.foodForm.plural=this.value">
      ${f.error ? `<div class="settings-error">${f.error}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="builder-primary-btn" style="flex:1" onclick="submitFoodForm()" ${f.saving ? 'disabled' : ''}>
          ${f.saving ? '<span class="spinner-sm"></span> Saving…' : (f.mode === 'edit' ? 'Save' : 'Add Ingredient')}
        </button>
        <button class="builder-secondary-btn" onclick="closeFoodForm()">Cancel</button>
      </div>
    </div>`;
}

function onFoodFormCategoryChange(value) {
  if (!state.foodForm) return;
  state.foodForm.category = value;
  if (value !== '__new__') state.foodForm.categoryDraft = '';
  render();
}

function renderMergePanel() {
  const merge = state.foodMerge;
  const keep = (state.adminFoods || []).find(f => f.id === merge.keepId);
  return `
    <div class="food-merge-panel">
      <strong>Merging into: ${keep ? keep.name : '(unknown)'}</strong>
      <div style="font-size:12px;color:#555;margin-top:4px">
        Tap other ingredients in the list to mark them as duplicates of this one.
        All recipes pointing at the duplicates will be repointed at <em>${keep ? keep.name : ''}</em>.
      </div>
    </div>`;
}

async function refreshAdminFoods() {
  try {
    state.adminFoods = await fetchFoodsWithUsage();
  } catch (err) {
    state.adminError = `Failed to load ingredients: ${err.message}`;
  } finally {
    state.adminFoodsLoading = false;
    render();
  }
}

function openFoodForm(id) {
  const food = id ? (state.adminFoods || []).find(f => f.id === id) : null;
  state.foodMerge = null;
  const existingCat = food
    ? (state.ingredientCategories[(food.name || '').toLowerCase()] || '')
    : '';
  state.foodForm = food
    ? { mode: 'edit', id: food.id, name: food.name || '', plural: food.plural || '', category: existingCat, categoryDraft: '', error: null, saving: false }
    : { mode: 'add', name: '', plural: '', category: '', categoryDraft: '', error: null, saving: false };
  render();
  scrollFormIntoView();
}

function closeFoodForm() {
  state.foodForm = null;
  render();
}

async function submitFoodForm() {
  const f = state.foodForm;
  if (!f) return;
  const name = (f.name || '').trim();
  if (!name) {
    f.error = 'Name is required.';
    render();
    return;
  }
  let resolvedCategory = (f.category || '').trim();
  if (resolvedCategory === '__new__') {
    resolvedCategory = (f.categoryDraft || '').trim();
    if (!resolvedCategory) {
      f.error = 'New category name is required.';
      render();
      return;
    }
  }
  if (f.mode === 'add' && !resolvedCategory) {
    f.error = 'Category is required.';
    render();
    return;
  }
  f.saving = true;
  f.error = null;
  render();
  try {
    const payload = { name, plural: (f.plural || '').trim() || null };
    if (f.mode === 'edit') await adminUpdateFood(f.id, payload, state.adminKey);
    else await adminCreateFood(payload, state.adminKey);
    if (resolvedCategory) {
      await classifyIngredient(name, resolvedCategory);
    }
    state.foodForm = null;
    await refreshAdminFoods();
  } catch (err) {
    f.saving = false;
    f.error = err.message;
    render();
  }
}

async function adminDeleteFoodAction(id, name, usage) {
  if (usage > 0) {
    alert(`Cannot delete "${name}" — it's used by ${usage} recipe step row(s). Merge it into another ingredient first.`);
    return;
  }
  if (!confirm(`Delete ingredient "${name}"? This cannot be undone.`)) return;
  try {
    await adminDeleteFood(id, state.adminKey);
    await refreshAdminFoods();
  } catch (err) {
    state.adminError = `Failed to delete: ${err.message}`;
    render();
  }
}

function startFoodMerge(keepId) {
  state.foodForm = null;
  state.foodMerge = { keepId, mergeIds: new Set(), error: null, saving: false };
  render();
}

function toggleFoodMergePick(id) {
  const merge = state.foodMerge;
  if (!merge) return;
  if (id === merge.keepId) return; // can't merge the keeper into itself
  if (merge.mergeIds.has(id)) merge.mergeIds.delete(id);
  else merge.mergeIds.add(id);
  render();
}

function cancelFoodMerge() {
  state.foodMerge = null;
  render();
}

async function submitFoodMerge() {
  const merge = state.foodMerge;
  if (!merge || merge.mergeIds.size === 0) return;
  merge.saving = true;
  merge.error = null;
  render();
  try {
    await adminMergeFoods(merge.keepId, [...merge.mergeIds], state.adminKey);
    state.foodMerge = null;
    await refreshAdminFoods();
  } catch (err) {
    merge.saving = false;
    merge.error = err.message;
    render();
  }
}
