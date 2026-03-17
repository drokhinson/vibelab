'use strict';

function renderProteinSelector() {
  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <div class="logo"><span>🔥</span>SauceBoss</div>
      <div class="subtitle">What are you marinating?</div>
      <button class="settings-btn" onclick="openSauceManager()" title="Sauce manager">⚙</button>
    </div>
    ${renderTabBar()}
    <div class="scroll-body">
      ${state.proteins.length === 0
        ? '<div class="empty-state">Loading proteins…</div>'
        : `<div class="carb-grid">
            ${state.proteins.map(p => `
              <button class="carb-card" onclick="selectProtein('${p.id}')">
                <span class="carb-emoji">${p.emoji}</span>
                <div class="carb-name">${p.name}</div>
                <div class="carb-desc">${p.desc || ''}</div>
              </button>
            `).join('')}
          </div>`
      }
    </div>
  `;
}

async function selectProtein(id) {
  state.selectedProtein = state.proteins.find(p => p.id === id);
  state.servings = 2;
  state.disabledIngredients = new Set();
  state.filterOpen = false;

  document.getElementById('app').innerHTML = `
    <div class="loading-screen">
      <div class="spinner"></div>
      <p class="loading-text">Loading marinades…</p>
    </div>`;

  try {
    const [marinades, ingredients] = await Promise.all([
      fetchMarinadesForProtein(id),
      fetchIngredientsForProtein(id),
    ]);
    state.marinadesForCurrentProtein = marinades;
    state.allMarinadeIngredients     = ingredients;
    state.expandedCuisines           = new Set([marinades[0]?.cuisine].filter(Boolean));
    state.screen = 'marinade-selector';
    render();
  } catch (err) {
    document.getElementById('app').innerHTML = `
      <div style="padding:2rem;text-align:center;color:#dc2626">
        Failed to load marinades: ${err.message}<br>
        <button onclick="navigate('protein-selector')" style="margin-top:1rem">‹ Back</button>
      </div>`;
  }
}
