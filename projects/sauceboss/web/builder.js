'use strict';

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

    return `<div class="builder-step-card">
      ${b.steps.length > 1 ? `<button class="remove-step-btn" onclick="builderRemoveStep(${si})">✕</button>` : ''}
      <div class="step-number">Step ${si + 1}</div>
      ${stepRefHTML}
      <input class="builder-input" placeholder="Step title (e.g., Sauté the base)" value="${esc(step.title)}" data-builder-field="step-title" data-step="${si}">
      <div class="builder-ings-list">${ingsHTML}</div>
      <button class="add-ing-btn" onclick="builderAddIngredient(${si})">+ Ingredient</button>
    </div>`;
  }).join('');

  const ingHasQuantity = i => i.name.trim() && (parseFloat(i.amount) > 0 || i.unit === 'to taste');
  const hasCuisine = b.cuisineDraftMode
    ? !!(b.cuisineDraftName.trim() && b.cuisineDraftEmoji.trim())
    : !!b.cuisine;
  const canContinue = b.name.trim() && hasCuisine && b.steps.some(s => s.title.trim() && s.ingredients.some(ingHasQuantity));

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
    </div>
    <div class="scroll-body">
      <div class="builder-sticky-header">
        ${importPanel}
        <input class="builder-input builder-name-input" placeholder="Sauce name" value="${esc(b.name)}" data-builder-field="name">
        <textarea class="builder-input builder-description-input" placeholder="Description (optional)" data-builder-field="description">${esc(b.description || '')}</textarea>
        <input class="builder-input" type="url" placeholder="Source URL (optional)" value="${esc(b.sourceUrl || '')}" data-builder-field="source-url">
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
  let needsRender = false;
  switch (field) {
    case 'name': b.name = el.value; break;
    case 'description': b.description = el.value; break;
    case 'source-url': b.sourceUrl = el.value; break;
    case 'import-url': b.importUrl = el.value; break;
    case 'cuisine-draft-name': b.cuisineDraftName = el.value; break;
    case 'cuisine-draft-emoji': b.cuisineDraftEmoji = el.value; break;
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
  }
  if (needsRender) {
    render();
    return;
  }
  const btn = document.querySelector('.builder-primary-btn');
  if (btn && state.screen === 'builder') {
    const hasCuisine = b.cuisineDraftMode
      ? !!(b.cuisineDraftName.trim() && b.cuisineDraftEmoji.trim())
      : !!b.cuisine;
    const canContinue = b.name.trim() && hasCuisine && b.steps.some(s => s.title.trim() && s.ingredients.some(i => i.name.trim() && (parseFloat(i.amount) > 0 || i.unit === 'to taste')));
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
//   - Top-level fields (name, description) fill if currently empty.
//   - Each scraped instruction becomes its own builder step. Each parsed
//     ingredient is assigned to the earliest step whose instruction text
//     mentions its name; later mentions get the same row with a blank amount
//     so the user can split the quantity manually.
//   - Ingredients not mentioned in any instruction (e.g. "salt to taste")
//     land in a final "Other ingredients" step with their full quantity.
//   - If the scrape returned no instructions, fall back to a single
//     "Imported from <host>" step containing every ingredient.
function _builderApplyParsedRecipe(parsed) {
  const b = state.builder;
  if (!b.name) b.name = parsed.name || b.name;
  if (parsed.description && !b.description) b.description = parsed.description;
  if (parsed.sourceUrl && !b.sourceUrl) b.sourceUrl = parsed.sourceUrl;

  const allIngs = (parsed.ingredients || [])
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
  if (allIngs.length === 0) {
    b.importError = 'No ingredients parsed — try a different URL.';
    return;
  }

  const instructions = (parsed.instructions || [])
    .map(s => (s || '').trim())
    .filter(Boolean);

  if (instructions.length === 0) {
    let stepTitle = 'Imported';
    try {
      stepTitle = `Imported from ${new URL(parsed.sourceUrl).hostname.replace(/^www\./, '')}`;
    } catch { /* ignore */ }
    b.steps = [{ title: stepTitle, inputFromStep: null, ingredients: allIngs }];
    return;
  }

  const steps = instructions.map(text => ({
    title: _truncateInstructionTitle(text),
    inputFromStep: null,
    ingredients: [],
    _instr: text.toLowerCase(),
  }));

  const unmatched = [];
  for (const ing of allIngs) {
    const hits = [];
    for (let si = 0; si < steps.length; si++) {
      if (_ingNameInInstruction(ing.name, steps[si]._instr)) hits.push(si);
    }
    if (hits.length === 0) {
      unmatched.push(ing);
      continue;
    }
    steps[hits[0]].ingredients.push(ing);
    for (let i = 1; i < hits.length; i++) {
      steps[hits[i]].ingredients.push({
        name: ing.name,
        amount: '',
        unit: ing.unit,
        originalText: '',
        canonicalMl: null,
        canonicalG: null,
      });
    }
  }

  for (const s of steps) {
    delete s._instr;
    if (s.ingredients.length === 0) {
      s.ingredients.push({ name: '', amount: '', unit: 'tsp' });
    }
  }

  if (unmatched.length > 0) {
    steps.push({ title: 'Other ingredients', inputFromStep: null, ingredients: unmatched });
  }

  b.steps = steps;
}

// First sentence of an instruction, capped so it fits the step-title input.
function _truncateInstructionTitle(text) {
  const trimmed = text.trim();
  const periodIdx = trimmed.indexOf('.');
  if (periodIdx > 0 && periodIdx <= 80) return trimmed.slice(0, periodIdx);
  if (trimmed.length <= 80) return trimmed;
  return trimmed.slice(0, 77) + '…';
}

// Substring match plus a single-letter plural stem so "tomatoes" matches
// "tomato" and vice versa. Cheaper and more predictable than fuzzy matching.
function _ingNameInInstruction(name, instrLower) {
  const n = (name || '').toLowerCase().trim();
  if (!n) return false;
  if (instrLower.includes(n)) return true;
  if (n.endsWith('s') && n.length > 3 && instrLower.includes(n.slice(0, -1))) return true;
  if (!n.endsWith('s') && instrLower.includes(n + 's')) return true;
  return false;
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
      itemIds: b.itemIds,
      steps: b.steps
        .filter(s => s.title.trim())
        .map(s => ({
          title: s.title.trim(),
          inputFromStep: s.inputFromStep || null,
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
    if (b.editingId) {
      await updateSauce(b.editingId, payload);
    } else {
      await createSauce(payload);
    }
    state.builder = null;
    await openSauceManager();
  } catch (err) {
    b.saving = false;
    b.error = err.message;
    render();
  }
}
