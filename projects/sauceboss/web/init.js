'use strict';

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const [carbs, categoriesRaw, subsRaw, addonsRaw] = await Promise.all([
      fetchCarbs(),
      fetchIngredientCategories().catch(() => []),
      fetchSubstitutions().catch(() => []),
      fetchAddons().catch(() => []),
    ]);
    loadUnits(); // fire-and-forget — falls back to hardcoded constants if it fails
    state.carbs = carbs;

    if (Array.isArray(addonsRaw) && addonsRaw.length > 0) {
      state.addons = {
        proteins: addonsRaw.filter(a => a.type === 'protein'),
        veggies: addonsRaw.filter(a => a.type === 'veggie'),
      };
    } else {
      state.addons = PROTEIN_VEGGIE_OPTIONS;
    }

    state.ingredientCategories = {};
    if (Array.isArray(categoriesRaw)) {
      for (const c of categoriesRaw) {
        state.ingredientCategories[c.ingredientName] = c.category;
      }
    }

    state.substitutions = {};
    if (Array.isArray(subsRaw)) {
      for (const s of subsRaw) {
        if (!state.substitutions[s.ingredientName]) state.substitutions[s.ingredientName] = [];
        state.substitutions[s.ingredientName].push({ substituteName: s.substituteName, notes: s.notes });
      }
    }
  } catch (err) {
    document.getElementById('app').innerHTML = `
      <div style="padding:2rem;text-align:center;color:#dc2626">
        Failed to load: ${err.message}
      </div>`;
    return;
  }
  render();

  const appEl = document.getElementById('app');

  // Ingredient chip toggles
  appEl.addEventListener('click', e => {
    const chip = e.target.closest('.chip[data-ingredient]');
    if (chip) toggleIngredient(chip.dataset.ingredient);
  });

  // Builder field inputs (no re-render to preserve cursor)
  appEl.addEventListener('input', e => {
    if (e.target.dataset.builderField) builderHandleInput(e.target);
  });
  appEl.addEventListener('change', e => {
    if (e.target.dataset.builderField) builderHandleInput(e.target);
  });

  // Autocomplete: click to pick
  appEl.addEventListener('mousedown', e => {
    const acItem = e.target.closest('.ac-item[data-ac-pick]');
    if (acItem) {
      e.preventDefault();
      const si = parseInt(acItem.dataset.step);
      const ii = parseInt(acItem.dataset.ing);
      builderPickAutocomplete(acItem.dataset.acPick, si, ii);
    }
  });

  // Category classification: click chip
  appEl.addEventListener('click', e => {
    const catChip = e.target.closest('.category-chip[data-classify-cat]');
    if (catChip) {
      const si = parseInt(catChip.dataset.step);
      const ii = parseInt(catChip.dataset.ing);
      builderClassifyIngredient(si, ii, catChip.dataset.classifyCat);
    }
  });

  // Ingredient name blur: dismiss autocomplete + show category prompt for unknown
  appEl.addEventListener('focusout', e => {
    if (e.target.dataset.builderField === 'ing-name' && state.builder) {
      const si = parseInt(e.target.dataset.step);
      const ii = parseInt(e.target.dataset.ing);
      const b = state.builder;
      setTimeout(() => {
        if (b.acStep === si && b.acIng === ii) {
          b.acResults = [];
          b.acStep = null;
          b.acIng = null;
          document.querySelectorAll('.ac-dropdown').forEach(d => d.remove());
        }
      }, 200);
      const ing = b.steps[si]?.ingredients[ii];
      if (ing && ing.name.trim().length >= 2 && !isKnownIngredient(ing.name)) {
        ing._showCategory = true;
        const wrap = e.target.closest('.ingredient-row-wrap');
        if (wrap && !wrap.querySelector('.category-classify')) {
          const div = document.createElement('div');
          div.className = 'category-classify';
          div.innerHTML = `
            <span class="category-classify-label">Classify "${ing.name.trim()}":</span>
            <div class="category-chips">
              ${CATEGORY_ORDER.map(cat =>
                `<button class="category-chip" data-classify-cat="${cat}" data-step="${si}" data-ing="${ii}">${cat}</button>`
              ).join('')}
            </div>`;
          wrap.appendChild(div);
        }
      }
    }
  });
});
