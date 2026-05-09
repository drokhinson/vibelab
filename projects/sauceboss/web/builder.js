'use strict';

// ─── Builder Validation ───────────────────────────────────────────────────────
// Single source of truth for what blocks the Continue button. Used by the full
// renderer (to draw the validation card) and by the keystroke-level updater
// (which can't re-render without dropping input focus).
function _builderValidate(b) {
  const ingHasQuantity = i => i.name.trim() && (parseFloat(i.amount) > 0 || i.unit === 'to taste');
  const hasCuisine = b.cuisineDraftMode
    ? !!(b.cuisineDraftName.trim() && b.cuisineDraftEmoji.trim())
    : !!b.cuisine;
  const trayEmpty = (b.unassignedIngredients || []).length === 0;
  const untitledStepIdxs = b.steps
    .map((s, i) => s.title.trim() ? -1 : i)
    .filter(i => i >= 0);
  const hasUsableStep = b.steps.some(s => s.title.trim() && s.ingredients.some(ingHasQuantity));

  const issues = [];
  if (!b.name.trim())          issues.push('Add a sauce name');
  if (!b.sauceType)            issues.push('Select a type (Sauce / Marinade / Dressing / Dip)');
  if (!hasCuisine)             issues.push('Select a cuisine');
  if (!b.color)                issues.push('Pick a color');
  if (untitledStepIdxs.length) {
    const labels = untitledStepIdxs.map(i => i + 1).join(', ');
    issues.push(`Add a title to step ${labels}`);
  }
  if (!hasUsableStep)          issues.push('Add at least one ingredient with a quantity to a titled step');

  return { issues, canContinue: issues.length === 0 && trayEmpty, trayEmpty };
}

// ─── Builder Screens ──────────────────────────────────────────────────────────
function renderBuilder() {
  const b = state.builder;
  const esc = s => (s || '').replace(/"/g, '&quot;');

  const cuisineChips = availableCuisines().map(c =>
    `<button class="builder-chip ${!b.cuisineDraftMode && b.cuisine === c.name ? 'selected' : ''}" onclick="builderSetCuisine('${c.name.replace(/'/g, "\\'")}','${c.emoji}')">${renderEmoji(c.emoji)} ${c.name}</button>`
  ).join('') + `<button class="builder-chip ${b.cuisineDraftMode ? 'selected' : ''}" onclick="builderStartNewCuisine()">+ New cuisine…</button>`;

  const newCuisineInputs = b.cuisineDraftMode ? `
    <div class="new-cuisine-row">
      <input class="builder-input new-cuisine-name" placeholder="Cuisine name (e.g. Thai)"
             value="${esc(b.cuisineDraftName)}"
             data-builder-field="cuisine-draft-name">
      <input class="builder-input new-cuisine-emoji" placeholder="🌮" maxlength="4"
             value="${esc(b.cuisineDraftEmoji)}"
             data-builder-field="cuisine-draft-emoji">
      <button class="new-cuisine-cancel" onclick="builderCancelNewCuisine()">Cancel</button>
    </div>` : '';

  const colorDots = COLOR_SWATCHES.map(hex =>
    `<button class="color-swatch ${b.color === hex ? 'selected' : ''}" style="background:${hex}" onclick="builderSetColor('${hex}')"></button>`
  ).join('');

  const sauceTypeChips = SAUCE_TYPES.map(t =>
    `<button class="builder-chip builder-chip-lg ${b.sauceType === t.value ? 'selected' : ''}" onclick="builderSetSauceType('${t.value}')">${t.label}</button>`
  ).join('');

  // "Variant of" dropdown — only when creating a new sauce. Re-parenting an
  // existing sauce is intentionally out of scope; allowing it would let a
  // user re-pin somebody else's recipe under their family.
  const parentPool = (state.adminSauces || state.saucesForCurrentItem || [])
    .filter(s => !s.parentSauceId && s.id !== b.editingId);
  const parentOptions = parentPool
    .sort((a, b1) => (a.name || '').localeCompare(b1.name || ''))
    .map(s => `<option value="${s.id}" ${b.parentSauceId === s.id ? 'selected' : ''}>${esc(s.name)}${s.cuisine ? ` · ${esc(s.cuisine)}` : ''}</option>`)
    .join('');
  const variantOfHTML = b.editingId ? '' : `
    <p class="builder-label">Variant of (optional)</p>
    <div class="variant-of-row">
      <select class="builder-input" data-builder-field="parent-sauce">
        <option value="" ${!b.parentSauceId ? 'selected' : ''}>— Original recipe —</option>
        ${parentOptions}
      </select>
      ${b.parentSauceId ? `<p class="builder-hint">Cuisine, color, type, and pairings copied from the original. Steps stay yours.</p>` : ''}
    </div>`;

  const stepsHTML = b.steps.map((step, si) => {
    const stepRefHTML = si > 0 ? `
      <div class="step-ref-row">
        <label class="step-ref-label">Combine output from:</label>
        <select class="step-ref-select" data-builder-field="input-from-step" data-step="${si}">
          <option value="" ${!step.inputFromStep ? 'selected' : ''}>None — independent step</option>
          ${b.steps.slice(0, si).map((_, ri) =>
            `<option value="${ri + 1}" ${step.inputFromStep === ri + 1 ? 'selected' : ''}>Step ${ri + 1}${b.steps[ri].title ? ' — ' + b.steps[ri].title.slice(0, 25) : ''}</option>`
          ).join('')}
        </select>
      </div>` : '';

    const ingsHTML = step.ingredients.map((ing, ii) => {
      const isAcActive = b.acStep === si && b.acIng === ii && b.acResults.length > 0;
      const acDropdown = isAcActive ? `
        <div class="ac-dropdown">
          ${b.acResults.map((name, idx) =>
            `<div class="ac-item ${idx === b.acSelected ? 'ac-selected' : ''}" data-ac-pick="${name.replace(/"/g, '&quot;')}" data-step="${si}" data-ing="${ii}">${name}</div>`
          ).join('')}
        </div>` : '';

      const needsCategory = ing.name.trim().length >= 2 && !isKnownIngredient(ing.name) && ing._showCategory;
      const categoryChips = needsCategory ? `
        <div class="category-classify">
          <span class="category-classify-label">Classify "${ing.name.trim()}":</span>
          <div class="builder-chip-row">
            ${CATEGORY_ORDER.map(cat =>
              `<button class="builder-chip" data-classify-cat="${cat}" data-step="${si}" data-ing="${ii}">${cat}</button>`
            ).join('')}
          </div>
        </div>` : '';

      const isQualitative = ing.unit === 'to taste';
      return `<div class="ingredient-row-wrap">
        <div class="ingredient-row">
          <div class="ing-name-wrap">
            <input class="builder-input ing-name" placeholder="Ingredient" value="${esc(ing.name)}" data-builder-field="ing-name" data-step="${si}" data-ing="${ii}" autocomplete="off">
            ${acDropdown}
          </div>
          <input class="builder-input ing-amount" type="number" step="0.1" min="0" placeholder="${isQualitative ? '—' : 'Qty'}" value="${isQualitative ? '' : ing.amount}" data-builder-field="ing-amount" data-step="${si}" data-ing="${ii}" ${isQualitative ? 'disabled' : ''}>
          <select class="ing-unit" data-builder-field="ing-unit" data-step="${si}" data-ing="${ii}">
            ${UNITS.map(u => `<option ${ing.unit === u ? 'selected' : ''}>${u}</option>`).join('')}
          </select>
          ${step.ingredients.length > 1 ? `<button class="remove-ing-btn" onclick="builderRemoveIngredient(${si},${ii})">✕</button>` : ''}
        </div>
        ${categoryChips}
      </div>`;
    }).join('');

    const timeValue = step.estimatedTime != null && step.estimatedTime !== '' ? step.estimatedTime : '';
    return `<div class="builder-step-card">
      ${b.steps.length > 1 ? `<button class="remove-step-btn" onclick="builderRemoveStep(${si})">✕</button>` : ''}
      <div class="step-number">Step ${si + 1}</div>
      ${stepRefHTML}
      <div class="builder-step-headline">
        <input class="builder-input builder-step-title" placeholder="Step title (e.g., Sauté the base)" value="${esc(step.title)}" data-builder-field="step-title" data-step="${si}">
        <label class="builder-step-time">
          <input class="builder-input builder-step-time-input" type="number" min="0" max="600" inputmode="numeric"
                 placeholder="5" value="${esc(String(timeValue))}"
                 data-builder-field="step-time" data-step="${si}">
          <span class="builder-step-time-suffix">min</span>
        </label>
      </div>
      <textarea class="builder-input builder-step-instructions" placeholder="Instructions (optional)" data-builder-field="step-instructions" data-step="${si}">${esc(step.instructions || '')}</textarea>
      <div class="builder-ings-list">${ingsHTML}</div>
      <button class="add-ing-btn" onclick="builderAddIngredient(${si})">+ Ingredient</button>
    </div>`;
  }).join('');

  const { issues, canContinue, trayEmpty } = _builderValidate(b);

  const validationHTML = issues.length > 0 ? `
    <div class="builder-validation-card">
      <div class="builder-validation-header">
        <span class="builder-validation-title">⚠ Finish these before continuing</span>
      </div>
      <ul class="builder-validation-list">
        ${issues.map(msg => `<li>${esc(msg)}</li>`).join('')}
      </ul>
    </div>` : '';

  const unassignedHTML = (b.unassignedIngredients && b.unassignedIngredients.length > 0) ? `
    <div class="builder-unassigned-card">
      <div class="builder-unassigned-header">
        <span class="builder-unassigned-title">⚠ Unassigned ingredients (${b.unassignedIngredients.length})</span>
        <span class="builder-unassigned-hint">Move each to a step or delete before saving.</span>
      </div>
      ${b.unassignedIngredients.map((ing, ui) => {
        const qty = ing.unit === 'to taste'
          ? 'to taste'
          : `${ing.amount !== '' && ing.amount != null ? ing.amount : ''} ${ing.unit || ''}`.trim();
        const stepOpts = b.steps.map((s, si) => {
          const label = `Step ${si + 1}${s.title ? ' — ' + s.title.slice(0, 25) : ''}`;
          return `<option value="${si}">${label}</option>`;
        }).join('');
        return `<div class="unassigned-row">
          <span class="unassigned-ing"><strong>${esc(ing.name)}</strong>${qty ? ` <span class="unassigned-qty">${esc(qty)}</span>` : ''}</span>
          <select class="unassigned-target" data-builder-field="unassigned-target" data-uidx="${ui}">
            <option value="">Move to step…</option>
            ${stepOpts}
          </select>
          <button class="unassigned-delete-btn" onclick="builderDeleteUnassigned(${ui})" title="Delete ingredient">✕</button>
        </div>`;
      }).join('')}
    </div>` : '';

  const importErr = b.importError ? `<div class="builder-error">${esc(b.importError)}</div>` : '';
  const importPanel = `
    <div class="builder-import-panel">
      <p class="builder-label">Import from URL</p>
      <div class="builder-import-row">
        <input class="builder-input builder-import-url" type="url" placeholder="https://… (recipe page)" value="${esc(b.importUrl || '')}" data-builder-field="import-url">
        <button class="builder-secondary-btn builder-import-btn" onclick="builderImport()" ${b.importing ? 'disabled' : ''}>
          ${b.importing ? '<span class="spinner-sm"></span> Importing…' : 'Import'}
        </button>
      </div>
      ${importErr}
    </div>`;

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('admin')">‹ Back</button>
      <div class="logo"><span>🍲</span>${b.editingId ? 'Edit Sauce' : 'Create a Sauce'}</div>
      ${renderHeaderAuthSlot()}
    </div>
    <div class="scroll-body">
      <div class="builder-sticky-header">
        ${importPanel}
        <input class="builder-input builder-name-input" placeholder="Sauce name" value="${esc(b.name)}" data-builder-field="name">
        <textarea class="builder-input builder-description-input" placeholder="Description (optional)" data-builder-field="description">${esc(b.description || '')}</textarea>
        <input class="builder-input" type="url" placeholder="Source URL (optional)" value="${esc(b.sourceUrl || '')}" data-builder-field="source-url">
        ${variantOfHTML}
        <p class="builder-label">Type</p>
        <div class="builder-chip-row">${sauceTypeChips}</div>
        <p class="builder-label">Cuisine</p>
        <div class="builder-chip-row">${cuisineChips}</div>
        ${newCuisineInputs}
        <p class="builder-label">Color</p>
        <div class="color-swatches">${colorDots}</div>
      </div>
      <p class="builder-label" style="margin-top:16px">Steps</p>
      ${stepsHTML}
      <button class="add-step-btn" onclick="builderAddStep()">+ Add Step</button>
      ${validationHTML}
      ${unassignedHTML}
      <button class="builder-primary-btn" onclick="navigate('builder-items')" ${canContinue ? '' : 'disabled'}${!canContinue ? ' title="Resolve the issues above to continue"' : ''}>Continue — Pair with ${SAUCE_TYPES.find(t => t.value === b.sauceType)?.pairLabel || 'Items'}</button>
    </div>
  `;
}

function _builderItemPool() {
  const t = SAUCE_TYPES.find(x => x.value === state.builder.sauceType);
  if (!t) return [];
  if (t.category === 'carb')    return state.carbs;
  if (t.category === 'protein') return state.proteins;
  if (t.category === 'salad')   return state.saladBases;
  return [];
}

function renderBuilderItems() {
  const b = state.builder;
  const t = SAUCE_TYPES.find(x => x.value === b.sauceType);
  const pool = _builderItemPool();
  const itemsHTML = pool.map(item => {
    const selected = b.itemIds.includes(item.id);
    return `<button class="carb-card carb-card-check ${selected ? 'selected' : ''}" onclick="builderToggleItem('${item.id}')">
      ${selected ? '<span class="check-mark">✓</span>' : ''}
      <span class="carb-emoji">${item.emoji}</span>
      <div class="carb-name">${item.name}</div>
    </button>`;
  }).join('');

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('builder')">‹ Back</button>
      <div class="logo"><span class="color-dot-header" style="background:${b.color}"></span>${b.name || 'New Sauce'}</div>
      <div class="subtitle">${b.cuisine ? renderEmoji(b.cuisineEmoji) + ' ' + b.cuisine : `Select ${t?.pairLabel?.toLowerCase() || 'items'}`}</div>
      ${renderHeaderAuthSlot()}
    </div>
    <div class="scroll-body">
      <p class="section-label">Which ${t?.pairLabel?.toLowerCase() || 'dishes'} go with this ${t?.label?.toLowerCase() || 'sauce'}?</p>
      <div class="carb-grid">${itemsHTML}</div>
      <button class="builder-primary-btn" onclick="navigate('builder-review')" ${b.itemIds.length > 0 ? '' : 'disabled'}>Review Sauce</button>
    </div>
  `;
}

function renderBuilderReview() {
  const b = state.builder;
  const esc = s => (s || '').replace(/"/g, '&quot;');
  const pool = _builderItemPool();
  const pairedItems = pool.filter(c => b.itemIds.includes(c.id));
  const totalIngs = b.steps.reduce((sum, s) => sum + s.ingredients.filter(i => i.name.trim()).length, 0);

  const stepsPreview = b.steps.map((step, si) => `
    <div class="review-step-card">
      <div class="step-number">Step ${si + 1}</div>
      <div class="step-title">${step.title || '(untitled)'}</div>
      ${step.instructions ? `<div class="review-step-instructions">${esc(step.instructions)}</div>` : ''}
      ${step.inputFromStep ? `<div class="step-ref-badge">⤶ Combines Step ${step.inputFromStep} output</div>` : ''}
      <div class="review-ing-list">
        ${step.ingredients.filter(i => i.name.trim()).map(i =>
          `<div class="review-ing-item">${i.unit === 'to taste' ? 'to taste' : `${i.amount} ${i.unit}`} ${i.name}</div>`
        ).join('')}
      </div>
    </div>
  `).join('');

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('builder-items')">‹ Back</button>
      <div class="logo"><span class="color-dot-header" style="background:${b.color}"></span>${b.name}</div>
      <div class="subtitle">${renderEmoji(b.cuisineEmoji)} ${b.cuisine} · ${b.steps.length} step${b.steps.length > 1 ? 's' : ''} · ${totalIngs} ingredients</div>
      ${renderHeaderAuthSlot()}
    </div>
    <div class="scroll-body">
      <div class="review-summary">
        <div class="review-carbs">Pairs with: ${pairedItems.map(c => c.emoji + ' ' + c.name).join(', ')}</div>
      </div>
      ${stepsPreview}
      ${b.error ? `<div class="builder-error">${b.error}</div>` : ''}
      <button class="builder-primary-btn" onclick="builderSave()" ${b.saving ? 'disabled' : ''}>
        ${b.saving ? '<span class="spinner-sm"></span> Saving…' : 'Save Sauce'}
      </button>
      <button class="builder-secondary-btn" onclick="navigate('builder')">Edit</button>
    </div>
  `;
}

// ─── Builder Actions ──────────────────────────────────────────────────────────
function openBuilder() {
  if (!currentUser) { openAuthModal(); return; }
  state.builder = defaultBuilder();
  // Track where to land after save: from the admin sauce manager → admin;
  // from the Saucebook FAB or any other entry point → Saucebook tab.
  state.recipeReturnTo = state.screen === 'admin' ? 'admin' : 'tab-shell';
  navigate('builder');
}

function builderSetCuisine(name, emoji) {
  state.builder.cuisine = name;
  state.builder.cuisineEmoji = emoji;
  state.builder.cuisineDraftMode = false;
  state.builder.cuisineDraftName = '';
  state.builder.cuisineDraftEmoji = '';
  render();
}

function builderStartNewCuisine() {
  state.builder.cuisineDraftMode = true;
  state.builder.cuisine = '';
  state.builder.cuisineEmoji = '';
  render();
}

function builderCancelNewCuisine() {
  state.builder.cuisineDraftMode = false;
  state.builder.cuisineDraftName = '';
  state.builder.cuisineDraftEmoji = '';
  render();
}

function builderSetColor(hex) {
  state.builder.color = hex;
  render();
}

function builderAddStep() {
  state.builder.steps.push({ title: '', instructions: '', inputFromStep: null, estimatedTime: null, ingredients: [{ name: '', amount: '', unit: 'tsp' }] });
  render();
}

function builderRemoveStep(si) {
  const removedOrder = si + 1;
  state.builder.steps.splice(si, 1);
  for (const step of state.builder.steps) {
    if (step.inputFromStep === removedOrder) step.inputFromStep = null;
    else if (step.inputFromStep > removedOrder) step.inputFromStep--;
  }
  render();
}

function builderAddIngredient(si) {
  state.builder.steps[si].ingredients.push({ name: '', amount: '', unit: 'tsp' });
  render();
}

function builderRemoveIngredient(si, ii) {
  state.builder.steps[si].ingredients.splice(ii, 1);
  render();
}

// Move an ingredient out of the unassigned tray and into the chosen step's
// ingredient list. Strips internal helper fields the step rows don't use so
// the row matches the shape produced by `defaultBuilder()`.
function builderMoveUnassignedToStep(uidx, si) {
  const b = state.builder;
  if (uidx < 0 || uidx >= b.unassignedIngredients.length) return;
  if (si < 0 || si >= b.steps.length) return;
  const ing = b.unassignedIngredients[uidx];
  b.steps[si].ingredients.push({
    name: ing.name || '',
    amount: ing.amount != null ? ing.amount : '',
    unit: ing.unit || 'tsp',
    originalText: ing.originalText || '',
    canonicalMl: ing.canonicalMl != null ? ing.canonicalMl : null,
    canonicalG:  ing.canonicalG  != null ? ing.canonicalG  : null,
  });
  b.unassignedIngredients.splice(uidx, 1);
  render();
}

function builderDeleteUnassigned(uidx) {
  const list = state.builder.unassignedIngredients;
  if (uidx < 0 || uidx >= list.length) return;
  list.splice(uidx, 1);
  render();
}

function builderSetSauceType(value) {
  if (state.builder.sauceType === value) return;
  state.builder.sauceType = value;
  state.builder.itemIds = [];   // selections from another category no longer apply
  render();
}

function builderToggleItem(id) {
  const idx = state.builder.itemIds.indexOf(id);
  if (idx >= 0) state.builder.itemIds.splice(idx, 1);
  else state.builder.itemIds.push(id);
  render();
}

function builderHandleInput(el) {
  const field = el.dataset.builderField;
  const si = parseInt(el.dataset.step);
  const ii = parseInt(el.dataset.ing);
  const b = state.builder;
  let needsRender = false;
  switch (field) {
    case 'name': b.name = el.value; break;
    case 'description': b.description = el.value; break;
    case 'source-url': b.sourceUrl = el.value; break;
    case 'import-url': b.importUrl = el.value; break;
    case 'cuisine-draft-name': b.cuisineDraftName = el.value; break;
    case 'cuisine-draft-emoji': b.cuisineDraftEmoji = el.value; break;
    case 'step-title': b.steps[si].title = el.value; break;
    case 'step-instructions': b.steps[si].instructions = el.value; break;
    case 'step-time': {
      // Empty string clears the explicit value so the read paths fall back
      // to the legacy 5-minute default.
      const v = el.value.trim();
      b.steps[si].estimatedTime = v === '' ? null : Math.max(0, Math.min(600, parseInt(v, 10) || 0));
      break;
    }
    case 'ing-name': {
      b.steps[si].ingredients[ii].name = el.value;
      const matches = fuzzyMatchIngredients(el.value);
      b.acStep = si;
      b.acIng = ii;
      b.acResults = matches;
      b.acSelected = -1;
      updateAutocompleteDropdown(si, ii, matches);
      break;
    }
    case 'ing-amount': b.steps[si].ingredients[ii].amount = el.value; break;
    case 'ing-unit': {
      const prev = b.steps[si].ingredients[ii].unit;
      b.steps[si].ingredients[ii].unit = el.value;
      // Toggling in/out of "to taste" changes whether the amount input is
      // disabled — re-render so the row reflects the new state.
      if ((prev === 'to taste') !== (el.value === 'to taste')) needsRender = true;
      break;
    }
    case 'input-from-step': {
      b.steps[si].inputFromStep = el.value ? parseInt(el.value) : null;
      break;
    }
    case 'unassigned-target': {
      if (el.value === '') break;
      const uidx = parseInt(el.dataset.uidx);
      const targetSi = parseInt(el.value);
      builderMoveUnassignedToStep(uidx, targetSi);
      return;
    }
    case 'parent-sauce': {
      const id = el.value || null;
      b.parentSauceId = id;
      if (id) {
        const pool = state.adminSauces || state.saucesForCurrentItem || [];
        const parent = pool.find(s => s.id === id);
        if (parent) _builderPrefillFromParent(parent);
      }
      needsRender = true;
      break;
    }
  }
  if (needsRender) {
    render();
    return;
  }
  if (state.screen === 'builder') _builderRefreshValidation();
}

// Update the disabled state of Continue and the contents of the validation card
// without re-rendering — keystroke handlers call this to keep warnings live
// while preserving input focus.
function _builderRefreshValidation() {
  const b = state.builder;
  const { issues, canContinue } = _builderValidate(b);

  const btn = document.querySelector('.builder-primary-btn');
  if (btn) {
    btn.disabled = !canContinue;
    if (canContinue) btn.removeAttribute('title');
    else btn.setAttribute('title', 'Resolve the issues above to continue');
  }

  const esc = s => (s || '').replace(/"/g, '&quot;');
  const card = document.querySelector('.builder-validation-card');
  if (issues.length === 0) {
    if (card) card.remove();
    return;
  }
  const listHTML = issues.map(msg => `<li>${esc(msg)}</li>`).join('');
  if (card) {
    const list = card.querySelector('.builder-validation-list');
    if (list) list.innerHTML = listHTML;
    return;
  }
  // Card doesn't exist yet (issues just appeared) — full re-render is the
  // simplest way to insert it in the right spot. Acceptable here because the
  // input that triggered this almost always still has a valid issue against
  // it; focus loss is rare in practice.
  render();
}

function updateAutocompleteDropdown(si, ii, matches) {
  document.querySelectorAll('.ac-dropdown').forEach(d => d.remove());
  if (matches.length === 0) return;
  const input = document.querySelector(`.ing-name[data-step="${si}"][data-ing="${ii}"]`);
  if (!input) return;
  const wrap = input.closest('.ing-name-wrap');
  if (!wrap) return;
  const dd = document.createElement('div');
  dd.className = 'ac-dropdown';
  dd.innerHTML = matches.map((name, idx) =>
    `<div class="ac-item" data-ac-pick="${name.replace(/"/g, '&quot;')}" data-step="${si}" data-ing="${ii}">${name}</div>`
  ).join('');
  wrap.appendChild(dd);
}

function builderPickAutocomplete(name, si, ii) {
  const b = state.builder;
  b.steps[si].ingredients[ii].name = name;
  b.acResults = [];
  b.acStep = null;
  b.acIng = null;
  const input = document.querySelector(`.ing-name[data-step="${si}"][data-ing="${ii}"]`);
  if (input) input.value = name;
  document.querySelectorAll('.ac-dropdown').forEach(d => d.remove());
}

function builderClassifyIngredient(si, ii, category) {
  const b = state.builder;
  const ing = b.steps[si].ingredients[ii];
  classifyIngredient(ing.name, category);
  ing._showCategory = false;
  const wrap = document.querySelector(`.ingredient-row-wrap:has([data-step="${si}"][data-ing="${ii}"].ing-name)`);
  if (wrap) {
    const classify = wrap.querySelector('.category-classify');
    if (classify) classify.remove();
  }
}

// Copy metadata only from a parent sauce when "Variant of" is set. Steps,
// ingredients, and any imported source URL are intentionally untouched so a
// user can import a recipe and *then* mark it as a variant of an existing
// sauce without losing the imported recipe content.
function _builderPrefillFromParent(parent) {
  const b = state.builder;
  b.cuisine        = parent.cuisine || b.cuisine;
  b.cuisineEmoji   = parent.cuisineEmoji || b.cuisineEmoji;
  b.color          = parent.color || b.color;
  b.sauceType      = parent.sauceType || b.sauceType;
  // Clone itemIds so later edits to the variant don't mutate the cached
  // parent object in state.adminSauces.
  b.itemIds        = Array.isArray(parent.compatibleItems) ? [...parent.compatibleItems] : [];
  // Description is the only field that can be a real authored field on the
  // variant — only fill it when the user hasn't typed anything yet.
  if (!b.description) b.description = parent.description || '';
}

// ─── Import-from-URL ──────────────────────────────────────────────────────────
async function builderImport() {
  const b = state.builder;
  const url = (b.importUrl || '').trim();
  if (!url) {
    b.importError = 'Paste a recipe URL first.';
    render();
    return;
  }
  b.importing = true;
  b.importError = null;
  render();
  try {
    const parsed = await importRecipeFromUrl(url);
    _builderApplyParsedRecipe(parsed);
    b.importing = false;
    render();
  } catch (err) {
    b.importing = false;
    b.importError = err.message || 'Import failed.';
    render();
  }
}

// Maps a /import response into the existing builder form. The actual logic
// (parsing rules, step-matching, plural stem, unit normalisation) lives in
// shared/builder.js so native uses identical behaviour. This wrapper keeps
// the web-specific concern: stamping the result onto state.builder and
// surfacing the "no ingredients parsed" import error.
function _builderApplyParsedRecipe(parsed) {
  const b = state.builder;
  const hasIngs = (parsed?.ingredients || []).some((p) => (p?.foodRaw || '').trim());
  if (!hasIngs) {
    b.unassignedIngredients = [];
    b.importError = 'No ingredients parsed — try a different URL.';
    return;
  }
  const next = SBShared.builder.applyParsedRecipe(b, parsed);
  Object.assign(b, next);
}

async function builderSave() {
  const b = state.builder;
  if ((b.unassignedIngredients || []).length > 0) {
    b.error = 'Move or delete every unassigned ingredient before saving.';
    render();
    return;
  }
  if (!b.name.trim()) {
    b.error = 'Sauce name is required.';
    render();
    return;
  }
  if (!b.sauceType) {
    b.error = 'Select a type before saving.';
    render();
    return;
  }
  if (!b.color) {
    b.error = 'Pick a color before saving.';
    render();
    return;
  }
  if (b.steps.some(s => !s.title.trim())) {
    b.error = 'Every step needs a title.';
    render();
    return;
  }
  if (b.cuisineDraftMode) {
    const draftName = (b.cuisineDraftName || '').trim();
    const draftEmoji = (b.cuisineDraftEmoji || '').trim();
    if (!draftName || !draftEmoji) {
      b.error = 'New cuisine needs a name and emoji.';
      render();
      return;
    }
    b.cuisine = draftName;
    b.cuisineEmoji = draftEmoji;
    b.cuisineDraftMode = false;
  }
  if (!b.cuisine) {
    b.error = 'Select a cuisine before saving.';
    render();
    return;
  }
  b.saving = true;
  b.error = null;
  render();
  try {
    const payload = {
      name: b.name.trim(),
      cuisine: b.cuisine,
      cuisineEmoji: b.cuisineEmoji,
      color: b.color,
      description: b.description || '',
      sourceUrl: (b.sourceUrl || '').trim() || null,
      sauceType: b.sauceType,
      parentSauceId: b.parentSauceId || null,
      itemIds: b.itemIds,
      steps: b.steps
        .map(s => ({
          title: s.title.trim(),
          instructions: (s.instructions || '').trim() || null,
          inputFromStep: s.inputFromStep || null,
          estimatedTime: s.estimatedTime != null && s.estimatedTime !== '' ? s.estimatedTime : null,
          ingredients: s.ingredients
            .filter(i => i.name.trim() && (parseFloat(i.amount) > 0 || i.unit === 'to taste'))
            .map(i => {
              const isQualitative = i.unit === 'to taste';
              return {
                name: i.name.trim(),
                amount: isQualitative ? 0 : parseFloat(i.amount),
                unit: i.unit,
                originalText: i.originalText || (isQualitative
                  ? `to taste ${i.name}`.trim()
                  : `${i.amount} ${i.unit} ${i.name}`.trim()),
              };
            }),
        }))
        .filter(s => s.ingredients.length > 0),
    };
    let result;
    if (b.editingId) {
      result = await updateSauce(b.editingId, payload);
      // Server returns { message, forkedId } when the editor isn't the owner.
      // The user's saucebook entry has already been repointed server-side; we
      // just need to sync the local mirror so the next render shows the variant.
      if (result && result.forkedId) {
        try {
          state.saucebook = await api.listSaucebook();
        } catch (_) {}
      }
    } else {
      result = await createSauce(payload);
      // Backend auto-adds the new sauce to the author's saucebook; mirror that
      // locally so the Saucebook tab shows it without a re-fetch.
      try {
        state.saucebook = await api.listSaucebook();
      } catch (_) {}
    }
    state.builder = null;
    // Default landing after save is the Saucebook tab; admins coming from the
    // sauce manager keep the legacy admin landing if that's where they began.
    if (state.recipeReturnTo === 'admin') {
      await openSauceManager();
    } else {
      setActiveTab('saucebook');
    }
  } catch (err) {
    b.saving = false;
    b.error = err.message;
    render();
  }
}
