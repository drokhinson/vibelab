'use strict';

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  document.body.classList.add('splash--loading');

  try {
    const { carbs, proteins, saladBases } = await fetchInitialLoad();
    state.carbs = carbs;
    state.proteins = proteins;
    state.saladBases = saladBases;
    state.addons = { proteins, veggies: [] };
  } catch (err) {
    console.error('[sauceboss] initial load failed', err);
    document.getElementById('splash-screen')?.remove();
    document.body.classList.remove('splash--loading');
    document.getElementById('app').innerHTML = `
      <div style="padding:2rem;text-align:center;color:#dc2626;font-family:Inter,sans-serif">
        <p style="font-weight:700;margin-bottom:8px">Failed to load</p>
        <p style="font-size:13px;color:#6B7280;word-break:break-word">${err.message}</p>
        <p style="font-size:11px;color:#9CA3AF;margin-top:12px">Check the browser console for full details.</p>
      </div>`;
    return;
  }

  // Lazy-load reference data needed only inside the recipe builder.
  // Fire and forget — failures are non-fatal.
  Promise.all([
    fetchIngredientCategories().catch(() => []),
    fetchSubstitutions().catch(() => []),
  ]).then(([categoriesRaw, subsRaw]) => {
    state.ingredientCategories = {};
    if (Array.isArray(categoriesRaw)) {
      for (const c of categoriesRaw) state.ingredientCategories[c.ingredientName] = c.category;
    }
    state.substitutions = {};
    if (Array.isArray(subsRaw)) {
      for (const s of subsRaw) {
        if (!state.substitutions[s.ingredientName]) state.substitutions[s.ingredientName] = [];
        state.substitutions[s.ingredientName].push({ substituteName: s.substituteName, notes: s.notes });
      }
    }
  });

  // Render the meal-builder behind the splash, then animate the handoff:
  // measure where the hero illustration will sit, slide the splash pot to
  // that position, drop the orange header in from the top, and stagger the
  // section cards. Once the slide ends, drop the splash from the DOM and
  // the meal-builder's own hero pot becomes visible (visually identical).
  render();

  requestAnimationFrame(() => {
    const splash    = document.getElementById('splash-screen');
    const splashPot = document.getElementById('splash-pot');
    const hero      = document.getElementById('hero-illustration');
    if (splash && splashPot && hero) {
      const a = splashPot.getBoundingClientRect();
      const b = hero.getBoundingClientRect();
      const dx = (b.left + b.width / 2)  - (a.left + a.width / 2);
      const dy = (b.top  + b.height / 2) - (a.top  + a.height / 2);
      splashPot.style.setProperty('--pot-target-x', `${dx}px`);
      splashPot.style.setProperty('--pot-target-y', `${dy}px`);
      splashPot.style.setProperty('--pot-target-scale', '1');
    }
    document.body.classList.remove('splash--loading');
    document.body.classList.add('splash--exiting');
    setTimeout(() => {
      document.getElementById('splash-screen')?.remove();
      document.body.classList.remove('splash--exiting');
    }, 750);
  });

  history.replaceState({ screen: state.screen, sb: true }, '', '#' + state.screen);

  window.addEventListener('popstate', (e) => {
    if (e.state && e.state.sb && e.state.screen) {
      navigate(e.state.screen, { push: false });
    }
  });

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
