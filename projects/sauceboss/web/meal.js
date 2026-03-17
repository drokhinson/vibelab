'use strict';

// ─── Meal Builder home screen ─────────────────────────────────────────────────

function renderMealBuilder() {
  const { meal } = state;
  const hasAny = meal.sauce || meal.dressing || meal.marinade;

  const proteinSlot = () => {
    if (meal.protein && meal.marinade) {
      return `
        <div class="meal-slot filled">
          <div class="meal-slot-header">
            <span class="meal-slot-icon">${meal.protein.emoji}</span>
            <div class="meal-slot-info">
              <div class="meal-slot-title">${meal.protein.name}</div>
              <div class="meal-slot-sub">${meal.marinade.name} marinade</div>
            </div>
            <button class="meal-slot-clear" onclick="clearMealComponent('protein')" title="Remove"><i data-lucide="x"></i></button>
          </div>
        </div>`;
    }
    return `
      <button class="meal-slot empty" onclick="startMealComponent('protein')">
        <span class="meal-slot-add-icon">🔥</span>
        <div class="meal-slot-add-text">
          <div class="meal-slot-add-label">Protein &amp; Marinade</div>
          <div class="meal-slot-add-hint">Chicken, beef, tofu, fish</div>
        </div>
        <span class="meal-slot-plus"><i data-lucide="plus-circle"></i></span>
      </button>`;
  };

  const carbSlot = () => {
    if (meal.carb && meal.sauce) {
      return `
        <div class="meal-slot filled">
          <div class="meal-slot-header">
            <span class="meal-slot-icon">${meal.carb.emoji}</span>
            <div class="meal-slot-info">
              <div class="meal-slot-title">${meal.carb.name}${meal.prep ? ` — ${meal.prep.name}` : ''}</div>
              <div class="meal-slot-sub">${meal.sauce.name}</div>
            </div>
            <button class="meal-slot-clear" onclick="clearMealComponent('carb')" title="Remove"><i data-lucide="x"></i></button>
          </div>
        </div>`;
    }
    return `
      <button class="meal-slot empty" onclick="startMealComponent('carb')">
        <span class="meal-slot-add-icon">🍝</span>
        <div class="meal-slot-add-text">
          <div class="meal-slot-add-label">Carb &amp; Sauce</div>
          <div class="meal-slot-add-hint">Pasta, rice, noodles, bread…</div>
        </div>
        <span class="meal-slot-plus"><i data-lucide="plus-circle"></i></span>
      </button>`;
  };

  const saladSlot = () => {
    if (meal.saladBase && meal.dressing) {
      return `
        <div class="meal-slot filled">
          <div class="meal-slot-header">
            <span class="meal-slot-icon">${meal.saladBase.emoji}</span>
            <div class="meal-slot-info">
              <div class="meal-slot-title">${meal.saladBase.name}</div>
              <div class="meal-slot-sub">${meal.dressing.name}</div>
            </div>
            <button class="meal-slot-clear" onclick="clearMealComponent('salad')" title="Remove"><i data-lucide="x"></i></button>
          </div>
        </div>`;
    }
    return `
      <button class="meal-slot empty" onclick="startMealComponent('salad')">
        <span class="meal-slot-add-icon">🥗</span>
        <div class="meal-slot-add-text">
          <div class="meal-slot-add-label">Salad &amp; Dressing</div>
          <div class="meal-slot-add-hint">Romaine, spinach, arugula…</div>
        </div>
        <span class="meal-slot-plus"><i data-lucide="plus-circle"></i></span>
      </button>`;
  };

  const heroSVG = !hasAny ? `
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
    </div>` : '';

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <div class="logo"><span>🍲</span>SauceBoss</div>
      <div class="subtitle">Build your meal</div>
      <button class="settings-btn" onclick="openSauceManager()" title="Sauce manager"><i data-lucide="settings-2"></i></button>
    </div>
    <div class="scroll-body">
      ${heroSVG}
      <p class="section-label">What are you making tonight?</p>
      <div class="meal-slots">
        <div style="--i:0">${proteinSlot()}</div>
        <div style="--i:1">${carbSlot()}</div>
        <div style="--i:2">${saladSlot()}</div>
      </div>
      ${hasAny ? `
        <button class="cook-btn" onclick="navigate('meal-recipe')">
          <i data-lucide="chef-hat"></i> Let's Cook
        </button>` : `
        <p class="meal-hint">Add at least one component to get started</p>`
      }
    </div>
  `;
}

// ─── Meal component navigation ─────────────────────────────────────────────────

async function startMealComponent(step) {
  state.mealStep = step;
  state.disabledIngredients = new Set();
  state.filterOpen = false;
  state.expandedCuisines = new Set();

  if (step === 'carb') {
    navigate('carb-selector');
  } else if (step === 'salad') {
    if (state.saladBases.length === 0) {
      navigate('salad-base-selector');
      try {
        state.saladBases = await fetchSaladBases();
        render();
      } catch (err) {
        document.getElementById('app').innerHTML = `
          <div style="padding:2rem;text-align:center;color:#dc2626">
            Failed to load salad bases: ${err.message}
          </div>`;
      }
    } else {
      navigate('salad-base-selector');
    }
  } else if (step === 'protein') {
    if (state.proteins.length === 0) {
      navigate('protein-selector');
      try {
        state.proteins = await fetchProteins();
        render();
      } catch (err) {
        document.getElementById('app').innerHTML = `
          <div style="padding:2rem;text-align:center;color:#dc2626">
            Failed to load proteins: ${err.message}
          </div>`;
      }
    } else {
      navigate('protein-selector');
    }
  }
}

function clearMealComponent(which) {
  if (which === 'protein') {
    state.meal.protein  = null;
    state.meal.marinade = null;
  } else if (which === 'carb') {
    state.meal.carb   = null;
    state.meal.prep   = null;
    state.meal.sauce  = null;
  } else if (which === 'salad') {
    state.meal.saladBase = null;
    state.meal.dressing  = null;
  }
  navigate('meal-builder');
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
      <button class="back-btn" onclick="navigate('meal-builder')"><i data-lucide="chevron-left"></i> Back</button>
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
