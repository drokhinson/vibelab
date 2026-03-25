'use strict';

// ─── Builder Screens ──────────────────────────────────────────────────────────
function renderBuilder() {
  const b = state.builder;
  const esc = s => (s || '').replace(/"/g, '&quot;');

  const cuisineChips = CUISINES.map(c =>
    `<button class="cuisine-chip ${b.cuisine === c.name ? 'selected' : ''}" onclick="builderSetCuisine('${c.name}','${c.emoji}')">${renderEmoji(c.emoji)} ${c.name}</button>`
  ).join('');

  const colorDots = COLOR_SWATCHES.map(hex =>
    `<button class="color-swatch ${b.color === hex ? 'selected' : ''}" style="background:${hex}" onclick="builderSetColor('${hex}')"></button>`
  ).join('');

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

    const unitOptions = Object.keys(state.units).length > 0 ? Object.keys(state.units) : UNITS;

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
          <div class="category-chips">
            ${CATEGORY_ORDER.map(cat =>
              `<button class="category-chip" data-classify-cat="${cat}" data-step="${si}" data-ing="${ii}">${cat}</button>`
            ).join('')}
          </div>
        </div>` : '';

      const originalHint = ing.originalText
        ? `<div class="ing-original-hint">originally: ${ing.originalText}</div>` : '';

      return `<div class="ingredient-row-wrap">
        <div class="ingredient-row">
          <div class="ing-name-wrap">
            <input class="builder-input ing-name" placeholder="Ingredient" value="${esc(ing.name)}" data-builder-field="ing-name" data-step="${si}" data-ing="${ii}" autocomplete="off">
            ${acDropdown}
          </div>
          <input class="builder-input ing-amount" type="number" step="0.1" min="0" placeholder="Qty" value="${ing.amount}" data-builder-field="ing-amount" data-step="${si}" data-ing="${ii}">
          <select class="ing-unit" data-builder-field="ing-unit" data-step="${si}" data-ing="${ii}">
            ${unitOptions.map(u => `<option ${ing.unit === u ? 'selected' : ''}>${u}</option>`).join('')}
          </select>
          ${step.ingredients.length > 1 ? `<button class="remove-ing-btn" onclick="builderRemoveIngredient(${si},${ii})">✕</button>` : ''}
        </div>
        ${categoryChips}
        ${originalHint}
      </div>`;
    }).join('');

    return `<div class="builder-step-card">
      ${b.steps.length > 1 ? `<button class="remove-step-btn" onclick="builderRemoveStep(${si})">✕</button>` : ''}
      <div class="step-number">Step ${si + 1}</div>
      ${stepRefHTML}
      <input class="builder-input" placeholder="Step title (e.g., Sauté the base)" value="${esc(step.title)}" data-builder-field="step-title" data-step="${si}">
      <div class="builder-ings-list">${ingsHTML}</div>
      <button class="add-ing-btn" onclick="builderAddIngredient(${si})">+ Ingredient</button>
    </div>`;
  }).join('');

  const canContinue = b.name.trim() && b.cuisine && b.steps.some(s => s.title.trim() && s.ingredients.some(i => i.name.trim() && i.amount));

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('carb-selector')">‹ Back</button>
      <div class="logo"><span>🍲</span>Create a Sauce</div>
    </div>
    <div class="scroll-body">
      <div class="builder-sticky-header">
        <input class="builder-input builder-name-input" placeholder="Sauce name" value="${esc(b.name)}" data-builder-field="name">
        <div class="builder-servings-row">
          <label>Servings</label>
          <input class="builder-input" type="number" min="1" step="1" placeholder="e.g. 4" value="${b.servings || ''}" data-builder-field="servings">
          ${b.yieldQuantity ? `<span style="font-size:13px;color:#9CA3AF">≈ ${b.yieldQuantity} ${b.yieldUnit || ''}</span>` : ''}
        </div>
        ${b.sourceName ? `<p style="font-size:12px;color:#9CA3AF;margin-bottom:8px">Imported from ${b.sourceName}</p>` : ''}
        <p class="builder-label">Cuisine</p>
        <div class="cuisine-chips">${cuisineChips}</div>
        <p class="builder-label">Color</p>
        <div class="color-swatches">${colorDots}</div>
      </div>
      <p class="builder-label" style="margin-top:16px">Steps</p>
      ${stepsHTML}
      <button class="add-step-btn" onclick="builderAddStep()">+ Add Step</button>
      <button class="builder-primary-btn" onclick="navigate('builder-carbs')" ${canContinue ? '' : 'disabled'}>Continue — Pair with Carbs</button>
    </div>
  `;
}

function renderBuilderCarbs() {
  const b = state.builder;
  const carbsHTML = state.carbs.map(c => {
    const selected = b.carbIds.includes(c.id);
    return `<button class="carb-card carb-card-check ${selected ? 'selected' : ''}" onclick="builderToggleCarb('${c.id}')">
      ${selected ? '<span class="check-mark">✓</span>' : ''}
      <span class="carb-emoji">${c.emoji}</span>
      <div class="carb-name">${c.name}</div>
    </button>`;
  }).join('');

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('builder')">‹ Back</button>
      <div class="logo"><span class="color-dot-header" style="background:${b.color}"></span>${b.name || 'New Sauce'}</div>
      <div class="subtitle">${b.cuisine ? renderEmoji(b.cuisineEmoji) + ' ' + b.cuisine : 'Select carbs'}</div>
    </div>
    <div class="scroll-body">
      <p class="section-label">Which carbs go with this sauce?</p>
      <div class="carb-grid">${carbsHTML}</div>
      <button class="builder-primary-btn" onclick="navigate('builder-review')" ${b.carbIds.length > 0 ? '' : 'disabled'}>Review Sauce</button>
    </div>
  `;
}

function renderBuilderReview() {
  const b = state.builder;
  const pairedCarbs = state.carbs.filter(c => b.carbIds.includes(c.id));
  const totalIngs = b.steps.reduce((sum, s) => sum + s.ingredients.filter(i => i.name.trim()).length, 0);

  const stepsPreview = b.steps.map((step, si) => `
    <div class="review-step-card">
      <div class="step-number">Step ${si + 1}</div>
      <div class="step-title">${step.title || '(untitled)'}</div>
      ${step.inputFromStep ? `<div class="step-ref-badge">⤶ Combines Step ${step.inputFromStep} output</div>` : ''}
      <div class="review-ing-list">
        ${step.ingredients.filter(i => i.name.trim()).map(i =>
          `<div class="review-ing-item">${i.amount} ${i.unit} ${i.name}</div>`
        ).join('')}
      </div>
    </div>
  `).join('');

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('builder-carbs')">‹ Back</button>
      <div class="logo"><span class="color-dot-header" style="background:${b.color}"></span>${b.name}</div>
      <div class="subtitle">${renderEmoji(b.cuisineEmoji)} ${b.cuisine} · ${b.steps.length} step${b.steps.length > 1 ? 's' : ''} · ${totalIngs} ingredients</div>
    </div>
    <div class="scroll-body">
      <div class="review-summary">
        <div class="review-carbs">Pairs with: ${pairedCarbs.map(c => c.emoji + ' ' + c.name).join(', ')}</div>
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
  state.builder = defaultBuilder();
  navigate('builder');
}

function builderSetCuisine(name, emoji) {
  state.builder.cuisine = name;
  state.builder.cuisineEmoji = emoji;
  render();
}

function builderSetColor(hex) {
  state.builder.color = hex;
  render();
}

function builderAddStep() {
  state.builder.steps.push({ title: '', inputFromStep: null, ingredients: [{ name: '', amount: '', unit: 'tsp', unitType: 'volume' }] });
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
  state.builder.steps[si].ingredients.push({ name: '', amount: '', unit: 'tsp', unitType: 'volume' });
  render();
}

function builderRemoveIngredient(si, ii) {
  state.builder.steps[si].ingredients.splice(ii, 1);
  render();
}

function builderToggleCarb(id) {
  const idx = state.builder.carbIds.indexOf(id);
  if (idx >= 0) state.builder.carbIds.splice(idx, 1);
  else state.builder.carbIds.push(id);
  render();
}

function builderHandleInput(el) {
  const field = el.dataset.builderField;
  const si = parseInt(el.dataset.step);
  const ii = parseInt(el.dataset.ing);
  const b = state.builder;
  switch (field) {
    case 'name': b.name = el.value; break;
    case 'step-title': b.steps[si].title = el.value; break;
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
      b.steps[si].ingredients[ii].unit = el.value;
      const unitDef = state.units[el.value];
      b.steps[si].ingredients[ii].unitType = unitDef ? unitDef.unit_type : 'volume';
      break;
    }
    case 'servings': b.servings = el.value ? parseInt(el.value) : null; break;
    case 'input-from-step': {
      b.steps[si].inputFromStep = el.value ? parseInt(el.value) : null;
      break;
    }
  }
  const btn = document.querySelector('.builder-primary-btn');
  if (btn && state.screen === 'builder') {
    const canContinue = b.name.trim() && b.cuisine && b.steps.some(s => s.title.trim() && s.ingredients.some(i => i.name.trim() && i.amount));
    btn.disabled = !canContinue;
  }
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

async function builderSave() {
  const b = state.builder;
  b.saving = true;
  b.error = null;
  render();
  try {
    const payload = {
      name: b.name.trim(),
      cuisine: b.cuisine,
      cuisineEmoji: b.cuisineEmoji,
      color: b.color,
      description: b.description,
      carbIds: b.carbIds,
      ...(b.servings != null && { servings: b.servings }),
      ...(b.yieldQuantity != null && { yield_quantity: b.yieldQuantity }),
      ...(b.yieldUnit && { yield_unit: b.yieldUnit }),
      ...(b.sourceUrl && { source_url: b.sourceUrl }),
      ...(b.sourceName && { source_name: b.sourceName }),
      steps: b.steps
        .filter(s => s.title.trim())
        .map(s => ({
          title: s.title.trim(),
          inputFromStep: s.inputFromStep || null,
          ingredients: s.ingredients
            .filter(i => i.name.trim() && parseFloat(i.amount) > 0)
            .map(i => ({
              name: i.name.trim(),
              amount: parseFloat(i.amount),
              unit: i.unit,
              unit_type: i.unitType || 'volume',
              ...(i.originalText && { original_text: i.originalText }),
            })),
        }))
        .filter(s => s.ingredients.length > 0),
    };
    await createSauce(payload);
    state.builder = null;
    navigate('carb-selector');
  } catch (err) {
    b.saving = false;
    b.error = err.message;
    render();
  }
}

// ─── URL Import Modal ──────────────────────────────────────────────────────────
function renderImportModal() {
  return `
    <div class="import-overlay" onclick="if(event.target===this)closeImportModal()">
      <div class="import-modal">
        <h3>Import from URL</h3>
        <p class="import-hint">Paste a recipe URL — we'll parse the ingredients and pre-fill the sauce builder for you to review.</p>
        <input class="builder-input" id="import-url-input" type="url"
          placeholder="https://..."
          ${state.importLoading ? 'disabled' : ''}
          onkeydown="if(event.key==='Enter')submitImportUrl()">
        ${state.importError ? `<p class="import-error">${state.importError}</p>` : ''}
        <button class="builder-primary-btn" onclick="submitImportUrl()" ${state.importLoading ? 'disabled' : ''}>
          ${state.importLoading ? '<span class="spinner-sm"></span> Importing…' : 'Import Recipe'}
        </button>
        <button class="builder-secondary-btn" onclick="closeImportModal()">Cancel</button>
      </div>
    </div>`;
}

function openImportModal() {
  state.importModal = true;
  state.importError = null;
  render();
  // Focus the URL input after render
  requestAnimationFrame(() => {
    const input = document.getElementById('import-url-input');
    if (input) input.focus();
  });
}

function closeImportModal() {
  state.importModal = false;
  state.importLoading = false;
  state.importError = null;
  render();
}

async function submitImportUrl() {
  const input = document.getElementById('import-url-input');
  const url = input ? input.value.trim() : '';
  if (!url) return;
  state.importLoading = true;
  state.importError = null;
  render();
  try {
    const res = await fetch(`${API}/api/v1/sauceboss/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    state.importModal = false;
    state.importLoading = false;
    prefillBuilder(data);
  } catch (err) {
    state.importLoading = false;
    state.importError = err.message;
    render();
  }
}

function prefillBuilder(data) {
  state.builder = {
    ...defaultBuilder(),
    name: data.name || '',
    description: data.description || '',
    cuisine: data.cuisine || '',
    cuisineEmoji: '',
    servings: data.servings || null,
    yieldQuantity: data.yield_quantity || null,
    yieldUnit: data.yield_unit || null,
    sourceUrl: data.source_url || null,
    sourceName: data.source_name || null,
    steps: Array.isArray(data.steps) && data.steps.length > 0
      ? data.steps.map(s => ({
          title: s.title || '',
          inputFromStep: null,
          ingredients: (s.ingredients || []).map(i => ({
            name: i.name || '',
            amount: i.amount || '',
            unit: i.unit || 'tsp',
            unitType: i.unit_type || 'volume',
            originalText: i.original_text || null,
          })),
        }))
      : defaultBuilder().steps,
  };
  navigate('builder');
}
