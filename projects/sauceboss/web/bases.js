'use strict';

// Future: when salad bases gain prep variants, fetch them here and route to a
// 'salad-prep-selector' screen first.
async function selectSaladBase(id) {
  state.selectedSaladBase = state.saladBases.find(b => b.id === id);
  state.servings = 2;
  state.disabledIngredients = new Set();
  state.filterOpen = false;
  state.dressingsForCurrentBase = [];
  state.loading = 'Loading dressings…';
  state.screen = 'dressing-selector';
  render();

  try {
    const { dressings, ingredients } = await fetchSaladBaseLoad(id);
    state.dressingsForCurrentBase = dressings;
    state.allDressingIngredients  = ingredients;
    state.expandedCuisines        = new Set();
    state.loading = null;
    render();
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
