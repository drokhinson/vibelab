'use strict';

// ─── Per-Screen Validation ────────────────────────────────────────────────────
function _validateInfo(b) {
  const hasCuisine = b.cuisineDraftMode
    ? !!(b.cuisineDraftName.trim() && b.cuisineDraftEmoji.trim())
    : !!b.cuisine;
  const issues = [];
  if (!b.name.trim()) issues.push('Add a sauce name');
  if (!hasCuisine)    issues.push('Select a cuisine');
  if (!b.color)       issues.push('Pick a color');
  return issues;
}

function _validateInstructions(b) {
  const ingHasQuantity = i => i.name.trim() && (parseFloat(i.amount) > 0 || i.unit === 'to taste');
  const trayEmpty = (b.unassignedIngredients || []).length === 0;
  const untitledStepIdxs = b.steps.map((s, i) => s.title.trim() ? -1 : i).filter(i => i >= 0);
  const hasUsableStep = b.steps.some(s => s.title.trim() && s.ingredients.some(ingHasQuantity));
  const issues = [];
  if (!trayEmpty) issues.push('Move or delete every unassigned ingredient first');
  if (untitledStepIdxs.length) issues.push(`Add an action to step ${untitledStepIdxs.map(i => i + 1).join(', ')}`);
  if (!hasUsableStep) issues.push('Add at least one ingredient with a quantity to a step with an action');
  return { issues, canContinue: issues.length === 0 };
}

function _validatePairing(b) {
  const meta = SAUCE_TYPES.find(t => t.value === b.sauceType);
  if (!b.sauceType) return { issues: ['Select a type'], canContinue: false };
  if (meta && meta.category === null) return { issues: [], canContinue: true };
  if (b.itemIds.length === 0) return { issues: ['Select at least one dish'], canContinue: false };
  return { issues: [], canContinue: true };
}

// Combined validation for safety-net in builderSave()
function _builderValidate(b) {
  const infoIssues = _validateInfo(b);
  const { issues: instrIssues } = _validateInstructions(b);
  const { issues: pairIssues } = _validatePairing(b);
  const issues = [...infoIssues, ...instrIssues, ...pairIssues];
  return { issues, canContinue: issues.length === 0 };
}

// ─── Wizard Navigation Helpers ────────────────────────────────────────────────
function _builderWizardHeader(subtitle) {
  const dest = state.recipeReturnTo || 'tab-shell';
  return renderAppHeader({
    title: 'Recipe Builder',
    subtitle,
    back: { onClick: `navigate('${dest}')` },
  });
}

function _builderNextScreen() {
  const b = state.builder;
  if (b.returnToReview) { b.returnToReview = false; navigate('builder-review'); return; }
  const order = ['builder-source', 'builder-info', 'builder-instructions', 'builder-pairing', 'builder-review'];
  const idx = order.indexOf(state.screen);
  if (idx >= 0 && idx < order.length - 1) navigate(order[idx + 1]);
}

function _builderBackLink() {
  const backMap = {
    'builder-info': state.builder.editingId ? null : 'builder-source',
    'builder-instructions': 'builder-info',
    'builder-pairing': 'builder-instructions',
    'builder-review': 'builder-pairing',
  };
  const prev = backMap[state.screen];
  if (!prev) return '';
  const labels = { 'builder-source': 'Recipe Source', 'builder-info': 'Recipe Info', 'builder-instructions': 'Recipe Steps', 'builder-pairing': 'Dish Pairing' };
  return `<button class="builder-back-link" onclick="navigate('${prev}')">&larr; Back to ${labels[prev] || 'previous step'}</button>`;
}

function builderGoToStep(screen) {
  state.builder.returnToReview = true;
  navigate(screen);
}

// ─── Progress indicator HTML ──────────────────────────────────────────────────
function _wizardProgress() {
  const steps = [
    { screen: 'builder-source', label: 'Source' },
    { screen: 'builder-info', label: 'Info' },
    { screen: 'builder-instructions', label: 'Steps' },
    { screen: 'builder-pairing', label: 'Pairing' },
    { screen: 'builder-review', label: 'Review' },
  ];
  const current = state.screen;
  const currentIdx = steps.findIndex(s => s.screen === current);
  const isEditing = !!state.builder.editingId;
  return `<div class="wizard-progress">${steps.map((s, i) => {
    let cls = '';
    if (isEditing && i === 0) cls = 'skipped';
    else if (i === currentIdx) cls = 'active';
    else if (i < currentIdx) cls = 'done';
    return `<div class="wizard-dot ${cls}" title="${s.label}"><span>${i + 1}</span></div>`;
  }).join('<div class="wizard-line"></div>')}</div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1 — Recipe Source
// ═══════════════════════════════════════════════════════════════════════════════
function renderBuilderSource() {
  const b = state.builder;
  const esc = s => (s || '').replace(/"/g, '&quot;');
  const importErr = b.importError ? `<div class="builder-error">${esc(b.importError)}</div>` : '';
  const importWarn = b.importWarning ? `<div class="builder-warning">⚠️ ${esc(b.importWarning)}</div>` : '';

  return `
    ${_builderWizardHeader('How would you like to start?')}
    <div class="scroll-body scroll-body--padded">
      ${_wizardProgress()}

      <div class="source-card">
        <div class="source-card-header">
          <span class="source-card-icon">🌐</span>
          <div>
            <div class="source-card-title">Import from Recipe Website</div>
            <div class="source-card-desc">Paste a recipe URL to auto-import ingredients &amp; steps</div>
          </div>
        </div>
        <div class="builder-import-row">
          <input class="builder-input builder-import-url" type="url" placeholder="https://… (recipe page)" value="${esc(b.importUrl || '')}" data-builder-field="import-url">
          <button class="builder-secondary-btn builder-import-btn" onclick="builderImportUrl()" ${b.importing ? 'disabled' : ''}>
            ${b.importing ? '<span class="spinner-sm"></span>' : 'Import'}
          </button>
        </div>
        ${importErr}
        ${importWarn}
      </div>

      <div class="source-card source-card--disabled">
        <div class="source-card-header">
          <span class="source-card-icon">📱</span>
          <div>
            <div class="source-card-title">Import from Instagram Reel <span class="coming-soon-badge">Coming Soon</span></div>
            <div class="source-card-desc">Paste an Instagram reel link to extract the recipe</div>
          </div>
        </div>
        <div class="builder-import-row">
          <input class="builder-input" type="url" placeholder="https://instagram.com/reel/…" disabled>
          <button class="builder-secondary-btn" disabled>Import</button>
        </div>
      </div>

      <div class="source-card">
        <div class="source-card-header">
          <span class="source-card-icon">📄</span>
          <div>
            <div class="source-card-title">Import from File</div>
            <div class="source-card-desc">Upload a JSON file matching the SauceBoss import format</div>
          </div>
        </div>
        <div class="builder-import-row">
          <input type="file" accept=".json" id="builder-file-input" class="builder-file-input" onchange="builderImportFile(this)">
          <label for="builder-file-input" class="builder-secondary-btn builder-file-label">Choose File</label>
        </div>
        <a class="builder-download-link" href="assets/sb-ai-recipe-instructions.md" download="SauceBoss-AI-Recipe-Instructions.md">⬇ Download AI recipe builder instructions</a>
      </div>

      <div class="source-card source-card--action" onclick="builderStartManual()">
        <div class="source-card-header">
          <span class="source-card-icon">✍️</span>
          <div>
            <div class="source-card-title">Manual Entry</div>
            <div class="source-card-desc">Enter all sauce information by hand</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2 — Recipe Info
// ═══════════════════════════════════════════════════════════════════════════════
function renderBuilderInfo() {
  const b = state.builder;
  const esc = s => (s || '').replace(/"/g, '&quot;');

  const cuisineChips = availableCuisines().map(c =>
    `<button class="builder-chip ${!b.cuisineDraftMode && b.cuisine === c.name ? 'selected' : ''}" onclick="builderSetCuisine('${c.name.replace(/'/g, "\\'")}','${c.emoji}')">${renderEmoji(c.emoji)} ${c.name}</button>`
  ).join('');
  const newCuisineBtn = `<div class="cuisine-add-row"><button class="builder-chip ${b.cuisineDraftMode ? 'selected' : ''}" onclick="builderStartNewCuisine()">+ New cuisine…</button></div>`;

  const newCuisineInputs = b.cuisineDraftMode ? `
    <div class="new-cuisine-row">
      <input class="builder-input new-cuisine-name" placeholder="Cuisine name (e.g. Thai)"
             value="${esc(b.cuisineDraftName)}" data-builder-field="cuisine-draft-name">
      <input class="builder-input new-cuisine-emoji" placeholder="🌮" maxlength="4"
             value="${esc(b.cuisineDraftEmoji)}" data-builder-field="cuisine-draft-emoji">
      <button class="new-cuisine-cancel" onclick="builderCancelNewCuisine()">Cancel</button>
    </div>` : '';

  const colorDots = COLOR_SWATCHES.map(hex =>
    `<button class="color-swatch ${b.color === hex ? 'selected' : ''}" style="background:${hex}" onclick="builderSetColor('${hex}')"></button>`
  ).join('');

  const sourceUrlHTML = (b.recipeSource === 'url' || b.recipeSource === 'reel') && b.sourceUrl
    ? `<p class="builder-label">Source</p><div class="builder-readonly-url">${esc(b.sourceUrl)}</div>` : '';

  const issues = _validateInfo(b);
  const canContinue = issues.length === 0;

  const validationHTML = issues.length > 0 ? `
    <div class="builder-validation-card">
      <div class="builder-validation-header"><span class="builder-validation-title">⚠ Complete these to continue</span></div>
      <ul class="builder-validation-list">${issues.map(msg => `<li>${esc(msg)}</li>`).join('')}</ul>
    </div>` : '';

  const infoWarn = b.importWarning ? `<div class="builder-warning">⚠️ ${esc(b.importWarning)}</div>` : '';

  return `
    ${_builderWizardHeader('Name, describe & style your recipe')}
    <div class="scroll-body scroll-body--padded">
      ${_wizardProgress()}
      ${infoWarn}
      ${sourceUrlHTML}
      <p class="builder-label">Sauce Name</p>
      <input class="builder-input builder-name-input" placeholder="Sauce name" value="${esc(b.name)}" data-builder-field="name">
      <p class="builder-label">Description</p>
      <textarea class="builder-input builder-description-input" placeholder="Description (optional)" data-builder-field="description">${esc(b.description || '')}</textarea>
      <p class="builder-label">Cuisine</p>
      <div class="cuisine-grid">${cuisineChips}</div>
      ${newCuisineBtn}
      ${newCuisineInputs}
      <p class="builder-label">Color</p>
      <div class="color-swatches">${colorDots}</div>
      ${validationHTML}
      <button class="builder-primary-btn" onclick="_builderNextScreen()" ${canContinue ? '' : 'disabled'}>Continue — Recipe Steps</button>
      ${_builderBackLink()}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3 — Recipe Instructions (Step Builder)
// ═══════════════════════════════════════════════════════════════════════════════
function renderBuilderInstructions() {
  const b = state.builder;
  const esc = s => (s || '').replace(/"/g, '&quot;');

  // ── Unassigned ingredients (at top for imports) ──
  const unassignedHTML = (b.unassignedIngredients && b.unassignedIngredients.length > 0) ? `
    <div class="builder-unassigned-card">
      <div class="builder-unassigned-header">
        <span class="builder-unassigned-title">⚠ Unassigned ingredients (${b.unassignedIngredients.length})</span>
        <span class="builder-unassigned-hint">Move each to a step or delete before continuing.</span>
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

  // ── Steps with insert-between dividers ──
  const stepsHTML = b.steps.map((step, si) => {
    const insertBefore = si > 0 ? `
      <button class="insert-step-divider" onclick="builderInsertStep(${si})" title="Insert step here">
        <span class="insert-step-line"></span><span class="insert-step-plus">+</span><span class="insert-step-line"></span>
      </button>` : '';

    const stepRefHTML = si > 0 ? `
      <div class="step-ref-row">
        <label class="step-ref-label">Combine output from:</label>
        <div class="multi-step-select" data-step="${si}">
          <button class="multi-step-trigger" onclick="builderToggleStepSelect(${si})">
            ${(step.inputFromSteps || []).length > 0
              ? (step.inputFromSteps || []).map(r => `Step ${r}${b.steps[r - 1]?.title ? ' — ' + b.steps[r - 1].title.slice(0, 20) : ''}`).join(', ')
              : 'None — independent step'}
          </button>
          ${b._stepSelectOpen === si ? `<div class="multi-step-panel">
            ${b.steps.slice(0, si).map((_, ri) => {
              const refOrder = ri + 1;
              const checked = (step.inputFromSteps || []).includes(refOrder);
              const label = `Step ${refOrder}${b.steps[ri].title ? ' — ' + b.steps[ri].title.slice(0, 25) : ''}`;
              return `<label class="multi-step-option ${checked ? 'checked' : ''}">
                <input type="checkbox" ${checked ? 'checked' : ''} onchange="builderToggleInputStep(${si}, ${refOrder})">
                <span>${label}</span>
              </label>`;
            }).join('')}
          </div>` : ''}
        </div>
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
    const instrExpanded = b._instructionsExpanded && b._instructionsExpanded.has(si);
    const hasInstr = !!(step.instructions && step.instructions.trim());
    return `${insertBefore}<div class="builder-step-card">
      ${b.steps.length > 1 ? `<button class="remove-step-btn" onclick="builderRemoveStep(${si})">✕</button>` : ''}
      <div class="step-number">Step ${si + 1}</div>
      ${stepRefHTML}
      <div class="builder-step-headline">
        <input class="builder-input builder-step-title" placeholder="Step action (e.g., Sauté the base)" value="${esc(step.title)}" data-builder-field="step-title" data-step="${si}">
        <label class="builder-step-time">
          <input class="builder-input builder-step-time-input" type="number" min="0" max="600" inputmode="numeric"
                 placeholder="5" value="${esc(String(timeValue))}"
                 data-builder-field="step-time" data-step="${si}">
          <span class="builder-step-time-suffix">min</span>
        </label>
        <button class="builder-instructions-toggle ${instrExpanded ? 'expanded' : ''} ${hasInstr ? 'has-content' : ''}" onclick="builderToggleInstructions(${si})" title="Detailed instructions">
          <i data-lucide="notebook-pen"></i>
        </button>
      </div>
      ${instrExpanded ? `<textarea class="builder-input builder-step-instructions" placeholder="Detailed Instructions (optional)" data-builder-field="step-instructions" data-step="${si}">${esc(step.instructions || '')}</textarea>` : ''}
      <div class="builder-ings-list">${ingsHTML}</div>
      <button class="add-ing-btn" onclick="builderAddIngredient(${si})">+ Ingredient</button>
    </div>`;
  }).join('');

  const { issues, canContinue } = _validateInstructions(b);
  const validationHTML = issues.length > 0 ? `
    <div class="builder-validation-card">
      <div class="builder-validation-header"><span class="builder-validation-title">⚠ Finish these before continuing</span></div>
      <ul class="builder-validation-list">${issues.map(msg => `<li>${esc(msg)}</li>`).join('')}</ul>
    </div>` : '';

  return `
    ${_builderWizardHeader('Build your recipe steps')}
    <div class="scroll-body scroll-body--padded">
      ${_wizardProgress()}
      ${unassignedHTML}
      <p class="builder-label">Scale</p>
      <div class="recipe-controls">
        <div class="servings-control">
          <button onclick="builderSetServings(state.builder.servings - 1)" class="serving-btn" ${b.servings <= 1 ? 'disabled' : ''}>−</button>
          <span class="servings-label">${b.servings} ${b.servings === 1 ? 'serving' : 'servings'}</span>
          <button onclick="builderSetServings(state.builder.servings + 1)" class="serving-btn" ${b.servings >= 12 ? 'disabled' : ''}>+</button>
        </div>
      </div>
      <p class="builder-label">Steps</p>
      ${stepsHTML}
      <button class="insert-step-divider" onclick="builderAddStep()" title="Add step">
        <span class="insert-step-line"></span><span class="insert-step-plus">+</span><span class="insert-step-line"></span>
      </button>
      ${validationHTML}
      <button class="builder-primary-btn" onclick="_builderNextScreen()" ${canContinue ? '' : 'disabled'}>Continue — Dish Pairing</button>
      ${_builderBackLink()}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4 — Dish Pairing
// ═══════════════════════════════════════════════════════════════════════════════
function _builderItemPool() {
  const t = SAUCE_TYPES.find(x => x.value === state.builder.sauceType);
  if (!t) return [];
  if (t.category === 'carb')    return state.carbs;
  if (t.category === 'protein') return state.proteins;
  if (t.category === 'salad')   return state.saladBases;
  return [];
}

function _allVariantIds(dish) {
  return (dish.variants || dish.subtypes || []).map(v => v.id);
}

function renderBuilderPairing() {
  const b = state.builder;
  const esc = s => (s || '').replace(/"/g, '&quot;');

  // Lazy-load dish lists on first visit to pairing step
  if (!state.carbs.length && !state.proteins.length && !state.saladBases.length) {
    ensureItemLists().then(() => render());
  }

  const sauceTypeChips = SAUCE_TYPES.map(t =>
    `<button class="builder-chip builder-chip-lg ${b.sauceType === t.value ? 'selected' : ''}" onclick="builderSetSauceType('${t.value}')">${t.label}</button>`
  ).join('');

  const meta = SAUCE_TYPES.find(t => t.value === b.sauceType);
  const isStandalone = meta && meta.category === null;

  let treeHTML = '';
  if (!b.sauceType) {
    treeHTML = '<p class="builder-hint">Select a type above to see dish pairings.</p>';
  } else if (isStandalone) {
    treeHTML = '<div class="builder-hint standalone-hint">🍽️ Full Recipe — standalone, no dish pairing needed.</div>';
  } else {
    const pool = _builderItemPool();
    treeHTML = `<div class="dish-tree">${pool.map(dish => {
      const variants = dish.variants || dish.subtypes || [];
      const variantIds = variants.map(v => v.id);
      const allSelected = variantIds.length > 0 && variantIds.every(id => b.itemIds.includes(id));
      const someSelected = variantIds.some(id => b.itemIds.includes(id));
      const dishSelected = b.itemIds.includes(dish.id);
      const isExpanded = b._expandedDishes && b._expandedDishes.has(dish.id);

      const checkState = dishSelected || allSelected ? 'checked' : (someSelected ? 'partial' : '');
      const hasChildren = variants.length > 0;

      const variantsHTML = hasChildren && isExpanded ? `
        <div class="dish-tree-children">
          ${variants.map(v => {
            const vSel = b.itemIds.includes(v.id);
            return `<div class="dish-tree-item dish-tree-child ${vSel ? 'selected' : ''}" onclick="builderToggleItem('${v.id}')">
              <span class="dish-tree-check ${vSel ? 'checked' : ''}"></span>
              <span class="dish-tree-emoji">${v.emoji || ''}</span>
              <span class="dish-tree-name">${esc(v.name)}</span>
            </div>`;
          }).join('')}
        </div>` : '';

      return `<div class="dish-tree-group">
        <div class="dish-tree-item dish-tree-parent ${dishSelected || allSelected ? 'selected' : ''}">
          ${hasChildren ? `<button class="dish-tree-toggle ${isExpanded ? 'expanded' : ''}" onclick="builderToggleDishExpand('${dish.id}')">▶</button>` : '<span class="dish-tree-toggle-spacer"></span>'}
          <span class="dish-tree-check ${checkState}" onclick="builderToggleDishParent('${dish.id}')"></span>
          <span class="dish-tree-emoji">${dish.emoji || ''}</span>
          <span class="dish-tree-name" onclick="builderToggleDishParent('${dish.id}')">${esc(dish.name)}</span>
          ${hasChildren ? `<span class="dish-tree-count">${variants.length}</span>` : ''}
        </div>
        ${variantsHTML}
      </div>`;
    }).join('')}</div>`;
  }

  const { canContinue } = _validatePairing(b);

  return `
    ${_builderWizardHeader('What does this pair with?')}
    <div class="scroll-body scroll-body--padded">
      ${_wizardProgress()}
      <p class="builder-label">Type</p>
      <div class="builder-chip-row">${sauceTypeChips}</div>
      ${treeHTML}
      <button class="builder-primary-btn" onclick="_builderNextScreen()" ${canContinue ? '' : 'disabled'}>Continue — Review</button>
      ${_builderBackLink()}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5 — Review
// ═══════════════════════════════════════════════════════════════════════════════
function renderBuilderReview() {
  const b = state.builder;
  b.returnToReview = false;
  const esc = s => (s || '').replace(/"/g, '&quot;');
  const meta = SAUCE_TYPES.find(t => t.value === b.sauceType);
  const isStandalone = !!meta && meta.category === null;
  const pool = isStandalone ? [] : _builderItemPool();
  const pairedItems = pool.flatMap(d => {
    const matched = [];
    if (b.itemIds.includes(d.id)) matched.push(d);
    (d.variants || d.subtypes || []).forEach(v => { if (b.itemIds.includes(v.id)) matched.push(v); });
    return matched;
  });
  const totalIngs = b.steps.reduce((sum, s) => sum + s.ingredients.filter(i => i.name.trim()).length, 0);

  const sourceLabel = { url: '🌐 Imported from website', reel: '📱 Imported from reel', file: '📄 Imported from file', manual: '✍️ Manual entry' }[b.recipeSource] || 'Not set';

  return `
    ${_builderWizardHeader('Review & save your recipe')}
    <div class="scroll-body scroll-body--padded">
      ${_wizardProgress()}

      <div class="review-info-bubble">
        <span>${sourceLabel}</span>
        ${b.sourceUrl ? `<span class="review-info-url">${esc(b.sourceUrl)}</span>` : ''}
      </div>

      <div class="review-info-card">
        <span class="review-edit-btn review-info-card-edit" onclick="builderGoToStep('builder-info')">Edit</span>
        <div class="review-info-card-header">
          <span class="color-dot-inline" style="background:${b.color}"></span>
          <span class="review-info-name">${esc(b.name)}</span>
          <span class="review-info-cuisine">${renderEmoji(b.cuisineEmoji)} ${esc(b.cuisine)}</span>
        </div>
        ${b.description ? `<div class="review-info-desc">${esc(b.description)}</div>` : ''}
      </div>

      <div class="review-accordion">
        <button class="review-accordion-header" onclick="toggleReviewSection(this)">
          <span class="review-accordion-chevron">▶</span>
          <span>Recipe Steps</span>
          <span class="review-accordion-summary">${b.steps.length} step${b.steps.length !== 1 ? 's' : ''} · ${totalIngs} ingredients</span>
          <span class="review-edit-btn" onclick="event.stopPropagation(); builderGoToStep('builder-instructions')">Edit</span>
        </button>
        <div class="review-accordion-body" hidden>
          ${b.steps.map((step, si) => `
            <div class="review-step-card">
              <div class="step-number">Step ${si + 1}</div>
              <div class="step-title">${esc(step.title) || '(untitled)'}</div>
              ${step.instructions ? `<div class="review-step-instructions">${esc(step.instructions)}</div>` : ''}
              ${(step.inputFromSteps || []).length > 0 ? `<div class="step-ref-badge">⤶ Combines ${(step.inputFromSteps || []).map(r => 'Step ' + r).join(', ')} output</div>` : ''}
              <div class="review-ing-list">
                ${step.ingredients.filter(i => i.name.trim()).map(i =>
                  `<div class="review-ing-item">${i.unit === 'to taste' ? 'to taste' : `${i.amount} ${i.unit}`} ${i.name}</div>`
                ).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="review-accordion">
        <button class="review-accordion-header" onclick="toggleReviewSection(this)">
          <span class="review-accordion-chevron">▶</span>
          <span>Dish Pairing</span>
          <span class="review-accordion-summary">${meta?.label || b.sauceType}${isStandalone ? '' : ' · ' + (pairedItems.map(c => c.emoji + ' ' + c.name).join(', ') || 'None')}</span>
          <span class="review-edit-btn" onclick="event.stopPropagation(); builderGoToStep('builder-pairing')">Edit</span>
        </button>
        <div class="review-accordion-body" hidden>
          <div class="review-field"><strong>Type:</strong> ${meta?.label || b.sauceType}</div>
          ${isStandalone
            ? '<div class="review-field">Standalone recipe — no dish pairing</div>'
            : `<div class="review-field"><strong>Pairs with:</strong> ${pairedItems.map(c => c.emoji + ' ' + c.name).join(', ') || 'None'}</div>`}
        </div>
      </div>

      ${b.error ? `<div class="builder-error">${esc(b.error)}</div>` : ''}
      <button class="builder-primary-btn" onclick="builderSave()" ${b.saving ? 'disabled' : ''}>
        ${b.saving ? '<span class="spinner-sm"></span> Saving…' : (b.editingId ? 'Save Changes' : 'Save Sauce')}
      </button>
      <button class="builder-back-link" onclick="builderDiscard()">Discard</button>
    </div>
  `;
}

function builderDiscard() {
  state.builder = null;
  navigate(state.recipeReturnTo || 'tab-shell');
}

function toggleReviewSection(btn) {
  const body = btn.nextElementSibling;
  const chevron = btn.querySelector('.review-accordion-chevron');
  const isHidden = body.hidden;
  body.hidden = !isHidden;
  chevron.classList.toggle('expanded', isHidden);
}

// ─── Builder Actions ──────────────────────────────────────────────────────────
async function openBuilder() {
  if (!currentUser) { openAuthModal(); return; }
  state.builder = defaultBuilder();
  state.builder._expandedDishes = new Set();
  state.builder._instructionsExpanded = new Set();
  state.recipeReturnTo = state.screen === 'admin' ? 'admin' : 'tab-shell';
  navigate('builder-source');
  if (!_hasBuilderRefData()) {
    await withInlineLoader(ensureBuilderRefData());
  }
}

function builderStartManual() {
  state.builder.recipeSource = 'manual';
  navigate('builder-info');
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

function builderSetServings(n) {
  state.builder.servings = Math.max(1, Math.min(12, n));
  render();
}

function builderSetColor(hex) {
  state.builder.color = hex;
  render();
}

function builderAddStep() {
  state.builder.steps.push({ title: '', instructions: '', inputFromSteps: [], estimatedTime: null, ingredients: [{ name: '', amount: '', unit: 'tsp' }] });
  render();
}

function builderInsertStep(atIndex) {
  const b = state.builder;
  const newStep = { title: '', instructions: '', inputFromSteps: [], estimatedTime: null, ingredients: [{ name: '', amount: '', unit: 'tsp' }] };
  b.steps.splice(atIndex, 0, newStep);
  // Renumber inputFromSteps references: anything pointing at or after atIndex shifts up by 1
  for (let i = 0; i < b.steps.length; i++) {
    if (i === atIndex) continue;
    b.steps[i].inputFromSteps = (b.steps[i].inputFromSteps || []).map(ref => ref > atIndex ? ref + 1 : ref);
  }
  render();
}

function builderRemoveStep(si) {
  const removedOrder = si + 1;
  state.builder.steps.splice(si, 1);
  for (const step of state.builder.steps) {
    step.inputFromSteps = (step.inputFromSteps || [])
      .filter(ref => ref !== removedOrder)
      .map(ref => ref > removedOrder ? ref - 1 : ref);
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

function builderToggleInstructions(si) {
  const b = state.builder;
  if (!b._instructionsExpanded) b._instructionsExpanded = new Set();
  if (b._instructionsExpanded.has(si)) b._instructionsExpanded.delete(si);
  else b._instructionsExpanded.add(si);
  render();
}

function builderToggleStepSelect(si) {
  const b = state.builder;
  b._stepSelectOpen = b._stepSelectOpen === si ? null : si;
  render();
}

function builderToggleInputStep(si, refOrder) {
  const b = state.builder;
  const arr = b.steps[si].inputFromSteps || [];
  const idx = arr.indexOf(refOrder);
  if (idx >= 0) arr.splice(idx, 1);
  else arr.push(refOrder);
  arr.sort((a, c) => a - c);
  b.steps[si].inputFromSteps = arr;
  render();
}

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
  state.builder.itemIds = [];
  render();
}

function builderToggleItem(id) {
  const idx = state.builder.itemIds.indexOf(id);
  if (idx >= 0) state.builder.itemIds.splice(idx, 1);
  else state.builder.itemIds.push(id);
  render();
}

function builderToggleDishExpand(dishId) {
  const b = state.builder;
  if (!b._expandedDishes) b._expandedDishes = new Set();
  if (b._expandedDishes.has(dishId)) b._expandedDishes.delete(dishId);
  else b._expandedDishes.add(dishId);
  render();
}

function builderToggleDishParent(dishId) {
  const b = state.builder;
  const pool = _builderItemPool();
  const dish = pool.find(d => d.id === dishId);
  if (!dish) return;
  const variants = dish.variants || dish.subtypes || [];
  if (variants.length === 0) {
    // Leaf dish — simple toggle
    builderToggleItem(dishId);
    return;
  }
  const variantIds = variants.map(v => v.id);
  const allSelected = variantIds.every(id => b.itemIds.includes(id));
  if (allSelected) {
    // Deselect all variants
    b.itemIds = b.itemIds.filter(id => !variantIds.includes(id) && id !== dishId);
  } else {
    // Select all variants
    for (const vid of variantIds) {
      if (!b.itemIds.includes(vid)) b.itemIds.push(vid);
    }
    // Also include parent dish id
    if (!b.itemIds.includes(dishId)) b.itemIds.push(dishId);
  }
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
      if ((prev === 'to taste') !== (el.value === 'to taste')) needsRender = true;
      break;
    }
    case 'unassigned-target': {
      if (el.value === '') break;
      const uidx = parseInt(el.dataset.uidx);
      const targetSi = parseInt(el.value);
      builderMoveUnassignedToStep(uidx, targetSi);
      return;
    }
  }
  if (needsRender) {
    render();
    return;
  }
  _builderRefreshValidation();
}

function _builderRefreshValidation() {
  const screen = state.screen;
  const b = state.builder;
  let issues = [];
  let canContinue = false;

  if (screen === 'builder-info') {
    issues = _validateInfo(b);
    canContinue = issues.length === 0;
  } else if (screen === 'builder-instructions') {
    const result = _validateInstructions(b);
    issues = result.issues;
    canContinue = result.canContinue;
  } else if (screen === 'builder-pairing') {
    const result = _validatePairing(b);
    issues = result.issues;
    canContinue = result.canContinue;
  } else {
    return;
  }

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
  classifyIngredientLocal(ing.name, category);
  ing._showCategory = false;
  const wrap = document.querySelector(`.ingredient-row-wrap:has([data-step="${si}"][data-ing="${ii}"].ing-name)`);
  if (wrap) {
    const classify = wrap.querySelector('.category-classify');
    if (classify) classify.remove();
  }
}

// ─── Import-from-URL ──────────────────────────────────────────────────────────
async function builderImportUrl() {
  const b = state.builder;
  const url = (b.importUrl || '').trim();
  if (!url) {
    b.importError = 'Paste a recipe URL first.';
    render();
    return;
  }
  b.importing = true;
  b.importError = null;
  b.importWarning = null;
  render();
  try {
    const parsed = await importRecipeFromUrl(url);
    _builderApplyParsedRecipe(parsed);
    b.importing = false;
    if (parsed.warning) {
      b.importWarning = parsed.warning;
    }
    if (b.importError) {
      render();
      return;
    }
    b.recipeSource = 'url';
    navigate('builder-info');
  } catch (err) {
    b.importing = false;
    b.importError = err.message || 'Import failed.';
    render();
  }
}

// Keep legacy name as alias for any external callers
const builderImport = builderImportUrl;

// ─── Import-from-File ─────────────────────────────────────────────────────────
function builderImportFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const b = state.builder;
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON structure');
      if (!Array.isArray(parsed.ingredients) || !Array.isArray(parsed.instructions)) {
        throw new Error('JSON must contain "ingredients" and "instructions" arrays');
      }
      _builderApplyParsedRecipe(parsed);
      if (b.importError) {
        render();
        return;
      }
      b.recipeSource = 'file';
      b.importError = null;
      navigate('builder-info');
    } catch (err) {
      b.importError = err.message || 'Failed to parse file.';
      render();
    }
  };
  reader.onerror = function () {
    b.importError = 'Failed to read file.';
    render();
  };
  reader.readAsText(file);
}

function _builderApplyParsedRecipe(parsed) {
  const b = state.builder;
  // Backend returns `ingredientRaw`; normalise to `foodRaw` for shared builder
  for (const ing of (parsed?.ingredients || [])) {
    if (ing.ingredientRaw && !ing.foodRaw) ing.foodRaw = ing.ingredientRaw;
  }
  const hasIngs = (parsed?.ingredients || []).some((p) => (p?.foodRaw || '').trim());
  if (!hasIngs) {
    b.unassignedIngredients = [];
    b.importError = 'No ingredients parsed — try a different source.';
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
  if (!b.name.trim()) { b.error = 'Sauce name is required.'; render(); return; }
  if (!b.sauceType)   { b.error = 'Select a type before saving.'; render(); return; }
  if (!b.color)        { b.error = 'Pick a color before saving.'; render(); return; }
  if (b.steps.some(s => !s.title.trim())) { b.error = 'Every step needs an action.'; render(); return; }
  if (b.cuisineDraftMode) {
    const draftName = (b.cuisineDraftName || '').trim();
    const draftEmoji = (b.cuisineDraftEmoji || '').trim();
    if (!draftName || !draftEmoji) { b.error = 'New cuisine needs a name and emoji.'; render(); return; }
    b.cuisine = draftName;
    b.cuisineEmoji = draftEmoji;
    b.cuisineDraftMode = false;
  }
  if (!b.cuisine) { b.error = 'Select a cuisine before saving.'; render(); return; }
  if (b.editingId && !confirm('You are about to overwrite this recipe. Continue?')) return;
  b.saving = true;
  b.error = null;
  render();
  try {
    const typeMeta = SAUCE_TYPES.find(t => t.value === b.sauceType);
    const isStandalone = !!typeMeta && typeMeta.category === null;
    const payload = {
      name: b.name.trim(),
      cuisine: b.cuisine,
      cuisineEmoji: b.cuisineEmoji,
      color: b.color,
      description: b.description || '',
      sourceUrl: (b.sourceUrl || '').trim() || null,
      defaultServings: b.servings || 2,
      sauceType: b.sauceType,
      parentSauceId: b.parentSauceId || null,
      itemIds: isStandalone ? [] : b.itemIds,
      attachments: isStandalone ? [] : undefined,
      steps: b.steps
        .map(s => ({
          title: s.title.trim(),
          instructions: (s.instructions || '').trim() || null,
          inputFromStep: (s.inputFromSteps || [])[0] || null,
          inputFromSteps: s.inputFromSteps || [],
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
    } else {
      result = await createSauce(payload);
    }
    await refreshSaucebookAndPantry();
    state.builder = null;
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
