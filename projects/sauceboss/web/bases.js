'use strict';

function renderSaladBaseSelector() {
  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <div class="logo"><span>🥗</span>SauceBoss</div>
      <div class="subtitle">Pick your salad base</div>
      <button class="settings-btn" onclick="openSauceManager()" title="Sauce manager">⚙</button>
    </div>
    ${renderTabBar()}
    <div class="scroll-body">
      ${state.saladBases.length === 0
        ? '<div class="empty-state">Loading salad bases…</div>'
        : `<div class="carb-grid">
            ${state.saladBases.map(b => `
              <button class="carb-card" onclick="selectSaladBase('${b.id}')">
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

  document.getElementById('app').innerHTML = `
    <div class="loading-screen">
      <div class="spinner"></div>
      <p class="loading-text">Loading dressings…</p>
    </div>`;

  try {
    const [dressings, ingredients] = await Promise.all([
      fetchDressingsForBase(id),
      fetchIngredientsForBase(id),
    ]);
    state.dressingsForCurrentBase = dressings;
    state.allDressingIngredients  = ingredients;
    state.expandedCuisines        = new Set([dressings[0]?.cuisine].filter(Boolean));
    state.screen = 'dressing-selector';
    render();
  } catch (err) {
    document.getElementById('app').innerHTML = `
      <div style="padding:2rem;text-align:center;color:#dc2626">
        Failed to load dressings: ${err.message}<br>
        <button onclick="navigate('salad-base-selector')" style="margin-top:1rem">‹ Back</button>
      </div>`;
  }
}
