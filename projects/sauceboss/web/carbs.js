'use strict';

async function selectCarb(id) {
  state.selectedCarb = state.carbs.find(c => c.id === id);
  state.selectedProtein = null;
  state.selectedSaladBase = null;
  state.servings = 2;
  state.selectedPrep = null;
  state.preparations = [];
  state.saucesForCurrentCarb = [];
  const carbName = state.selectedCarb?.name || 'options';
  state.loading = `Loading ${carbName.toLowerCase()} options…`;
  // Show the loading state on a fresh selector screen so the spinner appears immediately.
  navigate('sauce-selector', { replace: true });

  try {
    const { sauces, ingredients, variants } = await fetchItemLoad(id);
    state.saucesForCurrentCarb = sauces;
    state.allIngredients       = ingredients;
    state.preparations         = variants;
    state.disabledIngredients  = new Set();
    state.filterOpen           = false;
    state.expandedCuisines     = new Set();
    state.loading = null;
    navigate(variants.length > 0 ? 'prep-selector' : 'sauce-selector');
  } catch (err) {
    state.loading = null;
    const scrollBody = document.querySelector('.scroll-body');
    if (scrollBody) {
      scrollBody.innerHTML = `
        <div style="padding:2rem;text-align:center;color:#dc2626">
          Failed to load: ${err.message}<br>
          <button onclick="navigate('meal-builder')" style="margin-top:1rem">‹ Back</button>
        </div>`;
    }
  }
}
