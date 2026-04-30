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

  const sauceTypeChips = SAUCE_TYPES.map(t =>
    `<button class="cuisine-chip ${b.sauceType === t.value ? 'selected' : ''}" onclick="builderSetSauceType('${t.value}')">${t.label}</button>`
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

      return `<div class="ingredient-row-wrap">
        <div class="ingredient-row">
          <div class="ing-name-wrap">
            <input class="builder-input ing-name" placeholder="Ingredient" value="${esc(ing.name)}" data-builder-field="ing-name" data-step="${si}" data-ing="${ii}" autocomplete="off">
            ${acDropdown}
          </div>
          <input class="builder-input ing-amount" type="number" step="0.1" min="0" placeholder="Qty" value="${ing.amount}" data-builder-field="ing-amount" data-step="${si}" data-ing="${ii}">
          <select class="ing-unit" data-builder-field="ing-unit" data-step="${si}" data-ing="${ii}">
            ${UNITS.map(u => `<option ${ing.unit === u ? 'selected' : ''}>${u}</option>`).join('')}
          </select>
          ${step.ingredients.length > 1 ? `<button class="remove-ing-btn" onclick="builderRemoveIngredient(${si},${ii})">✕</button>` : ''}
        </div>
        ${categoryChips}
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
      <div class="logo"><span>🍲</span>Create a Sauce</div>
    </div>
    <div class="scroll-body">
      <div class="builder-sticky-header">
        ${importPanel}
        <input class="builder-input builder-name-input" placeholder="Sauce name" value="${esc(b.name)}" data-builder-field="name">
        <p class="builder-label">Type</p>
        <div class="cuisine-chips">${sauceTypeChips}</div>
        <p class="builder-label">Cuisine</p>
        <div class="cuisine-chips">${cuisineChips}</div>
        <p class="builder-label">Color</p>
        <div class="color-swatches">${colorDots}</div>
      </div>
      <p class="builder-label" style="margin-top:16px">Steps</p>
      ${stepsHTML}
      <button class="add-step-btn" onclick="builderAddStep()">+ Add Step</button>
      <button class="builder-primary-btn" onclick="navigate('builder-items')" ${canContinue ? '' : 'disabled'}>Continue — Pair with ${SAUCE_TYPES.find(t => t.value === b.sauceType)?.pairLabel || 'Items'}</button>
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
  const pool = _builderItemPool();
  const pairedItems = pool.filter(c => b.itemIds.includes(c.id));
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
      <button class="back-btn" onclick="navigate('builder-items')">‹ Back</button>
      <div class="logo"><span class="color-dot-header" style="background:${b.color}"></span>${b.name}</div>
      <div class="subtitle">${renderEmoji(b.cuisineEmoji)} ${b.cuisine} · ${b.steps.length} step${b.steps.length > 1 ? 's' : ''} · ${totalIngs} ingredients</div>
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
  state.builder.steps.push({ title: '', inputFromStep: null, ingredients: [{ name: '', amount: '', unit: 'tsp' }] });
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
  switch (field) {
    case 'name': b.name = el.value; break;
    case 'import-url': b.importUrl = el.value; break;
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
    case 'ing-unit': b.steps[si].ingredients[ii].unit = el.value; break;
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

// Maps a /import response into the existing builder form. Strategy:
//   - Top-level fields (name, description) overwrite if currently empty.
//   - Ingredients become a single step (titled from the URL host) so the user
//     can manually re-group into multiple steps if they want. We don't try to
//     auto-segment instructions today — keeps the import deterministic.
//   - For each parsed ingredient: drop ones with no usable food name, and
//     map (foodRaw, quantity, unitRaw, originalText, canonicals) onto the
//     builder's ingredient schema.
function _builderApplyParsedRecipe(parsed) {
  const b = state.builder;
  if (!b.name) b.name = parsed.name || b.name;
  if (parsed.description && !b.description) b.description = parsed.description;

  const ings = (parsed.ingredients || [])
    .map(p => {
      const food = (p.foodRaw || '').trim();
      if (!food) return null;
      return {
        name: food,
        amount: p.quantity != null ? p.quantity : '',
        unit: _unitDisplayFromParsed(p),
        originalText: p.originalText || '',
        canonicalMl: p.canonicalMl != null ? p.canonicalMl : null,
        canonicalG:  p.canonicalG  != null ? p.canonicalG  : null,
      };
    })
    .filter(Boolean);
  if (ings.length === 0) {
    b.importError = 'No ingredients parsed — try a different URL.';
    return;
  }

  let stepTitle = 'Imported';
  try {
    stepTitle = `Imported from ${new URL(parsed.sourceUrl).hostname.replace(/^www\./, '')}`;
  } catch { /* ignore */ }

  b.steps = [{ title: stepTitle, inputFromStep: null, ingredients: ings }];
}

// Picks the unit string the builder UI should show for a parsed ingredient.
// Prefers a recognised unit alias from UNITS (so the existing select reflects
// it correctly); otherwise falls back to the raw scraper text or 'tsp'.
function _unitDisplayFromParsed(parsed) {
  const raw = (parsed.unitRaw || '').toLowerCase().trim();
  if (!raw) return 'tsp';
  const exact = UNITS.find(u => u.toLowerCase() === raw);
  if (exact) return exact;
  // Match common pluralisations / abbreviations to known UNITS.
  const map = {
    teaspoon: 'tsp', teaspoons: 'tsp', tsps: 'tsp',
    tablespoon: 'tbsp', tablespoons: 'tbsp', tbsps: 'tbsp',
    cups: 'cup', grams: 'g', kg: 'g', kilogram: 'g', kilograms: 'g',
    ounce: 'oz', ounces: 'oz', pound: 'oz', pounds: 'oz',
    cloves: 'clove', pieces: 'piece',
  };
  return map[raw] || raw;
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
      sauceType: b.sauceType,
      itemIds: b.itemIds,
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
              originalText: i.originalText || `${i.amount} ${i.unit} ${i.name}`.trim(),
            })),
        }))
        .filter(s => s.ingredients.length > 0),
    };
    await createSauce(payload);
    state.builder = null;
    navigate('admin');
  } catch (err) {
    b.saving = false;
    b.error = err.message;
    render();
  }
}
