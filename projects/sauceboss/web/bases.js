'use strict';

function renderSaladBaseSelector() {
  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="backFromFlowStep('meal-builder')"><i data-lucide="chevron-left"></i> Back</button>
      <div class="logo"><span>🥗</span>Pick your salad base</div>
    </div>
    <div class="scroll-body">
      ${state.saladBases.length === 0
        ? '<div class="empty-state">Loading salad bases…</div>'
        : `<div class="carb-grid">
            ${state.saladBases.map((b, i) => `
              <button class="carb-card" style="--i:${i}" onclick="selectSaladBase('${b.id}')">
                <span class="carb-emoji">${b.emoji}</span>
                <div class="carb-name">${b.name}</div>
                <div class="carb-desc">${b.description || ''}</div>
              </button>
            `).join('')}
          </div>`
      }
    </div>
  `;
}

async function selectSaladBase(id) {
  state.selectedSaladBase = state.saladBases.find(b => b.id === id);
  state.servings = 2;
  state.disabledIngredients = new Set();
  state.filterOpen = false;
  state.loading = 'Loading dressings…';
  render(); // keeps header + progress bar, shows spinner in scroll-body

  try {
    const [dressings, ingredients] = await Promise.all([
      fetchDressingsForBase(id),
      fetchIngredientsForBase(id),
    ]);
    state.dressingsForCurrentBase = dressings;
    state.allDressingIngredients  = ingredients;
    state.expandedCuisines        = new Set();
    state.loading = null;
    state.screen = 'dressing-selector';
    render();
  } catch (err) {
    state.loading = null;
    const scrollBody = document.querySelector('.scroll-body');
    if (scrollBody) {
      scrollBody.innerHTML = `
        <div style="padding:2rem;text-align:center;color:#dc2626">
          Failed to load dressings: ${err.message}<br>
          <button onclick="navigate('salad-base-selector')" style="margin-top:1rem">‹ Back</button>
        </div>`;
    }
  }
}
