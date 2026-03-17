'use strict';

function renderCarbSelector() {
  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('meal-builder')"><i data-lucide="chevron-left"></i> Back</button>
      <div class="logo"><span>🍝</span>Pick your carb</div>
      <button class="settings-btn" onclick="openSauceManager()" title="Sauce manager"><i data-lucide="settings-2"></i></button>
    </div>
    <div class="scroll-body">
      <div class="carb-grid">
        ${state.carbs.map((c, i) => `
          <button class="carb-card" style="--i:${i}" onclick="selectCarb('${c.id}')">
            <span class="carb-emoji">${c.emoji}</span>
            <div class="carb-name">${c.name}</div>
            <div class="carb-desc">${c.desc}</div>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

async function selectCarb(id) {
  state.selectedCarb = state.carbs.find(c => c.id === id);
  state.servings = 2;
  state.selectedPrep = null;
  state.selectedAddons = [];
  document.getElementById('app').innerHTML = `
    <div class="loading-screen">
      <div class="spinner"></div>
      <p class="loading-text">Loading…</p>
    </div>`;
  try {
    const [sauces, ingredients, preps] = await Promise.all([
      fetchSaucesForCarb(id),
      fetchIngredientsForCarb(id),
      fetchPreparationsForCarb(id).catch(() => []),
    ]);
    state.saucesForCurrentCarb = sauces;
    state.allIngredients       = ingredients;
    state.preparations         = preps;
    state.disabledIngredients  = new Set();
    state.filterOpen           = false;
    state.expandedCuisines     = new Set([sauces[0]?.cuisine].filter(Boolean));
    state.screen = preps.length > 0 ? 'prep-selector' : 'protein-veggie-selector';
    render();
  } catch (err) {
    document.getElementById('app').innerHTML = `
      <div style="padding:2rem;text-align:center;color:#dc2626">
        Failed to load: ${err.message}<br>
        <button onclick="navigate('carb-selector')" style="margin-top:1rem">‹ Back</button>
      </div>`;
  }
}
