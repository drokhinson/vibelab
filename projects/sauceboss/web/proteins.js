'use strict';

// Future: when proteins gain cooking-style variants (grill / oven / fry),
// fetch them here and route to a 'protein-prep-selector' screen first.
async function selectProtein(id) {
  state.selectedProtein = state.proteins.find(p => p.id === id);
  state.servings = 2;
  state.disabledIngredients = new Set();
  state.filterOpen = false;
  state.marinadesForCurrentProtein = [];
  state.loading = 'Loading marinades…';
  state.screen = 'marinade-selector';
  render();

  try {
    const [marinades, ingredients] = await Promise.all([
      fetchMarinadesForProtein(id),
      fetchIngredientsForProtein(id),
    ]);
    state.marinadesForCurrentProtein = marinades;
    state.allMarinadeIngredients     = ingredients;
    state.expandedCuisines           = new Set();
    state.loading = null;
    render();
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
