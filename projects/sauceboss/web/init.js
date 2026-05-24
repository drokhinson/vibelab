'use strict';
// @ts-check
// Globals + cross-file contracts are declared in ./types.d.ts. See
// .claude/rules/typed-js.md for the editor-only type-check convention.

// Update the label inside the splash pill. The trailing animated dots are
// part of the same paragraph so a textContent swap on the label leaves them
// in place.
function setSplashText(text) {
  const el = document.getElementById('splash-text-label');
  if (el) el.textContent = text;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
// Initial load fires at most three Sauceboss data queries:
//   • Phase 1 (blocking) — GET /profile (only when a Supabase session exists;
//     awaited inside awaitInitialAuth via the auth callback).
//   • Phase 2 (blocking) — GET /saucebook (only when logged in).
//   • Background        — GET /browse (always) + GET /pantry (logged in).
// Meal-builder reference data (initial-load, ingredient-categories,
// substitutions) loads lazily on first meal-builder / recipe-builder open
// so the splash drops as fast as possible.
document.addEventListener('DOMContentLoaded', async () => {
  document.body.classList.add('splash--loading');
  setSplashText('Authenticating');

  // Wire up Supabase Auth (email / Google / Apple). No-op when not configured.
  // initSupabase kicks off the auth roundtrip and (when there's a restored
  // session) the /profile fetch — both finish before awaitInitialAuth resolves.
  initSupabase();

  try {
    // Phase 1 — Authenticating: Supabase roundtrip + (if session) /profile.
    await awaitInitialAuth();

    // Phase 2 — kick off saucebook + pantry as background loads. Neither
    // blocks the splash: the saucebook tab has its own "Loading your
    // saucebook…" skeleton (saucebook.js:67-68) and re-renders when
    // state.saucebookLoaded flips inside loadSaucebook's finally; pantry
    // re-renders the same way. The splash now drops as soon as auth
    // resolves so Browse + meal-builder are usable immediately.
    if (currentUser) {
      loadSaucebook();
      loadPantry();
    }
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

  // Tab-shell is the default screen. Anonymous users land on Browse;
  // logged-in users default to Saucebook (already populated by Phase 2).
  // If the URL is a `/sauce/<id>` permalink, the recipe view takes over
  // once the sauce loads; the tab underneath is still set so the recipe's
  // back button has a destination.
  //
  // Wrap this in a try/catch so a throw from render() (or one of the tab
  // renderers it dispatches into) doesn't strand the user on the
  // "Authenticating…" splash forever. The splash-exit rAF below runs
  // unconditionally — any error here surfaces in the console where it can
  // actually be diagnosed, rather than being hidden behind a hung splash.
  let permalinkMatch = null;
  try {
    state.screen = 'tab-shell';
    state.activeTab = currentUser ? 'saucebook' : 'browse';
    permalinkMatch = location.pathname.match(/^\/sauce\/([^\/]+)\/?$/);
    if (permalinkMatch) {
      openRecipePermalink(decodeURIComponent(permalinkMatch[1]), { push: false });
    } else {
      render();
    }
  } catch (err) {
    console.error('[sauceboss] post-auth render failed', err);
  }

  // Background loads (non-blocking). browseEnsureLoaded is idempotent — safe
  // to call here even though setActiveTab('browse') would also fire it.
  browseEnsureLoaded();
  loadFilterLookups();
  // Pantry load already kicked off in Phase 2 for logged-in users; start it
  // here only if the user signed in between phases (e.g. via onAuthStateChange
  // firing after awaitInitialAuth resolved).
  if (currentUser && !state.pantry._loaded && !state.pantry.loading) loadPantry();

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
      // Pin the hero pot's animation off before lifting splash--exiting,
      // otherwise the .hero-illustration { animation: fadeIn ... } rule
      // re-triggers and the pot fades in from 0 again.
      const heroNow = document.getElementById('hero-illustration');
      if (heroNow) heroNow.style.animation = 'none';
      document.body.classList.remove('splash--exiting');
    }, 750);
  });

  // Replace-state with the tab id when on the tab-shell, so reload + back
  // restore the right tab. Otherwise use the screen name (existing behavior).
  // Skip this when booting from a `/sauce/<id>` permalink — that flow
  // manages its own URL via openRecipePermalink.
  if (!permalinkMatch) {
    history.replaceState(
      { screen: state.screen, tab: state.activeTab, sb: true },
      '',
      state.screen === 'tab-shell' ? '#' + state.activeTab : '#' + state.screen,
    );
  }

  window.addEventListener('popstate', (e) => {
    // The URL is the source of truth for permalinks — popstate may arrive
    // before state was attached (e.g. when going forward into an entry we
    // never pushState'd ourselves), so match on pathname first.
    const m = location.pathname.match(/^\/sauce\/([^\/]+)\/?$/);
    if (m) {
      openRecipePermalink(decodeURIComponent(m[1]), { push: false });
      return;
    }
    if (!e.state || !e.state.sb) return;
    if (e.state.screen === 'tab-shell' && e.state.tab) {
      setActiveTab(e.state.tab, { silent: true });
    } else if (e.state.screen) {
      navigate(e.state.screen, { push: false });
    }
  });

  const appEl = document.getElementById('app');

  installSwipeHandlers(appEl);

  // Close the recipe share menu when the user clicks anywhere outside it.
  // Clicks inside `.share-menu` (the toggle button or a menu item) are
  // ignored — those handle their own state via the dedicated onclicks.
  document.addEventListener('click', e => {
    if (!state.shareMenuOpen) return;
    if (e.target.closest('.share-menu')) return;
    closeShareMenu();
  });

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
      return;
    }
    const editorPick = e.target.closest('.ac-item[data-ing-editor-pick]');
    if (editorPick) {
      e.preventDefault();
      builderPickIngEditorAutocomplete(editorPick.dataset.ingEditorPick);
    }
  });

  // Category classification: click chip
  appEl.addEventListener('click', e => {
    const catChip = e.target.closest('.builder-chip[data-classify-cat]');
    if (catChip) {
      const si = parseInt(catChip.dataset.step);
      const ii = parseInt(catChip.dataset.ing);
      builderClassifyIngredient(si, ii, catChip.dataset.classifyCat);
      return;
    }
    const editorCat = e.target.closest('.builder-chip[data-ing-editor-classify]');
    if (editorCat) {
      builderClassifyIngEditor(editorCat.dataset.ingEditorClassify);
      return;
    }
    const editorAction = e.target.closest('[data-ing-editor-action]');
    if (editorAction) {
      const action = editorAction.dataset.ingEditorAction;
      if (action === 'save')   builderSaveIngEditor();
      if (action === 'cancel') builderCancelIngEditor();
      return;
    }
    // Step-input editor (bottom sheet) — backdrop / handle / × / Cancel / Save.
    const stepInputAction = e.target.closest('[data-step-input-action]');
    if (stepInputAction) {
      const action = stepInputAction.dataset.stepInputAction;
      if (action === 'save')   builderSaveStepInputEditor();
      if (action === 'cancel') builderCancelStepInputEditor();
      return;
    }
    // Step-input toggle row inside the sheet body.
    const stepInputToggle = e.target.closest('[data-step-input-toggle]');
    if (stepInputToggle) {
      builderToggleStepInputDraft(parseInt(stepInputToggle.dataset.stepInputToggle));
      return;
    }
    // Ingredient list actions on the instructions screen — chip tap, edit
    // button, remove button, and the "+ Add ingredient" CTA all route here.
    // Delegated rather than inline `onclick` so they survive re-render and
    // can't break when a function name isn't in scope at click time.
    const ingAction = e.target.closest('[data-builder-action]');
    if (ingAction) {
      const action = ingAction.dataset.builderAction;
      const si = parseInt(ingAction.dataset.step);
      const ii = parseInt(ingAction.dataset.ing);
      if (action === 'ing-add')    { builderOpenIngEditor(si, -1); return; }
      if (action === 'ing-edit')   { builderOpenIngEditor(si, ii); return; }
      if (action === 'ing-remove') { e.stopPropagation(); builderRemoveIngredient(si, ii); return; }
      if (action === 'step-input-add' || action === 'step-input-edit') {
        builderOpenStepInputEditor(si);
        return;
      }
      if (action === 'step-input-remove') {
        e.stopPropagation();
        builderClearStepInputs(si);
        return;
      }
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
            <div class="builder-chip-row">
              ${CATEGORY_ORDER.map(cat =>
                `<button class="builder-chip" data-classify-cat="${cat}" data-step="${si}" data-ing="${ii}">${cat}</button>`
              ).join('')}
            </div>`;
          wrap.appendChild(div);
        }
      }
    }
  });

  // Esc closes whichever builder bottom-sheet is open.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !state.builder) return;
    if (state.builder._ingEditor)       builderCancelIngEditor();
    else if (state.builder._stepInputEditor) builderCancelStepInputEditor();
  });
});
