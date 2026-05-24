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
  if (!currentUser) {
    return `
      ${renderAppHeader({
        title: 'Become Admin',
        subtitle: 'Sign in first to claim admin rights',
        titleIcon: 'key-round',
        back: { onClick: "navigate('admin')" },
      })}
      <div class="scroll-body scroll-body--padded">
        <div class="settings-form">
          <p>You need to sign in before you can become an admin.</p>
          <button class="builder-primary-btn" onclick="openAuthModal()">Sign in</button>
        </div>
      </div>
    `;
  }
  if (currentUser.is_admin) {
    return `
      ${renderAppHeader({
        title: "You're an admin",
        titleIcon: 'shield-check',
        back: { onClick: "navigate('admin')" },
      })}
      <div class="scroll-body scroll-body--padded">
        <div class="settings-form">
          <p>You already have admin rights — open the Sauce Manager to edit anything.</p>
          <button class="builder-primary-btn" onclick="navigate('admin')">Open Sauce Manager</button>
        </div>
      </div>
    `;
  }
  return `
    ${renderAppHeader({
      title: 'Become Admin',
      subtitle: 'Enter the shared admin key to unlock full edit rights',
      titleIcon: 'key-round',
      back: { onClick: "navigate('admin')" },
    })}
    <div class="scroll-body scroll-body--padded">
      <div class="settings-form">
        <input
          id="admin-key-input"
          type="password"
          class="builder-input settings-password-input"
          placeholder="Admin key"
          autocomplete="off"
          onkeydown="if(event.key==='Enter') submitBecomeAdmin()"
        >
        ${state.becomeAdminError ? `<div class="settings-error">${state.becomeAdminError}</div>` : ''}
        <button class="builder-primary-btn" onclick="submitBecomeAdmin()" id="settings-submit-btn">
          ${state.becomeAdminBusy ? '<span class="spinner-sm"></span> Promoting…' : 'Become admin'}
        </button>
      </div>
    </div>
  `;
}

function renderAdmin() {
  const isAdmin = !!(currentUser && currentUser.is_admin);
  const isLoggedIn = !!currentUser;
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
      ${renderTypeChips({
        mode: 'single',
        activeValue: typeFilter,
        onPick: "setSauceManagerTypeFilter('$VALUE')",
      })}
    </div>` : '';

  let bodyHTML = '';
  if (tab === 'sauces') bodyHTML = renderSaucesTab(isAdmin, isLoggedIn);
  else if (tab === 'ingredients') bodyHTML = renderIngredientsTab(isAdmin, isLoggedIn);
  else bodyHTML = renderDishTab(isAdmin);

  const editToggle = isLoggedIn ? `
    <button class="edit-mode-toggle ${state.editMode ? 'edit-mode-on' : ''}"
            onclick="toggleEditMode()"
            aria-pressed="${state.editMode}"
            title="${state.editMode ? 'Exit edit mode' : 'Enter edit mode'}">
      <i data-lucide="${state.editMode ? 'pencil-off' : 'pencil'}"></i>
    </button>` : '';
  const becomeAdminBtn = (isLoggedIn && !isAdmin)
    ? `<button class="settings-btn" onclick="openSettings()" title="Become admin"><i data-lucide="key-round"></i></button>`
    : '';

  return `
    ${renderAppHeader({
      title: 'Sauce Manager',
      subtitle: state.editMode ? 'Edit mode' : (isAdmin ? 'Admin' : (isLoggedIn ? 'Signed in' : '')),
      titleIcon: 'settings-2',
      manage: false,
      extraActions: editToggle + becomeAdminBtn,
    })}
    ${state.adminError ? `<div class="settings-error" style="margin:8px 16px">${state.adminError}</div>` : ''}
    ${tabBar}
    ${searchBar}
    ${typeFilterRow}
    <div class="scroll-body">
      ${bodyHTML}
    </div>
    ${tab === 'sauces' && isLoggedIn && !state.sauceMerge ? `
      <button class="fab" aria-label="Add a sauce" onclick="openBuilder()">
        <i data-lucide="plus"></i>
      </button>
    ` : ''}
    ${tab === 'ingredients' && isLoggedIn && state.editMode && !state.foodMerge && !state.foodForm ? `
      <button class="fab" aria-label="Add ingredient" onclick="openFoodForm()">
        <i data-lucide="plus"></i>
      </button>
    ` : ''}
  `;
}

function renderSaucesTab(isAdmin, isLoggedIn) {
  if (state.adminSaucesLoading) return tabLoadingHTML('Loading sauces…');

  const typeFilter = state.sauceManagerTypeFilter || 'all';
  const q = (state.sauceManagerSearch || '').trim().toLowerCase();
  const merge = state.sauceMerge;
  const mergeMode = !!merge;
  const mergePanel = mergeMode ? renderSauceMergePanel() : '';

  const toolbarHTML = (!mergeMode && state.editMode && (isLoggedIn || isAdmin)) ? `
    <div class="sm-import-export-row">
      ${isLoggedIn ? `
        <button class="sm-tool-btn" onclick="openImportSaucePicker()">
          <i data-lucide="upload"></i> Import sauce…
        </button>` : ''}
      ${isAdmin ? `
        <button class="sm-tool-btn" onclick="downloadBulkSauceExport()">
          <i data-lucide="download"></i> Export all (JSON)
        </button>` : ''}
      <input type="file" id="sm-import-file"
             accept="application/json,.json"
             style="display:none"
             onchange="handleImportSauceFile(event)">
    </div>` : '';

  const filtered = state.adminSauces.filter(s => {
    if (typeFilter !== 'all' && (s.sauceType || 'sauce') !== typeFilter) return false;
    if (!q) return true;
    const haystack = [
      s.name || '',
      s.cuisine || '',
      (s.attachments || []).map(a => a.value).join(' '),
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });

  if (state.adminSauces.length === 0) {
    return `${mergePanel}${toolbarHTML}<p style="padding:16px;color:var(--text-muted)">No sauces found.</p>`;
  }
  if (filtered.length === 0) {
    return `${mergePanel}${toolbarHTML}<p style="padding:16px;color:var(--text-muted)">No sauces match your filters.</p>`;
  }

  // Merge mode renders flat — every row is a candidate target so nesting
  // would obscure picks. Otherwise group filtered sauces into families and
  // render variants indented beneath their parent.
  const grouped = {};
  if (mergeMode) {
    for (const sauce of filtered) {
      if (!grouped[sauce.cuisine]) grouped[sauce.cuisine] = { rows: [], count: 0 };
      grouped[sauce.cuisine].rows.push({ sauce, isVariant: false });
      grouped[sauce.cuisine].count += 1;
    }
  } else {
    const families = buildSauceFamilies(filtered);
    for (const fam of families.values()) {
      const cuisine = fam.root.cuisine || '';
      if (!grouped[cuisine]) grouped[cuisine] = { rows: [], count: 0 };
      grouped[cuisine].rows.push({ sauce: fam.root, isVariant: false });
      for (const v of fam.variants) {
        grouped[cuisine].rows.push({ sauce: v, isVariant: true });
      }
      grouped[cuisine].count += 1 + fam.variants.length;
    }
  }
  const cuisines = Object.keys(grouped).sort();

  const groupsHTML = cuisines.map(cuisine => {
    const safeCuisine = cuisine.replace(/'/g, "\\'");
    const isOpen = state.cuisineSections[cuisine] === true;
    const rowsHTML = isOpen
      ? grouped[cuisine].rows.map(({ sauce, isVariant }) => renderSauceManagerRow(sauce, isAdmin, merge, isVariant)).join('')
      : '';
    return renderAccordionGroup({
      label: cuisine,
      count: grouped[cuisine].count,
      isOpen,
      onToggle: `toggleCuisineSection('${safeCuisine}')`,
      body: rowsHTML,
    });
  }).join('');

  // Bottom action bar: always visible while in merge mode so the user can
  // exit even before picking anything (mirrors the food-merge bar).
  const mergeBar = mergeMode ? renderSauceMergeBar() : '';

  return `${mergePanel}${toolbarHTML}${groupsHTML}${mergeBar}`;
}

function renderSauceManagerRow(s, isAdmin, merge, isVariantRow = false) {
  const safeName = s.name.replace(/'/g, "\\'");
  const typeValue = s.sauceType || 'sauce';
  const typeMeta = SAUCE_TYPES.find(t => t.value === typeValue) || SAUCE_TYPES[0];
  const isOwner = !!(currentUser && s.createdBy === currentUser.id);
  // Edit mode gates all editorial swipe actions; merge/sauce-merge mode is its own UX.
  const canEdit = state.editMode && (isAdmin || isOwner);
  const canDelete = state.editMode && (isAdmin || isOwner);
  const mergeMode = !!merge;
  const isKeep = merge && merge.keepId === s.id;
  const isPicked = merge && merge.mergeIds.has(s.id);
  const isVariant = !!s.parentSauceId;
  // Nested under a parent in the family list — drop the redundant variant
  // badge (the indent already conveys it) and disable long-press merge.
  const variantRowCls = isVariantRow ? ' admin-sauce-row--variant' : '';

  const variantBadge = isVariant && !mergeMode && !isVariantRow
    ? '<span class="variant-badge" title="Variant of another sauce"><i data-lucide="git-branch"></i></span>'
    : '';
  const mergeTag = mergeMode
    ? (isKeep ? '<span class="food-merge-tag food-merge-tag-keep">parent</span>'
              : isPicked ? '<span class="food-merge-tag food-merge-tag-merge">will be variant</span>'
              : '')
    : '';
  const typePill = `<span class="sauce-type-tag sauce-type-${typeValue}">${typeMeta.label}</span>`;
  // Sauce Manager subline: prefer "by Author" so admin rows match the rest
  // of the app; fall back to the legacy compatible-items list for seed
  // sauces (no createdBy).
  const author = s.authorName || (s.createdBy ? 'Unknown' : null);
  const subline = author ? `by ${escapeHtml(author)}` : escapeHtml((s.attachments || []).map(a => a.value).join(' · '));

  // The shared row helper builds the inner shell. Sauce Manager-specific
  // wrappers (merge/swipe) live below.
  const baseRowClass = `${variantRowCls}${isKeep ? ' food-row-keep' : ''}${isPicked ? ' food-row-picked' : ''}`.trim();

  if (mergeMode) {
    // While in merge mode the row is purely a tap-target — disable swipe so
    // the user can't accidentally edit/delete during selection.
    return renderSauceRow(s, {
      rowClass: baseRowClass,
      onClick: `toggleSauceMergePick('${s.id}')`,
      subline,
      variantBadge,
      rightSlot: mergeTag + typePill,
    });
  }

  if (!canEdit && !canDelete) {
    return renderSauceRow(s, {
      rowClass: variantRowCls.trim(),
      onClick: `selectSauceFromManager('${s.id}')`,
      subline,
      variantBadge,
      rightSlot: typePill,
    });
  }
  // Editable rows wrap the shared helper in the swipe primitive. The inner
  // row drops its own onclick — swipe.js dispatches the tap-action instead.
  const longPressAttr = isAdmin && state.editMode && !isVariantRow ? `data-longpress-action="startSauceMerge('${s.id}')"` : '';
  const inner = renderSauceRow(s, {
    rowClass: variantRowCls.trim(),
    subline,
    variantBadge,
    rightSlot: typePill,
  });
  return `
    <div class="swipe-row" data-swipe
         data-tap-action="selectSauceFromManager('${s.id}')"
         ${longPressAttr}
         ${canEdit ? `data-edit-action="openBuilderEdit('${s.id}')"` : ''}
         ${canDelete ? `data-delete-action="adminDeleteSauce('${s.id}', '${safeName}')"` : ''}>
      ${canEdit ? '<div class="swipe-action swipe-action-edit"   aria-hidden="true">Edit</div>' : ''}
      ${canDelete ? '<div class="swipe-action swipe-action-delete" aria-hidden="true">Delete</div>' : ''}
      <div class="swipe-content">${inner}</div>
    </div>`;
}

// `renderSauceMergePanel` and `renderSauceMergeBar` live in
// `widgets/sauce-merge-bar.js` — extracted in the 2026-05-24 carve-out.
// Action handlers (startSauceMerge / toggleSauceMergePick / etc.) stay
// here for now since they mutate the manager's admin lists.

// ─── Sauce-variant merge state actions ───────────────────────────────────────
function startSauceMerge(keepId) {
  const sauce = (state.adminSauces || []).find(s => s.id === keepId);
  if (!sauce) return;
  if (sauce.parentSauceId) {
    SauceBossPopup.alert({
      title: 'Already a variant',
      body: `"${sauce.name}" is already a variant of another sauce. Pick the original sauce as the family parent instead.`,
    });
    return;
  }
  state.sauceMerge = { keepId, mergeIds: new Set(), error: null, saving: false };
  render();
}

async function toggleSauceMergePick(id) {
  const merge = state.sauceMerge;
  if (!merge) return;
  if (id === merge.keepId) return;
  // The backend rejects targets that already have variants of their own; we
  // also disallow picking an existing variant of a different parent here so
  // the UX never shows a target it can't actually save.
  const sauce = (state.adminSauces || []).find(s => s.id === id);
  if (sauce && sauce.parentSauceId && sauce.parentSauceId !== merge.keepId) {
    const newParent = (state.adminSauces.find(s => s.id === merge.keepId) || {}).name || merge.keepId;
    const ok = await SauceBossPopup.confirm({
      title: 'Re-parent variant?',
      body: `"${sauce.name}" is already a variant of another sauce. Re-parent it to "${newParent}"?`,
      confirmLabel: 'Re-parent',
    });
    if (!ok) return;
  }
  if (merge.mergeIds.has(id)) merge.mergeIds.delete(id);
  else merge.mergeIds.add(id);
  render();
}

function cancelSauceMerge() {
  state.sauceMerge = null;
  render();
}

async function submitSauceMerge() {
  const merge = state.sauceMerge;
  if (!merge || merge.mergeIds.size === 0) return;
  merge.saving = true;
  merge.error = null;
  render();
  try {
    await adminAssignSauceVariants(merge.keepId, [...merge.mergeIds]);
    state.sauceMerge = null;
    // fetchAllSauces (not fetchAdminSauces) — the admin endpoint omits ingredients/steps, which would crash the recipe view on tap.
    state.adminSauces = await fetchAllSauces();
    render();
  } catch (err) {
    merge.saving = false;
    merge.error = err.message;
    render();
  }
}

function toggleCuisineSection(cuisine) {
  state.cuisineSections[cuisine] = state.cuisineSections[cuisine] === true ? false : true;
  render();
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
    return '<p style="padding:16px;color:var(--text-muted)">No items match your search.</p>';
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
  return renderAccordionGroup({
    label: sec.label,
    count: totalCount,
    isOpen: open,
    onToggle: `toggleItemSection('${sec.key}')`,
    body,
  });
}

// Dish Manager parent + variant rows delegate to the canonical
// `renderDishTile` since 2026-05-24 (ui/dish-tile.js). These adapters
// compute the manager-specific state (expand, inline-edit form, subline
// formatting) and pass it through.
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
  const variantPart = `${variants.length} variant${variants.length !== 1 ? 's' : ''}`;
  const cookTimePart = (sec.category === 'carb' || sec.category === 'protein') && parent.cookTimeMinutes
    ? ` · ${parent.cookTimeMinutes} min` : '';
  const subline = variantPart + cookTimePart;
  const parentRow = renderDishTile(parent, {
    variant: 'manager-row',
    isAdmin,
    editMode: state.editMode,
    expanded,
    canExpand,
    onTap: canExpand ? `toggleParentExpansion('${parent.id}')` : '',
    subline,
    safeName,
    hasVariants,
  });
  return `
    ${parentRow}
    ${expanded ? `
      <div style="padding-left:12px">
        ${showAddVariantForm ? `<div style="padding:0 16px">${renderItemForm()}</div>` : ''}
        ${variants.map(v => renderVariantRow(v, sec, isAdmin)).join('')}
        ${isAdmin && state.editMode && !showAddVariantForm ? `
          <button class="add-step-btn" style="margin:8px 16px" onclick="event.stopPropagation(); openAddItemForm('${sec.category}','${parent.id}')">+ Add Variant</button>
        ` : ''}
      </div>
    ` : ''}`;
}

function renderVariantRow(v, sec, isAdmin) {
  const f = state.itemForm;
  if (f && f.mode === 'edit' && f.id === v.id) return `<div style="padding:0 16px">${renderItemForm()}</div>`;
  const safeName = (v.name || '').replace(/'/g, "\\'");
  const subline = `${v.cookTimeMinutes ? v.cookTimeMinutes + ' min' : ''}${v.cookTimeMinutes && v.description ? ' · ' : ''}${v.description || ''}`;
  return renderDishTile(v, {
    variant: 'variant-row',
    isAdmin,
    editMode: state.editMode,
    subline,
    safeName,
  });
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
    state.adminIngredientsLoading = true;
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
  // Reconstruct the family so the recipe-view switcher can flip between
  // siblings without another fetch. The sauce the user clicked may itself
  // be either a root or a variant — buildSauceFamilies handles both.
  const families = buildSauceFamilies(state.adminSauces || []);
  const rootId = sauce.parentSauceId || sauce.id;
  const family = families.get(rootId);
  state.selectedSauceFamily = family ? [family.root, ...family.variants] : [sauce];
  state.selectedSauce       = sauce;
  state.servings            = sauce.defaultServings || 2;
  state.hiddenPieSlices     = {};
  state.selectedItem        = null;
  state.selectedPrep        = null;
  state.meal                = { item: null, prep: null, sauce: null };
  state.disabledIngredients = new Set();
  navigate('recipe');
}

async function openBuilderEdit(id) {
  if (!currentUser) { openAuthModal(); return; }
  let sauce = (state.adminSauces || []).find(s => s.id === id)
           || (state.saucesForCurrentItem || []).find(s => s.id === id)
           || (state.saucebook || []).find(s => s.id === id);
  if (!sauce) return;
  // Only owner or admin may edit
  const isOwner = currentUser && sauce.createdBy === currentUser.id;
  const isAdmin = currentUser && currentUser.is_admin;
  if (!isOwner && !isAdmin) return;
  // Saucebook rows are slim (no steps) — fetch full envelope if needed
  if (!sauce.steps) {
    const all = await fetchAllSauces();
    sauce = all.find(s => s.id === id);
    if (!sauce) return;
  }
  state.builder = {
    ...defaultBuilder(),
    _expandedDishes: new Set(),
    recipeSource: sauce.sourceUrl ? 'url' : 'manual',
    editingId: sauce.id,
    name: sauce.name,
    cuisine: sauce.cuisine,
    cuisineEmoji: sauce.cuisineEmoji || '',
    color: sauce.color || '#E85D04',
    description: sauce.description || '',
    sourceUrl: sauce.sourceUrl || '',
    sauceType: sauce.sauceType || 'sauce',
    servings: sauce.defaultServings || 2,
    parentSauceId: sauce.parentSauceId || null,
    itemIds: (sauce.attachments || []).filter(a => a.kind === 'dish').map(a => a.value),
    steps: (sauce.steps || []).map(s => ({
      title: s.title,
      instructions: s.instructions || '',
      inputFromSteps: Array.isArray(s.inputFromSteps) ? s.inputFromSteps.slice() : (s.inputFromStep ? [s.inputFromStep] : []),
      estimatedTime: s.estimatedTime != null ? s.estimatedTime : null,
      ingredients: (s.ingredients || []).map(i => ({
        name: i.name, amount: i.amount, unit: i.unit,
      })),
    })),
    _instructionsExpanded: new Set(
      (sauce.steps || []).reduce((acc, s, i) => { if ((s.instructions || '').trim()) acc.push(i); return acc; }, [])
    ),
  };
  state.recipeReturnTo = state.screen === 'admin' ? 'admin' : 'tab-shell';
  state.builder.returnToReview = true;
  navigate('builder-review');
  if (!_hasBuilderRefData()) {
    await withInlineLoader(ensureBuilderRefData());
  }
}

// ─── Become Admin ─────────────────────────────────────────────────────────────
async function submitBecomeAdmin() {
  if (!currentUser) { openAuthModal(); return; }
  const input = document.getElementById('admin-key-input');
  if (!input || !input.value.trim()) return;
  const key = input.value.trim();
  state.becomeAdminBusy = true;
  state.becomeAdminError = null;
  render();
  try {
    const profile = await becomeAdmin(key);
    currentUser = {
      ...profile,
      is_admin: !!profile.is_admin,
    };
    state.becomeAdminBusy = false;
    state.becomeAdminError = null;
    navigate('admin');
  } catch (err) {
    state.becomeAdminBusy = false;
    state.becomeAdminError = err.message.includes('403') || err.message.includes('401')
      ? 'Incorrect admin key. Try again.'
      : `Error: ${err.message}`;
    render();
  }
}

// ─── Sauce Delete ─────────────────────────────────────────────────────────────
// Routes to the admin or owner-scoped endpoint based on who's signed in. Both
// have the same shape; the backend enforces ownership on the public route.
async function adminDeleteSauce(id, name) {
  const ok = await SauceBossPopup.confirm({
    title: `Delete "${name}"?`,
    body: 'This cannot be undone.',
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!ok) return;
  const sauce = (state.adminSauces || []).find(s => s.id === id);
  const isAdmin = !!(currentUser && currentUser.is_admin);
  const isOwner = !!(currentUser && sauce && sauce.createdBy === currentUser.id);
  try {
    if (isAdmin) {
      await deleteAdminSauce(id);
    } else if (isOwner) {
      await deleteSauceOwned(id);
    } else {
      throw new Error('You can only delete sauces you created.');
    }
    state.adminSauces = state.adminSauces.filter(s => s.id !== id);
    state.adminError = null;
    // Saucebook FK cascades will have removed any saucebook entries for this
    // sauce; pantry is derived from saucebook, so refresh both.
    refreshSaucebookAndPantry();
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
      await adminUpdateItem(f.id, payload);
    } else {
      payload.category = f.category;
      payload.parentId = f.parentId || null;
      await adminCreateItem(payload);
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
  const ok = await SauceBossPopup.confirm({
    title: hasVariants ? `Delete "${name}" and all variants?` : `Delete "${name}"?`,
    body: hasVariants
      ? 'All variants of this item will be removed. This cannot be undone.'
      : 'This cannot be undone.',
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!ok) return;
  try {
    await adminDeleteItem(id);
    if (state.itemForm && state.itemForm.id === id) state.itemForm = null;
    delete state.expandedParents[id];
    await refreshAdminItems();
  } catch (err) {
    state.adminError = `Failed to delete: ${err.message}`;
    render();
  }
}

// ─── Ingredients tab ─────────────────────────────────────────────────────────
function renderIngredientsTab(isAdmin, isLoggedIn) {
  const foods = state.adminIngredients || [];
  const q = (state.sauceManagerSearch || '').trim().toLowerCase();
  const merge = state.foodMerge;
  const form = state.foodForm;
  const filtered = q ? foods.filter(f => (f.name || '').toLowerCase().includes(q)) : foods;

  // Add form renders at the top of the list; edit form renders inline (see renderFoodRow).
  const addFormVisible = form && form.mode === 'add' && isLoggedIn;
  const formHTML = addFormVisible ? renderFoodForm() : '';
  const mergeHTML = isAdmin && merge ? renderMergePanel() : '';

  if (state.adminIngredientsLoading) {
    return `${formHTML}${mergeHTML}${tabLoadingHTML('Loading ingredients…')}`;
  }

  if (foods.length === 0) {
    return `${formHTML}<p style="padding:16px;color:var(--text-muted)">No ingredients yet.</p>`;
  }
  if (filtered.length === 0) {
    return `${formHTML}<p style="padding:16px;color:var(--text-muted)">No ingredients match your search.</p>`;
  }

  const groups = groupFoodsByCategory(filtered);
  const groupsHTML = groups.map(g => renderIngredientCategoryGroup(g, isAdmin, merge, !!q)).join('');

  // Bottom bar is shown for the entire merge mode — even with zero picks —
  // so the user always has a Cancel affordance. The "Merge" button only
  // enables once they've picked at least one duplicate.
  const mergeBar = isAdmin && merge ? `
    <div class="food-merge-bar">
      <span>${merge.mergeIds.size === 0
        ? `Tap duplicates to merge into <strong>${(foods.find(x => x.id === merge.keepId) || {}).name || '?'}</strong>`
        : `${merge.mergeIds.size} selected to merge into <strong>${(foods.find(x => x.id === merge.keepId) || {}).name || '?'}</strong>`}</span>
      <div style="display:flex;gap:6px">
        <button class="builder-secondary-btn" onclick="cancelFoodMerge()">Cancel</button>
        <button class="builder-primary-btn" onclick="submitFoodMerge()" ${merge.mergeIds.size === 0 || merge.saving ? 'disabled' : ''}>
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
  const open = forceOpen || state.ingredientSections[category] === true;
  const safeCat = category.replace(/'/g, "\\'");
  const rowsHTML = open ? items.map(f => renderFoodRow(f, isAdmin, merge)).join('') : '';
  return renderAccordionGroup({
    label: category,
    count: items.length,
    isOpen: open,
    onToggle: `toggleIngredientSection('${safeCat}')`,
    body: rowsHTML,
  });
}

function toggleIngredientSection(category) {
  state.ingredientSections[category] = state.ingredientSections[category] === true ? false : true;
  render();
}

// `renderFoodRow` was collapsed into the canonical `renderIngredientRow`
// in 2026-05-24 (ui/ingredient-row.js). This adapter computes the manager-
// specific state (expanded sub-panel, inline edit form) and delegates the
// actual markup.
function renderFoodRow(f, isAdmin, merge) {
  const form = state.foodForm;
  const editFormHTML = (isAdmin && form && form.mode === 'edit' && form.id === f.id)
    ? renderFoodForm() : null;
  const mergeMode = !!merge;
  const expanded = !mergeMode && state.expandedFoodIds && state.expandedFoodIds.has(f.id);
  const panelHTML = expanded ? renderIngredientSaucesPanel(f.id) : '';
  return renderIngredientRow(f, {
    mode: 'manager',
    isAdmin,
    editMode: state.editMode,
    merge,
    panelHTML,
    editFormHTML,
  });
}

function renderIngredientSaucesPanel(ingredientId) {
  const sauces = saucesUsingIngredient(ingredientId);
  if (sauces.length === 0) {
    return `<div class="food-sauces-panel"><span class="food-sauces-empty">No sauces use this yet.</span></div>`;
  }
  const chips = sauces.map(s => {
    const color = (s.color || 'var(--accent)').replace(/"/g, '');
    return `<button class="food-sauce-chip" style="border-left-color:${color}"
              onclick="event.stopPropagation(); selectSauceFromManager('${s.id}')">${s.name}</button>`;
  }).join('');
  return `<div class="food-sauces-panel">${chips}</div>`;
}

function saucesUsingIngredient(ingredientId) {
  const out = [];
  const seen = new Set();
  for (const s of state.adminSauces || []) {
    if (seen.has(s.id)) continue;
    const hit = (s.steps || []).some(st =>
      (st.ingredients || []).some(i => i.ingredientId === ingredientId)
    );
    if (hit) { out.push({ id: s.id, name: s.name, color: s.color }); seen.add(s.id); }
  }
  out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return out;
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

// `renderMergePanel` (ingredient-side) lives in
// `widgets/ingredient-merge-panel.js` — extracted in the 2026-05-24 carve-out.

async function refreshAdminFoods() {
  try {
    state.adminIngredients = await fetchIngredientsWithUsage();
  } catch (err) {
    state.adminError = `Failed to load ingredients: ${err.message}`;
  } finally {
    state.adminIngredientsLoading = false;
    render();
  }
}

function openFoodForm(id) {
  const food = id ? (state.adminIngredients || []).find(f => f.id === id) : null;
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
    if (resolvedCategory) payload.category = resolvedCategory;
    if (f.mode === 'edit') await adminUpdateIngredient(f.id, payload);
    else await adminCreateIngredient(payload);
    if (resolvedCategory) {
      // Mirror the persisted category into the local cache so any open
      // recipe view / builder sees it immediately without a refetch.
      state.ingredientCategories[name.trim().toLowerCase()] = resolvedCategory;
    }
    state.foodForm = null;
    await refreshAdminFoods();
  } catch (err) {
    f.saving = false;
    f.error = err.message;
    render();
  }
}

async function adminDeleteIngredientAction(id, name, usage) {
  if (usage > 0) {
    await SauceBossPopup.alert({
      title: `Can't delete "${name}"`,
      body: `It's used by ${usage} recipe step row${usage === 1 ? '' : 's'}. Merge it into another ingredient first.`,
    });
    return;
  }
  const ok = await SauceBossPopup.confirm({
    title: `Delete ingredient "${name}"?`,
    body: 'This cannot be undone.',
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!ok) return;
  try {
    await adminDeleteIngredient(id);
    await refreshAdminFoods();
  } catch (err) {
    state.adminError = `Failed to delete: ${err.message}`;
    render();
  }
}

function toggleFoodExpand(id) {
  if (state.foodMerge) return;
  if (!state.expandedFoodIds) state.expandedFoodIds = new Set();
  const set = state.expandedFoodIds;
  if (set.has(id)) set.delete(id); else set.add(id);
  render();
}

function startFoodMerge(keepId) {
  state.foodForm = null;
  state.expandedFoodIds = new Set();
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
    await adminMergeIngredients(merge.keepId, [...merge.mergeIds]);
    state.foodMerge = null;
    await refreshAdminFoods();
  } catch (err) {
    merge.saving = false;
    merge.error = err.message;
    render();
  }
}

// ─── Import / Export ────────────────────────────────────────────────────────

function openImportSaucePicker() {
  const input = document.getElementById('sm-import-file');
  if (input) input.click();
}

async function handleImportSauceFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = ''; // allow re-picking the same file
  if (!file) return;
  if (!currentUser) { openAuthModal(); return; }

  let raw;
  try {
    raw = JSON.parse(await file.text());
  } catch (e) {
    await SauceBossPopup.alert({ title: 'Invalid JSON', body: `File is not valid JSON: ${e.message}` });
    return;
  }

  if (raw && typeof raw === 'object' && Array.isArray(raw.sauces)) {
    await SauceBossPopup.alert({
      title: 'Bulk import unsupported',
      body: "Split the file into per-sauce JSONs and import them one at a time.",
    });
    return;
  }
  if (raw && raw.version != null && raw.version !== 1) {
    await SauceBossPopup.alert({
      title: 'Unsupported export version',
      body: `This import only handles version 1; the file is version ${raw.version}.`,
    });
    return;
  }

  const inner = (raw && typeof raw.sauce === 'object' && raw.sauce !== null) ? raw.sauce : raw;
  if (!inner || typeof inner !== 'object' || !inner.name || !Array.isArray(inner.steps)) {
    await SauceBossPopup.alert({
      title: 'Sauce payload not found',
      body: "Expected an object with `name` and `steps`.",
    });
    return;
  }

  // Drop a parent reference that doesn't resolve in this catalog so the
  // builder lands on a saveable draft rather than a phantom-parent option.
  let parentSauceId = inner.parentSauceId || null;
  if (parentSauceId) {
    const known = (state.adminSauces || []).some(s => s.id === parentSauceId);
    if (!known) {
      await SauceBossPopup.alert({
        title: 'Parent sauce not found',
        body: `Parent sauce "${parentSauceId}" isn't in this catalog — the parent link was dropped.`,
      });
      parentSauceId = null;
    }
  }

  const itemIds = Array.isArray(inner.itemIds) && inner.itemIds.length
    ? inner.itemIds
    : (Array.isArray(inner.attachments) ? inner.attachments.filter(a => a.kind === 'dish').map(a => a.value) : []);

  state.builder = {
    ...defaultBuilder(),
    _expandedDishes: new Set(),
    recipeSource: inner.sourceUrl ? 'url' : 'manual',
    editingId: null,
    name: inner.name,
    cuisine: inner.cuisine || '',
    cuisineEmoji: inner.cuisineEmoji || '',
    color: inner.color || '#E85D04',
    description: inner.description || '',
    sourceUrl: inner.sourceUrl || '',
    sauceType: inner.sauceType || 'sauce',
    servings: inner.defaultServings || 2,
    parentSauceId,
    itemIds,
    steps: (inner.steps || []).map(s => ({
      title: s.title || '',
      instructions: s.instructions || '',
      inputFromSteps: Array.isArray(s.inputFromSteps) ? s.inputFromSteps.slice() : (s.inputFromStep ? [s.inputFromStep] : []),
      estimatedTime: s.estimatedTime != null ? s.estimatedTime : null,
      ingredients: (s.ingredients || []).map(i => ({
        name: i.name || '', amount: i.amount, unit: i.unit || 'tsp',
      })),
    })),
    _instructionsExpanded: new Set(
      (inner.steps || []).reduce((acc, s, i) => { if ((s.instructions || '').trim()) acc.push(i); return acc; }, [])
    ),
  };
  state.recipeReturnTo = state.screen === 'admin' ? 'admin' : 'tab-shell';
  navigate('builder-info');
}

async function downloadBulkSauceExport() {
  if (!session || !session.access_token) { openAuthModal(); return; }
  try {
    const res = await fetch(`${API}/api/v1/sauceboss/admin/sauces/export.json`, {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    });
    if (!res.ok) {
      await SauceBossPopup.alert({ title: 'Export failed', body: res.statusText });
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sauceboss-sauces-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    await SauceBossPopup.alert({ title: 'Export failed', body: e.message });
  }
}
