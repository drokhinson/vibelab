'use strict';

async function selectSaladBase(id) {
  state.selectedSaladBase = state.saladBases.find(b => b.id === id);
  state.selectedCarb = null;
  state.selectedProtein = null;
  state.servings = 2;
  state.disabledIngredients = new Set();
  state.filterOpen = false;
  state.dressingsForCurrentBase = [];
  state.preparations = [];
  state.selectedPrep = null;
  state.loading = 'Loading dressings…';
  state.screen = 'dressing-selector';
  render();

  try {
    const { sauces, ingredients, variants } = await fetchItemLoad(id);
    state.dressingsForCurrentBase = sauces;
    state.allDressingIngredients  = ingredients;
    state.preparations            = variants;
    state.expandedCuisines        = new Set();
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
          Failed to load dressings: ${err.message}<br>
          <button onclick="navigate('meal-builder')" style="margin-top:1rem">‹ Back</button>
        </div>`;
    }
  }
}
