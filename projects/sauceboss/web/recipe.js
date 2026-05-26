'use strict';

// Unified recipe view — handles both standalone (Browse / Saucebook / Sauce
// Manager) and meal-builder flows. When state.meal has item + sauce, the dish
// prep block is shown after the ingredient section. Otherwise it's sauce-only.
function renderRecipe() {
  const sauce = state.selectedSauce;

  // Meal-builder context: if the user arrived via the meal flow, state.meal
  // has all three pieces. If they came from Browse / Saucebook / Sauce
  // Manager, selectedItem is null and meal.sauce is absent.
  const isMeal = !!(state.meal && state.meal.item && state.meal.sauce);
  const item = isMeal ? state.meal.item : null;
  const prep = isMeal ? state.meal.prep : null;

  // Substitution banner for disabled ingredients
  const disabledInRecipe = sauce.ingredients
    .filter(i => state.disabledIngredients.has(i.name))
    .map(i => ({ name: i.name, sub: getSubstitutionText(i.name) }))
    .filter(i => i.sub);
  const subBannerHTML = disabledInRecipe.length > 0 ? `
    <div class="sub-banner">
      <strong>Ingredient swaps</strong>
      ${disabledInRecipe.map(i => `<div>${capitalizeIngredient(i.name)} → <strong>${capitalizeIngredient(i.sub)}</strong></div>`).join('')}
    </div>` : '';

  // Saucebook toggle
  const inSaucebook = !!(currentUser && (state.saucebook || []).some(s => s.id === sauce.id));
  const saucebookActionHTML = `
    <div class="recipe-action">
      ${inSaucebook
        ? `<button class="recipe-action-btn recipe-action-btn--active" onclick="recipeToggleSaucebook('${sauce.id}')" title="Remove from saucebook"><i data-lucide="bookmark-check"></i></button>`
        : `<button class="recipe-action-btn" onclick="recipeToggleSaucebook('${sauce.id}')" title="Save to saucebook"><i data-lucide="bookmark-plus"></i></button>`}
      <span class="recipe-action-label">${inSaucebook ? 'Saved' : 'Save'}</span>
    </div>`;

  // Source link — only when the recipe was imported from a URL. <a> rather
  // than a <button>+window.open so middle-click / cmd-click / "open in new
  // tab" work normally.
  const sourceActionHTML = sauce.sourceUrl
    ? `<div class="recipe-action">
         <a class="recipe-action-btn" href="${escapeHtml(sauce.sourceUrl)}" target="_blank" rel="noopener noreferrer" title="View original recipe"><i data-lucide="external-link"></i></a>
         <span class="recipe-action-label">Source</span>
       </div>`
    : '';

  // Cooking mode — Wake Lock API holds the screen on while the user follows
  // the recipe. Hidden in browsers without the API (older Safari, some in-app
  // browsers) since a non-functional toggle would just confuse users.
  // On-state pairs --active (orange fallback) with --cooking-on (yellow halo)
  // so the lightbulb reads as unmistakably "on".
  const cookingOnClasses = state.cookingMode ? ' recipe-action-btn--active recipe-action-btn--cooking-on' : '';
  const cookingActionHTML = cookingModeAvailable()
    ? `<div class="recipe-action">
         <button class="recipe-action-btn${cookingOnClasses}" onclick="recipeToggleCookingMode()" title="${state.cookingMode ? 'Turn off cooking mode' : 'Keep screen on while cooking'}"><i data-lucide="lightbulb"></i></button>
         <span class="recipe-action-label">Cooking</span>
       </div>`
    : '';

  // Share menu — replaces the old standalone download. Opens a popover with
  // two options: copy the permalink (via navigator.share when supported,
  // clipboard fallback otherwise) and download the .md export.
  const exportUrl = `${API}/api/v1/sauceboss/sauces/${encodeURIComponent(sauce.id)}/export.md`;
  const shareMenuHTML = state.shareMenuOpen ? `
    <div class="share-menu__dropdown" role="menu">
      <button class="share-menu__item" role="menuitem" onclick="shareRecipeLink()">
        <i data-lucide="link"></i><span>Copy link</span>
      </button>
      <a class="share-menu__item" role="menuitem" href="${exportUrl}" download onclick="closeShareMenu()">
        <i data-lucide="download"></i><span>Download (.md)</span>
      </a>
    </div>` : '';
  const shareActionHTML = `
    <div class="recipe-action">
      <div class="share-menu">
        <button class="recipe-action-btn${state.shareMenuOpen ? ' recipe-action-btn--active' : ''}" onclick="toggleShareMenu(event)" title="Share recipe" aria-haspopup="menu" aria-expanded="${state.shareMenuOpen}"><i data-lucide="share-2"></i></button>
        ${shareMenuHTML}
      </div>
      <span class="recipe-action-label">Share</span>
    </div>`;

  // Always use colored-tag meal-section style for sauce steps
  const isMarinade = sauce.sauceType === 'marinade';
  const sauceColor = (SAUCE_TYPE_META[sauce.sauceType] || SAUCE_TYPE_META.sauce).sectionLabel;
  const sauceLabel = isMeal
    ? `${flowMetaFor(item).sauceWord} — ${sauce.name}`
    : `Sauce — ${sauce.name}`;
  const sauceSection = `
    <div class="meal-section">
      <div class="meal-section-label" style="background:${sauceColor}">${sauceLabel}</div>
      ${sauce.steps.map((step, i) => renderRecipeStep(step, i, sauce.steps)).join('')}
    </div>`;
  let stepsHTML;
  if (isMeal) {
    const itemBlock = renderItemPrepBlock(item, prep, sauce);
    stepsHTML = isMarinade
      ? sauceSection + itemBlock
      : itemBlock + sauceSection;
  } else {
    stepsHTML = sauceSection;
  }

  return `
    ${renderAppHeader({
      title: sauce.name,
      auth: false,
      manage: 'never',
      secondRow: cookingActionHTML + saucebookActionHTML + shareActionHTML + sourceActionHTML,
    })}
    <div class="scroll-body scroll-body--padded">
      ${renderVariantSwitcher(sauce.id)}
      ${renderRecipeControls()}
      ${renderRecipeIngredientPanel(sauce)}
      ${subBannerHTML}
      ${stepsHTML}
      ${renderRecipeAuthorFootnote(sauce)}
    </div>
  `;
}

// Author credit at the bottom of the recipe. The Edit button is gated on
// authorship — only the user whose id matches sauce.createdBy sees it.
// openBuilderEdit() (settings.js) is the existing owner-or-admin edit
// gate; we keep its admin behaviour intact but only surface the button
// here to the actual author.
function renderRecipeAuthorFootnote(sauce) {
  const name = (sauce.authorName || '').trim();
  if (!name) return '';
  const isOwner = !!(currentUser && sauce.createdBy && sauce.createdBy === currentUser.id);
  const editBtn = isOwner
    ? `<button class="recipe-edit-btn" onclick="openBuilderEdit('${sauce.id}')" title="Open this recipe in the editor"><i data-lucide="pencil"></i><span>Edit recipe</span></button>`
    : '';
  return `
    <footer class="recipe-footnote">
      <span class="recipe-footnote__author">Authored by ${escapeHtml(name)}</span>
      ${editBtn}
    </footer>`;
}

// ── Sauce-family fetch + cache ────────────────────────────────────────────
// Recipe-open paths (permalink, saucebook tap, browse tap) all need the
// same data: the target sauce plus its variant family. Goes through
// /sauces/{id} (sauceFamily) instead of the global /sauces list so opening
// one recipe doesn't pull every sauce in the DB. Local 1h TTL cache keeps
// re-opens instant; mutations invalidate via invalidateSauceFamilyCache().
const SAUCE_FAMILY_TTL_MS = 60 * 60 * 1000;

async function loadSauceFamily(sauceId) {
  const cached = sbCache.get('sauce-family', sauceId, SAUCE_FAMILY_TTL_MS);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return cached.map(SBShared.filter.withIngredientNames);
  }
  const fresh = await api.sauceFamily(sauceId);
  // Sets don't survive JSON.stringify; strip the derived ingredientNames
  // before storing. withIngredientNames re-derives it from ingredients[]
  // when the entry is read back out.
  const forCache = fresh.map((s) => {
    const { ingredientNames: _drop, ...rest } = s;
    return rest;
  });
  sbCache.set('sauce-family', sauceId, forCache);
  return fresh;
}

function invalidateSauceFamilyCache(sauceId) {
  if (sauceId) {
    sbCache.delete('sauce-family', sauceId);
  } else {
    sbCache.clear('sauce-family');
  }
}

// Activate the recipe view for `found` against its family. Pure state mutation
// + navigation — used by all three openers below after they've resolved the
// sauce list.
function _enterRecipeView(found, family, navOpts) {
  state.selectedSauce = found;
  state.servings = found.defaultServings || 2;
  state.selectedSauceFamily = family.length ? family : [found];
  state.hiddenPieSlices = {};
  state.selectedItem = null;
  state.meal = { item: null, prep: null, sauce: null };
  state.recipeReturnTo = 'tab-shell';
  navigate('recipe', { path: '/sauce/' + encodeURIComponent(found.id), ...navOpts });
}

// Load a sauce by id and open the recipe view. Used by the boot path when
// the URL is a `/sauce/<id>` permalink, and by popstate when the user
// navigates back/forward into a recipe entry.
function openRecipePermalink(sauceId, opts = {}) {
  const { push = true } = opts;
  state.loading = 'Loading recipe…';
  render();
  loadSauceFamily(sauceId).then((family) => {
    state.loading = null;
    const found = family.find(s => s.id === sauceId);
    if (!found) {
      // Unknown id — drop the user on the default tab and clear the URL so
      // a stale permalink doesn't trap them on an empty screen.
      state.activeTab = currentUser ? 'saucebook' : 'browse';
      state.screen = 'tab-shell';
      history.replaceState(
        { screen: 'tab-shell', tab: state.activeTab, sb: true },
        '', '#' + state.activeTab,
      );
      render();
      return;
    }
    _enterRecipeView(found, family, { push, replace: !push });
  }).catch(err => {
    state.loading = null;
    console.warn('[sauceboss] recipe permalink load failed:', err);
    state.activeTab = currentUser ? 'saucebook' : 'browse';
    state.screen = 'tab-shell';
    history.replaceState(
      { screen: 'tab-shell', tab: state.activeTab, sb: true },
      '', '#' + state.activeTab,
    );
    render();
  });
}

function setServings(n) {
  state.servings = Math.max(1, Math.min(12, n));
  render();
}

function toggleShareMenu(e) {
  // Stop the click from bubbling to the document-level outside-close handler
  // installed in init.js — otherwise the menu would open and immediately close.
  if (e) e.stopPropagation();
  state.shareMenuOpen = !state.shareMenuOpen;
  render();
}

function closeShareMenu() {
  if (!state.shareMenuOpen) return;
  state.shareMenuOpen = false;
  render();
}

async function shareRecipeLink() {
  const sauce = state.selectedSauce;
  closeShareMenu();
  if (!sauce) return;
  const url = `${location.origin}/sauce/${encodeURIComponent(sauce.id)}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: sauce.name, text: `Recipe: ${sauce.name}`, url });
      return;
    } catch (err) {
      // User cancelled the native sheet — don't fall through to clipboard.
      if (err && err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied');
  } catch (_) {
    showToast("Couldn't copy link");
  }
}

function setUnitSystem(sys) {
  state.unitSystem = sys;
  render();
}

async function recipeToggleSaucebook(sauceId) {
  if (!currentUser) { openAuthModal(); return; }
  const inSaucebook = (state.saucebook || []).some(s => s.id === sauceId);
  if (inSaucebook) {
    try {
      await api.removeFromSaucebook(sauceId);
    } catch (err) {
      alert(`Couldn't remove: ${err.message || err}`);
      return;
    }
    state.saucebook = (state.saucebook || []).filter(s => s.id !== sauceId);
  } else {
    try {
      await api.addToSaucebook(sauceId);
    } catch (err) {
      alert(`Couldn't save: ${err.message || err}`);
      return;
    }
    // Re-fetch saucebook to get the full envelope
  }
  // Saucebook membership is baked into the cached envelope's `inSaucebook`
  // field; drop the cache so the next open reflects the new state.
  invalidateSauceFamilyCache(sauceId);
  refreshSaucebookAndPantry();
  render();
}

// ── Cooking mode (screen wake lock) ───────────────────────────────────────
// Per-recipe toggle. The Wake Lock API releases automatically when the tab
// goes background; we re-acquire on visibilitychange so resuming a backgrounded
// tab still keeps the screen on if cooking mode is on. Releases on every
// recipe-screen exit (navigate, popstate, render-to-other-screen).
let _cookingWakeLock = null;

function cookingModeAvailable() {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

async function _requestWakeLock() {
  if (!cookingModeAvailable()) return false;
  try {
    _cookingWakeLock = await navigator.wakeLock.request('screen');
    _cookingWakeLock.addEventListener('release', () => { _cookingWakeLock = null; });
    return true;
  } catch (err) {
    console.warn('[sauceboss] wake lock request failed:', err);
    return false;
  }
}

function _releaseWakeLock() {
  if (!_cookingWakeLock) return;
  const lock = _cookingWakeLock;
  _cookingWakeLock = null;
  lock.release().catch(() => {});
}

async function recipeToggleCookingMode() {
  if (state.cookingMode) {
    state.cookingMode = false;
    _releaseWakeLock();
    render();
    return;
  }
  const ok = await _requestWakeLock();
  state.cookingMode = ok;
  render();
}

// Re-acquire the lock when the tab becomes visible again — browsers release
// screen locks when the tab is hidden, but the user's cookingMode preference
// is still on.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.cookingMode && !_cookingWakeLock) {
      _requestWakeLock().then((ok) => {
        // If reacquire failed (rare), drop the user-visible toggle so it
        // doesn't lie about the state.
        if (!ok) { state.cookingMode = false; render(); }
      });
    }
  });
}

// Auto-release whenever the user leaves the recipe screen (back nav, tab
// switch, anything that changes state.screen). render() runs on every state
// flip so this is a cheap guard.
function _releaseWakeLockIfOffRecipe() {
  if (state.screen !== 'recipe' && (state.cookingMode || _cookingWakeLock)) {
    state.cookingMode = false;
    _releaseWakeLock();
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('sb:rendered', _releaseWakeLockIfOffRecipe);
}
