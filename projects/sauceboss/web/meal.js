'use strict';

// ─── Meal Builder home — single-pick across three sections ──────────────────

// Shared pot illustration. Rendered both on the splash (in index.html) and
// as the hero illustration on the meal-builder home; class names below let
// CSS animate the steam and wiggle the pot during loading.
function potSVG() {
  return `
    <svg class="pot-svg" width="180" height="140" viewBox="0 0 180 140" fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="90" cy="130" rx="62" ry="8" fill="#1A1A2E" opacity="0.06"/>
      <path d="M28 68 Q28 112 90 112 Q152 112 152 68 Z" fill="#FFF3E6"/>
      <rect x="20" y="60" width="140" height="14" rx="7" fill="#E85D04"/>
      <path d="M28 68 Q28 112 90 112 Q152 112 152 68" stroke="#C94E02" stroke-width="2" fill="none"/>
      <ellipse cx="90" cy="96" rx="40" ry="10" fill="#E85D04" opacity="0.1"/>
      <circle class="steam-circle steam-circle--1" cx="70"  cy="91"  r="9" fill="#E85D04" opacity="0.85"/>
      <circle class="steam-circle steam-circle--2" cx="93"  cy="84"  r="7" fill="#F48C06" opacity="0.9"/>
      <circle class="steam-circle steam-circle--3" cx="114" cy="93"  r="8" fill="#C94E02" opacity="0.85"/>
      <circle class="steam-circle steam-circle--4" cx="82"  cy="103" r="5" fill="#FAA307" opacity="0.9"/>
      <path d="M58 76 Q72 62 88 76 Q104 90 118 74" stroke="#E85D04" stroke-width="2.5" stroke-linecap="round" fill="none" opacity="0.5"/>
      <path class="steam-trail steam-trail--1" d="M62 56 Q66 44 62 34 Q58 24 62 14"     stroke="#D1D5DB" stroke-width="2.5" stroke-linecap="round" fill="none"/>
      <path class="steam-trail steam-trail--2" d="M90 53 Q94 41 90 31 Q86 21 90 11"     stroke="#D1D5DB" stroke-width="2.5" stroke-linecap="round" fill="none"/>
      <path class="steam-trail steam-trail--3" d="M118 56 Q122 44 118 34 Q114 24 118 14" stroke="#D1D5DB" stroke-width="2.5" stroke-linecap="round" fill="none"/>
    </svg>`;
}

function renderMealBuilder() {
  const heroSVG = `<div class="hero-illustration" id="hero-illustration">${potSVG()}</div>`;

  const itemCard = (item, i) => `
    <button class="carb-card" style="--i:${i}" onclick="selectItem('${item.id}')">
      <span class="carb-emoji">${item.emoji}</span>
      <div class="carb-name">${item.name}</div>
      <div class="carb-desc">${item.description || ''}</div>
    </button>`;

  const sectionHTML = (label, items) => {
    if (!items || items.length === 0) return '';
    const cards = items.map(itemCard).join('');
    return `
      <p class="section-label" style="margin-top:18px">${label}</p>
      <div class="carb-grid">${cards}</div>`;
  };

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <div class="logo"><span>🍲</span>SauceBoss</div>
      <div class="subtitle">What are you cooking with?</div>
      <button class="settings-btn" onclick="openSauceManager()" title="Sauce manager"><i data-lucide="settings-2"></i></button>
    </div>
    <div class="scroll-body">
      ${heroSVG}
      ${sectionHTML('Carbs',    state.carbs)}
      ${sectionHTML('Proteins', state.proteins)}
      ${sectionHTML('Salads',   state.saladBases)}
    </div>
  `;
}

// ─── Unified Meal Recipe screen ───────────────────────────────────────────────

function renderMealRecipe() {
  const { meal } = state;
  if (!meal.item || !meal.sauce) return '';
  const item  = meal.item;
  const prep  = meal.prep;
  const sauce = meal.sauce;
  const meta  = flowMetaFor(item);

  // ── Timing summary ───────────────────────────────────────────────────────────
  const sauceTime = sauce.steps.reduce(
    (s, st) => s + (st.estimatedTime || 5), 0,
  );
  const itemCookTime = (prep?.cookTimeMinutes ?? item.cookTimeMinutes) || 0;
  const totalTime = sauceTime + itemCookTime;
  const isMarinade = sauce.sauceType === 'marinade';
  const marineAhead = isMarinade && sauceTime > 20;

  const timingBanner = `
    <div class="meal-timing-banner">
      <div class="meal-timing-total"><i data-lucide="clock"></i> Total: ~${totalTime} min active</div>
      ${marineAhead ? `<div class="meal-timing-note"><i data-lucide="triangle-alert"></i> Start marinade ${sauceTime}+ min before you cook</div>` : ''}
    </div>`;

  // ── Sauce/marinade/dressing steps ────────────────────────────────────────────
  function sauceStepsHTML(sauceObj) {
    return sauceObj.steps.map((step, i) => {
      const stepTime = step.estimatedTime || 5;
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

      return `<div class="step-card">
        <div class="step-header-row">
          <div class="step-number">Step ${i + 1}</div>
          <div class="step-time">~${stepTime}m</div>
        </div>
        <div class="step-title">${step.title}</div>
        ${refBadge}
        <div class="step-viz">
          ${buildPieChart(displayItems, 80)}
          <div class="step-legend">${buildLegend(displayItems)}</div>
        </div>
      </div>`;
    }).join('');
  }

  // ── Section colour by sauce_type ────────────────────────────────────────────
  const sauceColor = isMarinade ? '#5D4037'
                   : sauce.sauceType === 'dressing' ? '#1B5E20'
                   : '#4A0072';
  const sauceLabel = `${meta.sauceWord} — ${sauce.name}`;

  // ── Item prep section (one card describing how to cook the chosen item) ────
  const itemPrepLabel = item.category === 'salad'
    ? `🥗 Toss ${item.name}`
    : `${item.emoji} ${item.category === 'protein' ? 'Cook' : 'Prep'} ${item.name}${prep ? ` — ${prep.name}` : ''}`;
  const itemColor = item.category === 'protein' ? '#C94E02'
                 : item.category === 'salad'   ? '#2D6A4F'
                 : '#1565C0';
  const itemInstructions = prep?.instructions
                        || item.instructions
                        || (item.category === 'salad'
                            ? `Toss ${item.name} with ${sauce.name} right before serving`
                            : `Cook ${item.name} per packet instructions`);
  const itemCard = `
    <div class="meal-section">
      <div class="meal-section-label" style="background:${itemColor}">${itemPrepLabel}</div>
      <div class="step-card">
        <div class="step-header-row">
          <div class="step-number">${item.category === 'protein' ? 'Cook' : item.category === 'salad' ? 'Assemble' : 'Boil / prep'}</div>
          ${itemCookTime ? `<div class="step-time">~${itemCookTime}m</div>` : ''}
        </div>
        <div class="step-title">${itemInstructions}</div>
      </div>
    </div>`;

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

  const title = `${prep?.name || item.name} with ${sauce.name}`;

  // For marinades, show marinade BEFORE cooking; otherwise item prep first.
  const sauceSection = `
    <div class="meal-section">
      <div class="meal-section-label" style="background:${sauceColor}">${sauceLabel}</div>
      ${sauceStepsHTML(sauce)}
    </div>`;

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('meal-builder')"><i data-lucide="chevron-left"></i> Back</button>
      <div class="logo"><span>${item.emoji}</span>${title}</div>
      <div class="subtitle">${sauce.cuisine || 'Full recipe'}</div>
    </div>
    <div class="scroll-body">
      ${timingBanner}
      ${servingsHTML}
      ${isMarinade ? sauceSection + itemCard : itemCard + sauceSection}
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
