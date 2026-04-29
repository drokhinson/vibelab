'use strict';

// Generic variant picker. Currently only carbs have variants seeded, but the
// unified items table supports variants on any category — proteins/salad bases
// will route through here automatically once their variants are added.
function _currentVariantParent() {
  return state.selectedCarb || state.selectedProtein || state.selectedSaladBase;
}

function _nextSelectorScreen() {
  if (state.selectedSaladBase) return 'dressing-selector';
  if (state.selectedProtein)   return 'marinade-selector';
  return 'sauce-selector';
}

function renderPrepSelector() {
  const item = _currentVariantParent();
  const preps = state.preparations;
  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('meal-builder')"><i data-lucide="chevron-left"></i> Back</button>
      <div class="logo"><span>${item.emoji}</span>${item.name}</div>
      <div class="subtitle">How are you preparing it?</div>
    </div>
    <div class="scroll-body">
      <div class="carb-grid">
        ${preps.map((p, i) => {
          const cookLabel = p.cookTimeMinutes ? `${p.cookTimeMinutes} min` : '';
          return `
          <button class="carb-card" style="--i:${i}" onclick="selectPrep('${p.id}')">
            <span class="carb-emoji">${p.emoji || item.emoji}</span>
            <div class="carb-name">${p.name}</div>
            <div class="carb-desc">${cookLabel}</div>
          </button>`;
        }).join('')}
      </div>
    </div>
  `;
}

function selectPrep(id) {
  state.selectedPrep = state.preparations.find(p => p.id === id) || null;
  navigate(_nextSelectorScreen());
}
