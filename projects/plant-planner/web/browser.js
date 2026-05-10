// browser.js — "Plant Browser" view.
//
// Standalone catalog search, no garden context. Free-text query against
// /catalog/search; no wizard filters (shade/water/zone/size) so the user
// browses every cached species. Hearting a card calls POST /user_plants to
// add it to the library as a wishlist row, or DELETE to remove it.
//
// Reuses the .shopping-card / .shopping-grid / .shopping-detail-* CSS so
// look-and-feel matches the wizard's shopping step.

var browserState = {
  query: '',
  plants: [],                // Last result set from /catalog/search.
  loading: false,
  fillPending: false,
  // plant_cache_id -> user_plant_id for rows already in the library.
  // We need the user_plant_id to support DELETE on toggle-off.
  inLibrary: new Map(),
  busyIds: new Set(),        // Cache ids currently mid-POST/DELETE.
  detailPlant: null,
};


// ── Entry point ────────────────────────────────────────────────────────────

async function renderBrowser() {
  app.innerHTML = '<div class="flex flex-col items-center justify-center py-12 text-base-content/50 gap-3"><span class="loading loading-spinner loading-md text-primary"></span>Loading the catalog…</div>';
  browserState.loading = true;
  browserState.detailPlant = null;
  try {
    var results = await Promise.all([
      _refreshBrowserResults(),
      _refreshBrowserLibrary(),
    ]);
    void results;
  } catch (err) {
    app.innerHTML = '<div class="error-banner">Could not load the catalog: ' + escapeHtml(err.message || String(err)) + '</div>';
    return;
  }
  _renderBrowserView();
}


// ── Data ────────────────────────────────────────────────────────────────────

async function _refreshBrowserResults() {
  browserState.loading = true;
  var qs = browserState.query
    ? '?query=' + encodeURIComponent(browserState.query)
    : '';
  try {
    var data = await apiFetch('/catalog/search' + qs);
    browserState.plants = data.plants || [];
    browserState.fillPending = !!data.fill_triggered;
  } catch (err) {
    console.warn('[plant-planner] browser catalog search failed:', err);
    browserState.plants = [];
    browserState.fillPending = false;
  } finally {
    browserState.loading = false;
  }
}

async function _refreshBrowserLibrary() {
  try {
    var rows = (await apiFetch('/user_plants')) || [];
    browserState.inLibrary = new Map();
    for (var i = 0; i < rows.length; i++) {
      browserState.inLibrary.set(rows[i].plant_cache_id, rows[i].id);
    }
  } catch (err) {
    console.warn('[plant-planner] browser library fetch failed:', err);
    browserState.inLibrary = new Map();
  }
}


// ── Render ─────────────────────────────────────────────────────────────────

function _renderBrowserView() {
  var html = '<div class="shopping-view browser-view">';
  html += '<div class="shopping-header">';
  html += '<h3>Plant Browser</h3>';
  html += '<p class="shopping-subtitle">Browse every plant in our catalog. Tap the heart to save one to your planters.</p>';
  html += '<div class="shopping-search">';
  html += '<input type="search" id="browser-query" placeholder="Search plants by name…" value="' + escapeHtml(browserState.query) + '" />';
  html += '</div>';
  html += '</div>';

  html += '<div class="shopping-grid" id="browser-grid">' + _renderBrowserGrid() + '</div>';

  html += '<div id="browser-detail-panel"></div>';
  html += '</div>';

  app.innerHTML = html;
  _bindBrowserEvents();
  _initIcons();
}

function _renderBrowserGrid() {
  if (browserState.loading) {
    return '<div class="shopping-loading"><span class="loading loading-spinner loading-md text-primary"></span> Searching the catalog…</div>';
  }
  if (!browserState.plants.length) {
    var emptyMsg = browserState.fillPending
      ? 'No matches yet — we\'re fetching new species in the background. Try again in a moment.'
      : (browserState.query
          ? 'No plants matched "' + escapeHtml(browserState.query) + '". Try a different search.'
          : 'No plants in the catalog yet.');
    return '<div class="shopping-empty"><p>' + emptyMsg + '</p></div>';
  }

  var html = '';
  for (var i = 0; i < browserState.plants.length; i++) {
    var p = browserState.plants[i];
    var inLib = browserState.inLibrary.has(p.id);
    html += _renderBrowserCard(p, inLib);
  }
  return html;
}

function _renderBrowserCard(plant, inLib) {
  var name = plant.common_name || plant.scientific_name || 'Unnamed plant';
  var sub  = plant.scientific_name && plant.common_name && plant.scientific_name !== plant.common_name
              ? plant.scientific_name : '';
  var img  = _shoppingImageFor(plant, 'medium');
  var imgHtml = img
    ? '<img class="shopping-card-img" src="' + escapeHtml(img) + '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.parentElement.classList.add(\'no-img\')" />'
    : '<div class="shopping-card-img-placeholder">' + (plant.emoji || '🌿') + '</div>';

  var bullets = [];
  if (plant.sunlight) bullets.push('☀️ ' + plant.sunlight.replace(/_/g, ' '));
  if (plant.watering) bullets.push('💧 ' + plant.watering);
  if (plant.cycle)    bullets.push('🌱 ' + plant.cycle);
  if (plant.hardiness_min != null && plant.hardiness_max != null) bullets.push('Zone ' + plant.hardiness_min + '–' + plant.hardiness_max);
  if (plant.edible)   bullets.push('🥗 edible');

  var heartLabel = inLib ? 'Remove from your planters' : 'Add to your planters';
  return ''
    + '<div class="shopping-card' + (inLib ? ' picked' : '') + '" data-plant-id="' + plant.id + '">'
    +   '<div class="shopping-card-media">' + imgHtml + '</div>'
    +   '<div class="shopping-card-body">'
    +     '<div class="shopping-card-title">' + escapeHtml(name) + '</div>'
    +     (sub ? '<div class="shopping-card-sub"><i>' + escapeHtml(sub) + '</i></div>' : '')
    +     '<div class="shopping-card-bullets">' + bullets.map(escapeHtml).join(' · ') + '</div>'
    +   '</div>'
    +   '<button type="button" class="shopping-card-heart" data-plant-id="' + plant.id + '" aria-label="' + heartLabel + '">'
    +     '<i data-lucide="heart"' + (inLib ? ' fill="currentColor"' : '') + '></i>'
    +   '</button>'
    + '</div>';
}


// ── Events ─────────────────────────────────────────────────────────────────

function _bindBrowserEvents() {
  var input = document.getElementById('browser-query');
  if (input) {
    var debounce = null;
    input.oninput = function() {
      browserState.query = input.value.trim();
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async function() {
        await _refreshBrowserResults();
        var grid = document.getElementById('browser-grid');
        if (grid) {
          grid.innerHTML = _renderBrowserGrid();
          _bindBrowserCardEvents();
          _initIcons();
        }
      }, 280);
    };
  }
  _bindBrowserCardEvents();
}

function _bindBrowserCardEvents() {
  document.querySelectorAll('#browser-grid .shopping-card').forEach(function(card) {
    card.onclick = function(e) {
      if (e.target.closest('.shopping-card-heart')) return;
      var pid = card.dataset.plantId;
      var plant = browserState.plants.find(function(p) { return p.id === pid; });
      if (plant) _openBrowserDetailPanel(plant);
    };
  });
  document.querySelectorAll('#browser-grid .shopping-card-heart').forEach(function(btn) {
    btn.onclick = function(e) {
      e.stopPropagation();
      var pid = btn.dataset.plantId;
      _toggleBrowserLibrary(pid);
    };
  });
}

async function _toggleBrowserLibrary(plantCacheId) {
  if (browserState.busyIds.has(plantCacheId)) return;
  browserState.busyIds.add(plantCacheId);
  var existingId = browserState.inLibrary.get(plantCacheId);
  try {
    if (existingId) {
      await apiFetch('/user_plants/' + existingId, { method: 'DELETE' });
      browserState.inLibrary.delete(plantCacheId);
    } else {
      var row = await apiFetch('/user_plants', {
        method: 'POST',
        body: { plant_cache_id: plantCacheId, status: 'wishlist' },
      });
      if (row && row.id) browserState.inLibrary.set(plantCacheId, row.id);
    }
  } catch (err) {
    alert('Could not update your library: ' + (err.message || err));
    return;
  } finally {
    browserState.busyIds.delete(plantCacheId);
  }
  // Update just the affected card without a full re-render. Detail panel
  // (if open for this plant) also needs its button label/state refreshed.
  var card = document.querySelector('#browser-grid .shopping-card[data-plant-id="' + plantCacheId + '"]');
  var nowIn = browserState.inLibrary.has(plantCacheId);
  if (card) {
    card.classList.toggle('picked', nowIn);
    var btn = card.querySelector('.shopping-card-heart');
    if (btn) {
      btn.setAttribute('aria-label', nowIn ? 'Remove from your planters' : 'Add to your planters');
      btn.innerHTML = '<i data-lucide="heart"' + (nowIn ? ' fill="currentColor"' : '') + '></i>';
    }
    _initIcons();
  }
  if (browserState.detailPlant && browserState.detailPlant.id === plantCacheId) {
    _openBrowserDetailPanel(browserState.detailPlant);
  }
}


// ── Detail panel (mirrors shopping.js _openShoppingDetailPanel) ────────────

function _openBrowserDetailPanel(plant) {
  browserState.detailPlant = plant;
  var panel = document.getElementById('browser-detail-panel');
  if (!panel) return;
  var img = _shoppingImageFor(plant, 'regular');
  var sci = plant.scientific_name ? '<div class="shopping-detail-sci"><i>' + escapeHtml(plant.scientific_name) + '</i></div>' : '';
  var family = plant.family ? '<div class="shopping-detail-family">' + escapeHtml(plant.family) + '</div>' : '';
  var bullets = [];
  if (plant.sunlight)    bullets.push(['Sunlight', plant.sunlight.replace(/_/g, ' ')]);
  if (plant.watering)    bullets.push(['Water', plant.watering]);
  if (plant.cycle)       bullets.push(['Cycle', plant.cycle]);
  if (plant.hardiness_min != null && plant.hardiness_max != null) bullets.push(['Hardiness', 'Zone ' + plant.hardiness_min + '–' + plant.hardiness_max]);
  if (plant.height_min_cm != null || plant.height_max_cm != null) bullets.push(['Height', (plant.height_min_cm || '?') + '–' + (plant.height_max_cm || '?') + ' cm']);
  if (plant.days_to_harvest) bullets.push(['Days to harvest', String(plant.days_to_harvest)]);
  if (plant.edible)      bullets.push(['Edible', 'yes']);
  if (plant.toxicity)    bullets.push(['Toxicity', plant.toxicity]);
  if (plant.ph_min != null && plant.ph_max != null) bullets.push(['Soil pH', plant.ph_min + '–' + plant.ph_max]);

  var inLib = browserState.inLibrary.has(plant.id);

  var html = '<div class="shopping-detail-overlay" id="browser-detail-overlay"></div>';
  html += '<aside class="shopping-detail-panel" role="dialog">';
  html += '<button type="button" class="shopping-detail-close" id="browser-detail-close" aria-label="Close"><i data-lucide="x"></i></button>';
  if (img) html += '<div class="shopping-detail-hero"><img src="' + escapeHtml(img) + '" alt="" /></div>';
  html += '<div class="shopping-detail-body">';
  html += '<h3>' + escapeHtml(plant.common_name || plant.scientific_name || 'Plant') + '</h3>';
  html += sci + family;
  html += '<dl class="shopping-detail-bullets">';
  for (var i = 0; i < bullets.length; i++) {
    html += '<dt>' + escapeHtml(bullets[i][0]) + '</dt><dd>' + escapeHtml(bullets[i][1]) + '</dd>';
  }
  html += '</dl>';
  if (plant.sowing) html += '<p class="shopping-detail-sowing">' + escapeHtml(plant.sowing) + '</p>';
  html += '<button type="button" class="btn btn-primary btn-block gap-1" id="browser-detail-toggle">';
  html +=   '<i data-lucide="heart"' + (inLib ? ' fill="currentColor"' : '') + '></i> ';
  html +=   (inLib ? 'Remove from your planters' : 'Add to your planters');
  html += '</button>';
  html += '</div>';
  html += '</aside>';

  panel.innerHTML = html;
  _initIcons();

  document.getElementById('browser-detail-overlay').onclick = _closeBrowserDetailPanel;
  document.getElementById('browser-detail-close').onclick   = _closeBrowserDetailPanel;
  document.getElementById('browser-detail-toggle').onclick  = function() {
    _toggleBrowserLibrary(plant.id);
  };
}

function _closeBrowserDetailPanel() {
  browserState.detailPlant = null;
  var panel = document.getElementById('browser-detail-panel');
  if (panel) panel.innerHTML = '';
}
