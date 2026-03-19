'use strict';

// ─── Progress bar (rendered by helpers.js after app-header) ───────────────────

function renderProgressBar() {
  const steps = state.mealFlowSteps;
  const current = state.mealFlowIndex;
  const labels = {
    protein: '🔥 Protein',
    carb:    '🍝 Carb',
    addons:  '🧩 Add-ons',
    salad:   '🥗 Salad',
  };

  // Ordered sub-screens for each step type (first = root selector, rest = sub-steps)
  function getScreensForStep(step) {
    if (step === 'protein') return ['protein-selector', 'marinade-selector'];
    if (step === 'carb') {
      return state.preparations.length > 0
        ? ['carb-selector', 'prep-selector', 'sauce-selector']
        : ['carb-selector', 'sauce-selector'];
    }
    if (step === 'salad') return ['salad-base-selector', 'dressing-selector'];
    return ['protein-veggie-selector']; // addons: single screen
  }

  const nodes = [...steps, 'review'];
  let html = '';

  nodes.forEach((step, i) => {
    const isReview = step === 'review';
    const stepDone   = i < current || (isReview && current >= steps.length);
    const stepActive = (!isReview && i === current) || (isReview && current >= steps.length);
    const lineClass  = i > 0 && (i <= current || (isReview && current >= steps.length)) ? 'done' : '';
    const label      = isReview ? '✅ Review' : labels[step];
    const clickable  = !isReview && (stepDone || stepActive);
    const onclick    = clickable ? ` onclick="goToFlowStep(${i})"` : '';
    const cursorClass = clickable ? ' clickable' : '';

    // Determine big dot state and content, accounting for sub-screen position
    let dotClass = stepDone ? 'done' : stepActive ? 'active' : '';
    let dotContent = stepDone ? '<i data-lucide="check"></i>' : String(i + 1);
    let subDotsHTML = '';

    if (!isReview) {
      const screens = getScreensForStep(step);
      const subScreens = screens.slice(1); // screens after the root selector

      if (subScreens.length > 0) {
        // When active, check which sub-screen we're currently on
        const curScreenIdx = stepActive ? screens.indexOf(state.screen) : -1;

        // If on a sub-screen (not the root), the big dot flips to done
        if (stepActive && curScreenIdx > 0) {
          dotClass = 'done';
          dotContent = '<i data-lucide="check"></i>';
        }

        const subDots = subScreens.map((_, si) => {
          const screenIdx = si + 1; // index in screens[] (0 = root)
          let sdClass = '';
          if (stepDone || (stepActive && screenIdx < curScreenIdx)) sdClass = 'done';
          else if (stepActive && screenIdx === curScreenIdx) sdClass = 'active';
          const sdLineClass = sdClass === 'done' ? 'done' : '';
          return `<div class="progress-sub-line ${sdLineClass}"></div><div class="progress-sub-dot ${sdClass}"></div>`;
        }).join('');

        subDotsHTML = `<div class="sub-step-dots">${subDots}</div>`;
      }
    }

    const lineHTML = i > 0 ? `<div class="progress-line ${lineClass}"></div>` : '';
    html += `${lineHTML}<div class="step-group">
      <div class="progress-node${cursorClass}"${onclick}>
        <div class="progress-dot ${dotClass}">${dotContent}</div>
        <div class="progress-label">${label}</div>
      </div>${subDotsHTML}
    </div>`;
  });

  return `<div class="flow-progress">${html}</div>`;
}

// ─── Go back to a previous flow step (for editing) ───────────────────────────

function goToFlowStep(index) {
  if (index < 0 || index >= state.mealFlowSteps.length) return;
  // Remember where to return after re-editing this step
  if (state.mealFlowIndex > index) {
    state.mealFlowReturnIndex = state.mealFlowIndex;
  }
  navigateToFlowStep(index);
}

// ─── Meal Builder home screen (option selector) ───────────────────────────────

function renderMealBuilder() {
  const opts = state.mealOptions;
  const anySelected = Object.values(opts).some(v => v);

  const optionCard = (key, emoji, label, hint) => {
    const on = opts[key];
    return `
      <button class="meal-option-card ${on ? 'selected' : ''}" onclick="toggleMealOption('${key}')">
        <span class="meal-option-icon">${emoji}</span>
        <div class="meal-option-info">
          <div class="meal-option-label">${label}</div>
          <div class="meal-option-hint">${hint}</div>
        </div>
        <span class="meal-option-check">
          ${on
            ? '<i data-lucide="check-circle-2"></i>'
            : '<i data-lucide="circle"></i>'}
        </span>
      </button>`;
  };

  const heroSVG = `
    <div class="hero-illustration">
      <svg width="180" height="140" viewBox="0 0 180 140" fill="none" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="90" cy="130" rx="62" ry="8" fill="#1A1A2E" opacity="0.06"/>
        <path d="M28 68 Q28 112 90 112 Q152 112 152 68 Z" fill="#FFF3E6"/>
        <rect x="20" y="60" width="140" height="14" rx="7" fill="#E85D04"/>
        <path d="M28 68 Q28 112 90 112 Q152 112 152 68" stroke="#C94E02" stroke-width="2" fill="none"/>
        <ellipse cx="90" cy="96" rx="40" ry="10" fill="#E85D04" opacity="0.1"/>
        <circle cx="70" cy="91" r="9" fill="#E85D04" opacity="0.85"/>
        <circle cx="93" cy="84" r="7" fill="#F48C06" opacity="0.9"/>
        <circle cx="114" cy="93" r="8" fill="#C94E02" opacity="0.85"/>
        <circle cx="82" cy="103" r="5" fill="#FAA307" opacity="0.9"/>
        <path d="M58 76 Q72 62 88 76 Q104 90 118 74" stroke="#E85D04" stroke-width="2.5" stroke-linecap="round" fill="none" opacity="0.5"/>
        <path d="M62 56 Q66 44 62 34 Q58 24 62 14" stroke="#D1D5DB" stroke-width="2.5" stroke-linecap="round" fill="none"/>
        <path d="M90 53 Q94 41 90 31 Q86 21 90 11" stroke="#D1D5DB" stroke-width="2.5" stroke-linecap="round" fill="none"/>
        <path d="M118 56 Q122 44 118 34 Q114 24 118 14" stroke="#D1D5DB" stroke-width="2.5" stroke-linecap="round" fill="none"/>
      </svg>
    </div>`;

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <div class="logo"><span>🍲</span>SauceBoss</div>
      <div class="subtitle">Build your perfect meal</div>
      <button class="settings-btn" onclick="openSauceManager()" title="Sauce manager"><i data-lucide="settings-2"></i></button>
    </div>
    <div class="scroll-body">
      ${heroSVG}
      <p class="section-label">What's on tonight's menu?</p>
      <div class="meal-options-list">
        ${optionCard('protein', '🔥', 'Protein &amp; Marinade', 'Chicken, beef, tofu, fish')}
        ${optionCard('carb',    '🍝', 'Carb &amp; Sauce',       'Pasta, rice, noodles, bread')}
        ${optionCard('salad',   '🥗', 'Salad &amp; Dressing',   'Romaine, spinach, arugula')}
        ${optionCard('addons',  '🧩', 'Add-ons',                'Extra proteins &amp; veggies')}
      </div>
      ${anySelected
        ? `<button class="cook-btn" onclick="buildMealFlow()">
             <i data-lucide="chef-hat"></i> Build Menu
           </button>`
        : `<p class="meal-hint">Select at least one option to get started</p>`
      }
    </div>
  `;
}

// ─── Meal option toggle ────────────────────────────────────────────────────────

function toggleMealOption(key) {
  state.mealOptions[key] = !state.mealOptions[key];
  const on = state.mealOptions[key];

  // Update the tapped card in-place (no full re-render = no blink)
  const card = document.querySelector(`.meal-option-card[onclick="toggleMealOption('${key}')"]`);
  if (card) {
    card.classList.toggle('selected', on);
    const check = card.querySelector('.meal-option-check');
    if (check) check.innerHTML = on
      ? '<i data-lucide="check-circle-2"></i>'
      : '<i data-lucide="circle"></i>';
    _initIcons();
  }

  // Show/hide Build Menu button vs hint text
  const anySelected = Object.values(state.mealOptions).some(v => v);
  const scrollBody = document.querySelector('.scroll-body');
  if (scrollBody) {
    let footer = scrollBody.querySelector('.cook-btn, .meal-hint');
    if (anySelected) {
      if (!footer || footer.classList.contains('meal-hint')) {
        if (footer) footer.remove();
        const btn = document.createElement('button');
        btn.className = 'cook-btn';
        btn.setAttribute('onclick', 'buildMealFlow()');
        btn.innerHTML = '<i data-lucide="chef-hat"></i> Build Menu';
        scrollBody.appendChild(btn);
        _initIcons();
      }
    } else {
      if (!footer || footer.classList.contains('cook-btn')) {
        if (footer) footer.remove();
        const hint = document.createElement('p');
        hint.className = 'meal-hint';
        hint.textContent = 'Select at least one option to get started';
        scrollBody.appendChild(hint);
      }
    }
  }
}

// ─── Guided flow: start ───────────────────────────────────────────────────────

function buildMealFlow() {
  const steps = [];
  if (state.mealOptions.protein) steps.push('protein');
  if (state.mealOptions.carb)    steps.push('carb');
  if (state.mealOptions.addons)  steps.push('addons');
  if (state.mealOptions.salad)   steps.push('salad');
  if (steps.length === 0) return;

  state.mealFlowSteps = steps;
  state.mealFlowIndex = 0;
  // Reset selections for a fresh flow
  state.meal = {
    protein: null, marinade: null,
    carb: null, prep: null, sauce: null,
    saladBase: null, dressing: null,
  };
  state.selectedAddons = [];
  navigateToFlowStep(0);
}

// ─── Guided flow: navigate to a specific step ─────────────────────────────────

async function navigateToFlowStep(index) {
  const step = state.mealFlowSteps[index];
  state.mealFlowIndex = index;
  state.mealStep = step === 'addons' ? null : step;
  state.disabledIngredients = new Set();
  state.filterOpen = false;
  state.expandedCuisines = new Set();

  if (step === 'protein') {
    if (state.proteins.length === 0) {
      state.loading = 'Loading proteins…';
      navigate('protein-selector');
      try {
        state.proteins = await fetchProteins();
        state.loading = null;
        render();
      } catch (err) {
        state.loading = null;
        render();
      }
    } else {
      navigate('protein-selector');
    }
  } else if (step === 'carb') {
    navigate('carb-selector');
  } else if (step === 'addons') {
    navigate('protein-veggie-selector');
  } else if (step === 'salad') {
    if (state.saladBases.length === 0) {
      state.loading = 'Loading salad bases…';
      navigate('salad-base-selector');
      try {
        state.saladBases = await fetchSaladBases();
        state.loading = null;
        render();
      } catch (err) {
        state.loading = null;
        render();
      }
    } else {
      navigate('salad-base-selector');
    }
  }
}

// ─── Guided flow: advance to next step or review ──────────────────────────────

function advanceToNextStep() {
  if (state.mealFlowIndex < 0) return;

  // If editing a previous step, return to where the user was
  if (state.mealFlowReturnIndex != null && state.mealFlowReturnIndex > state.mealFlowIndex) {
    const returnTo = state.mealFlowReturnIndex;
    state.mealFlowReturnIndex = undefined;
    if (returnTo >= state.mealFlowSteps.length) {
      state.mealFlowIndex = state.mealFlowSteps.length;
      navigate('meal-review');
    } else {
      navigateToFlowStep(returnTo);
    }
    return;
  }
  state.mealFlowReturnIndex = undefined;

  const next = state.mealFlowIndex + 1;
  if (next >= state.mealFlowSteps.length) {
    state.mealFlowIndex = state.mealFlowSteps.length; // signals "all done" for progress bar
    navigate('meal-review');
  } else {
    navigateToFlowStep(next);
  }
}

// ─── Meal Review screen ───────────────────────────────────────────────────────

function renderMealReview() {
  const { meal } = state;

  const componentCard = (emoji, title, sub) => `
    <div class="review-component-card">
      <span class="review-card-icon">${emoji}</span>
      <div class="review-card-info">
        <div class="review-card-title">${title}</div>
        <div class="review-card-sub">${sub}</div>
      </div>
      <i data-lucide="check-circle-2" class="review-card-check"></i>
    </div>`;

  const addonsHTML = state.selectedAddons.length > 0 ? `
    <div class="review-component-card">
      <span class="review-card-icon">🧩</span>
      <div class="review-card-info">
        <div class="review-card-title">Add-ons</div>
        <div class="review-card-sub">${state.selectedAddons.map(a => `${a.emoji} ${a.name}`).join(' · ')}</div>
      </div>
      <i data-lucide="check-circle-2" class="review-card-check"></i>
    </div>` : '';

  const hasAnything = meal.protein || meal.carb || meal.saladBase || state.selectedAddons.length > 0;

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <div class="logo"><span>🍲</span>Your Meal</div>
      <div class="subtitle">Review &amp; let's cook!</div>
    </div>
    <div class="scroll-body">
      <p class="section-label">Everything looks good?</p>
      <div class="review-components">
        ${meal.protein  ? componentCard(meal.protein.emoji,  meal.protein.name,    `${meal.marinade?.name || ''} marinade`) : ''}
        ${meal.carb     ? componentCard(meal.carb.emoji,     meal.carb.name + (meal.prep ? ` — ${meal.prep.name}` : ''), meal.sauce?.name || '') : ''}
        ${addonsHTML}
        ${meal.saladBase ? componentCard(meal.saladBase.emoji, meal.saladBase.name, meal.dressing?.name || '') : ''}
      </div>
      ${hasAnything ? `
        <button class="cook-btn" onclick="navigate('meal-recipe')" style="margin-top:20px">
          <i data-lucide="utensils"></i> Let's Go!
        </button>` : ''}
      <button class="review-restart-btn" onclick="restartMealFlow()">
        <i data-lucide="refresh-cw"></i> Start Over
      </button>
    </div>
  `;
}

function restartMealFlow() {
  state.mealFlowSteps = [];
  state.mealFlowIndex = -1;
  state.mealStep = null;
  state.meal = { protein: null, marinade: null, carb: null, prep: null, sauce: null, saladBase: null, dressing: null };
  state.selectedAddons = [];
  navigate('meal-builder');
}

// Back button handler for flow step root screens.
// Step 0 → restart (clears flow/progress bar). Step N → go to step N-1. Not in flow → normal back.
function backFromFlowStep(fallbackScreen) {
  if (state.mealFlowIndex === 0) {
    restartMealFlow();
  } else if (state.mealFlowIndex > 0) {
    navigateToFlowStep(state.mealFlowIndex - 1);
  } else {
    navigate(fallbackScreen);
  }
}

// ─── Unified Meal Recipe screen ───────────────────────────────────────────────

function renderMealRecipe() {
  const { meal } = state;

  // ── Timing summary ───────────────────────────────────────────────────────────
  let marineTime = 0;
  let cookTime = 0;
  let saladTime = 0;

  if (meal.marinade) {
    marineTime = meal.marinade.steps.reduce((s, st, i) =>
      s + (st.estimatedTime || (SAUCE_TIMES[meal.marinade.id]?.[i]) || 5), 0);
  }
  if (meal.sauce) {
    const sauceStepTime = meal.sauce.steps.reduce((s, st, i) =>
      s + (st.estimatedTime || (SAUCE_TIMES[meal.sauce.id]?.[i]) || 5), 0);
    const carbTime = meal.carb
      ? ((meal.prep?.cookTimeMinutes ?? meal.carb.cookTimeMinutes) ?? CARB_COOK_TIMES[meal.carb.id]?.minutes ?? 0)
      : 0;
    cookTime = Math.max(sauceStepTime, carbTime);
  }
  if (meal.dressing) {
    saladTime = meal.dressing.steps.reduce((s, st, i) =>
      s + (st.estimatedTime || (SAUCE_TIMES[meal.dressing.id]?.[i]) || 3), 0);
  }
  const totalTime = marineTime + cookTime + saladTime;
  const marineAhead = marineTime > 20;

  const timingBanner = `
    <div class="meal-timing-banner">
      <div class="meal-timing-total"><i data-lucide="clock"></i> Total: ~${totalTime} min active</div>
      ${marineAhead ? `<div class="meal-timing-note"><i data-lucide="triangle-alert"></i> Start marinade ${marineTime}+ min before you cook</div>` : ''}
    </div>`;

  // ── Section renderer (reuses step-card format) ────────────────────────────
  function sectionHTML(label, labelColor, sauceObj) {
    if (!sauceObj) return '';
    const stepTimes = sauceObj.steps.map((st, i) =>
      st.estimatedTime || (SAUCE_TIMES[sauceObj.id]?.[i]) || 5);

    const stepsHTML = sauceObj.steps.map((step, i) => {
      const stepTime = stepTimes[i];
      const displayItems = prepareItems(step.ingredients);

      const refStep = step.inputFromStep ? sauceObj.steps[step.inputFromStep - 1] : null;
      if (refStep) {
        const refTsp = refStep.ingredients.reduce((s, it) =>
          s + toTsp(scaleAmount(it.amount, state.servings), it.unit), 0);
        let dAmt = refTsp, dUnit = 'tsp';
        if (refTsp >= 48) { dAmt = +(refTsp / 48).toFixed(1); dUnit = 'cup'; }
        else if (refTsp >= 3) { dAmt = +(refTsp / 3).toFixed(1); dUnit = 'tbsp'; }
        displayItems.unshift({ name: `Step ${step.inputFromStep} combined`, amount: dAmt, unit: dUnit });
      }
      const refBadge = refStep
        ? `<div class="step-ref-badge"><i data-lucide="corner-down-right"></i> Combine all of Step ${step.inputFromStep} into this bowl</div>` : '';

      const pieHTML = buildPieChart(displayItems, 80);
      const legendHTML = buildLegend(displayItems);

      return `<div class="step-card">
        <div class="step-header-row">
          <div class="step-number">Step ${i + 1}</div>
          <div class="step-time">~${stepTime}m</div>
        </div>
        <div class="step-title">${step.title}</div>
        ${refBadge}
        <div class="step-viz">
          ${pieHTML}
          <div class="step-legend">${legendHTML}</div>
        </div>
      </div>`;
    }).join('');

    return `
      <div class="meal-section">
        <div class="meal-section-label" style="background:${labelColor}">
          ${label}
        </div>
        ${stepsHTML}
      </div>`;
  }

  // ── Addon card for protein cooking ────────────────────────────────────────
  const proteinCardHTML = () => {
    if (!meal.protein) return '';
    const p = meal.protein;
    return `
      <div class="meal-section">
        <div class="meal-section-label" style="background:#C94E02">
          ${p.emoji} Cook ${p.name}${marineAhead ? ' (after marinating)' : ''}
        </div>
        <div class="addon-card">
          <div class="addon-card-header">
            <span class="addon-emoji">${p.emoji}</span>
            <div class="addon-info">
              <div class="addon-name">${p.name}</div>
              <div class="addon-time">~${p.estimatedTime} min</div>
            </div>
          </div>
          <div class="addon-instructions">${p.instructions}</div>
        </div>
      </div>`;
  };

  // ── Selected add-ons cards ─────────────────────────────────────────────────
  const addonsCardsHTML = () => {
    if (!state.selectedAddons || state.selectedAddons.length === 0) return '';
    return state.selectedAddons.map(a => `
      <div class="meal-section">
        <div class="meal-section-label" style="background:#92400E">
          ${a.emoji} ${a.name}
        </div>
        <div class="addon-card">
          <div class="addon-card-header">
            <span class="addon-emoji">${a.emoji}</span>
            <div class="addon-info">
              <div class="addon-name">${a.name}</div>
              <div class="addon-time">~${a.estimatedTime} min</div>
            </div>
          </div>
          <div class="addon-instructions">${a.instructions}</div>
        </div>
      </div>`).join('');
  };

  // Salad toss note
  const saladTossHTML = () => {
    if (!meal.saladBase) return '';
    return `
      <div class="meal-section">
        <div class="meal-section-label" style="background:#2D6A4F">
          🥗 Toss Salad
        </div>
        <div class="step-card">
          <div class="step-title">Toss ${meal.saladBase.name} with dressing right before serving</div>
        </div>
      </div>`;
  };

  const servingsHTML = `
    <div class="recipe-controls">
      <div class="servings-control">
        <button onclick="changeServings(-1)" class="serving-btn" ${state.servings <= 1 ? 'disabled' : ''}>−</button>
        <span class="servings-label">${state.servings} ${state.servings === 1 ? 'person' : 'people'}</span>
        <button onclick="changeServings(1)" class="serving-btn" ${state.servings >= 12 ? 'disabled' : ''}>+</button>
      </div>
      <button class="unit-toggle" onclick="toggleUnit()">
        ${state.unitSystem === 'imperial' ? 'Imperial' : 'Metric'}
      </button>
    </div>`;

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('meal-review')"><i data-lucide="chevron-left"></i> Review</button>
      <div class="logo"><span>🍲</span>Your Meal</div>
      <div class="subtitle">Full recipe</div>
    </div>
    <div class="scroll-body">
      ${timingBanner}
      ${servingsHTML}
      ${sectionHTML(`🔥 Marinade — ${meal.marinade?.name || ''}`, '#5D4037', meal.marinade)}
      ${meal.carb ? `
        <div class="meal-section">
          <div class="meal-section-label" style="background:#1565C0">
            🍝 Prep ${meal.carb.name}${meal.prep ? ` — ${meal.prep.name}` : ''}
          </div>
          <div class="step-card">
            <div class="step-header-row">
              <div class="step-number">Boil / prep</div>
              <div class="step-time">~${(meal.prep?.cookTimeMinutes ?? meal.carb.cookTimeMinutes) ?? CARB_COOK_TIMES[meal.carb.id]?.minutes ?? 0} min</div>
            </div>
            <div class="step-title">${meal.prep ? meal.prep.instructions || `Cook ${meal.prep.name}` : `Cook ${meal.carb.name} per packet instructions`}</div>
          </div>
        </div>` : ''}
      ${sectionHTML(`🍲 Sauce — ${meal.sauce?.name || ''}`, '#4A0072', meal.sauce)}
      ${proteinCardHTML()}
      ${addonsCardsHTML()}
      ${sectionHTML(`🥗 Dressing — ${meal.dressing?.name || ''}`, '#1B5E20', meal.dressing)}
      ${saladTossHTML()}
    </div>
  `;
}

// ─── Meal-recipe serving controls ─────────────────────────────────────────────
// (re-uses setServings / setUnitSystem from recipe.js)

function changeServings(delta) {
  setServings(state.servings + delta);
}

function toggleUnit() {
  setUnitSystem(state.unitSystem === 'imperial' ? 'metric' : 'imperial');
}
