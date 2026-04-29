'use strict';

// ─── Unified item selection (carb / protein / salad) ─────────────────────────
// One handler for all three categories. The category-specific labels (sauces
// vs marinades vs dressings, "options" vs "marinades" loading text) come from
// itemFlowMeta below, derived from the item's category.

const ITEM_FLOW_META = {
  carb:    { sauceTypeLabel: 'sauces',     sauceWord: 'Sauce'    },
  protein: { sauceTypeLabel: 'marinades',  sauceWord: 'Marinade' },
  salad:   { sauceTypeLabel: 'dressings',  sauceWord: 'Dressing' },
};

function flowMetaFor(item) {
  if (!item) return ITEM_FLOW_META.carb;
  return ITEM_FLOW_META[item.category] || ITEM_FLOW_META.carb;
}

function _findItemById(id) {
  return (state.carbs.find(c => c.id === id))
      || (state.proteins.find(p => p.id === id))
      || (state.saladBases.find(s => s.id === id));
}

async function selectItem(id) {
  const item = _findItemById(id);
  if (!item) return;

  state.selectedItem        = item;
  state.selectedPrep        = null;
  state.preparations        = [];
  state.saucesForCurrentItem = [];
  state.allIngredients      = [];
  state.disabledIngredients = new Set();
  state.filterOpen          = false;
  state.expandedCuisines    = new Set();
  state.servings            = 2;

  const meta = flowMetaFor(item);
  state.loading = `Loading ${item.name.toLowerCase()} ${meta.sauceTypeLabel}…`;
  navigate('sauce-selector', { replace: true });

  try {
    const { sauces, ingredients, variants } = await fetchItemLoad(id);
    state.saucesForCurrentItem = sauces;
    state.allIngredients       = ingredients;
    state.preparations         = variants;
    state.loading              = null;
    navigate(variants.length > 0 ? 'prep-selector' : 'sauce-selector');
  } catch (err) {
    state.loading = null;
    const scrollBody = document.querySelector('.scroll-body');
    if (scrollBody) {
      scrollBody.innerHTML = `
        <div style="padding:2rem;text-align:center;color:#dc2626">
          Failed to load ${meta.sauceTypeLabel}: ${err.message}<br>
          <button onclick="navigate('meal-builder')" style="margin-top:1rem">‹ Back</button>
        </div>`;
    }
  }
}
