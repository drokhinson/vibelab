'use strict';

async function selectProtein(id) {
  state.selectedProtein = state.proteins.find(p => p.id === id);
  state.selectedCarb = null;
  state.selectedSaladBase = null;
  state.servings = 2;
  state.disabledIngredients = new Set();
  state.filterOpen = false;
  state.marinadesForCurrentProtein = [];
  state.preparations = [];
  state.selectedPrep = null;
  state.loading = 'Loading marinades…';
  state.screen = 'marinade-selector';
  render();

  try {
    const { sauces, ingredients, variants } = await fetchItemLoad(id);
    state.marinadesForCurrentProtein = sauces;
    state.allMarinadeIngredients     = ingredients;
    state.preparations               = variants;
    state.expandedCuisines           = new Set();
    state.loading = null;
    if (variants.length > 0) {
      navigate('prep-selector');
    } else {
      render();
    }
  } catch (err) {
    state.loading = null;
    const scrollBody = document.querySelector('.scroll-body');
    if (scrollBody) {
      scrollBody.innerHTML = `
        <div style="padding:2rem;text-align:center;color:#dc2626">
          Failed to load marinades: ${err.message}<br>
          <button onclick="navigate('meal-builder')" style="margin-top:1rem">‹ Back</button>
        </div>`;
    }
  }
}
