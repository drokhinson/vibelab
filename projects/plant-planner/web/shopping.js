// shopping.js — plant-shopping step + builder shortlist sidebar.
//
// Phase 1 of the plant-first refactor. After the wizard creates a planter
// with its conditions, we land here: a Pinterest-style grid of plants whose
// hardiness, sunlight, and watering match the planter. The user picks the
// ones they want; their shortlist is saved on the garden, and they continue
// to the placement step where the same shortlist becomes the builder's
// sidebar.
//
// All plant data is read from `plantplanner_plant_cache` via /catalog/search.
// The route is cache-first; lazy-fills from Trefle/Perenual on misses.

// ── Module state ────────────────────────────────────────────────────────────

var shoppingState = {
  gardenId: null,                  // Active garden id (we save the shortlist back here).
  garden: null,                    // Hydrated garden record (conditions live here).
  query: '',                       // Free-text search.
  plants: [],                      // Last result set from /catalog/search.
  loading: false,
  fillPending: false,              // True while the API is filling the cache for this query.
  shortlist: new Set(),            // Cache plant ids the user has heart'd.
  detailPlant: null,               // Plant whose detail panel is open (null = closed).
  // Loading-orchestration state for new planters. Each step reports its own
  // status / counts / error so the to-do list can render incrementally.
  fillSteps: null,                 // Array<FillStep> | null when not running.
  fillFinished: false,             // True once all 5 steps have settled.
};

// Step blueprints — order matches the user-facing to-do list. `key` matches
// what `_runFillStep` updates so the renderer can look up state.
var FILL_STEP_BLUEPRINTS = [
  { key: 'save',       label: 'Saving planter to your library' },
  { key: 'perenual',   label: 'Loading filtered plant list from Perenual' },
  { key: 'trefle',     label: 'Filling supplementary growth data from Trefle (height, pH, days to harvest…)' },
  { key: 'flora',      label: 'Updating supplemental info from FloraAPI' },
  { key: 'compatible', label: 'Gathering plants compatible with your planter' }
];


// ── Wizard exit (from the review step) + reopen-from-builder ────────────────
//
// `opts.runFillSequence` flips the loading-orchestration on. Pass it for
// freshly-created planters so the user sees the API to-do list. Existing
// planters reopened via "Add more plants" skip straight to the grid.

async function openShoppingForGarden(gardenId, opts) {
  opts = opts || {};
  shoppingState.gardenId = gardenId;
  shoppingState.query = '';
  shoppingState.plants = [];
  shoppingState.loading = true;
  shoppingState.shortlist = new Set();
  shoppingState.detailPlant = null;
  shoppingState.fillSteps = null;
  shoppingState.fillFinished = false;
  currentView = 'shopping';

  app.innerHTML = '<div class="flex flex-col items-center justify-center py-12 text-base-content/50 gap-3"><span class="loading loading-spinner loading-md text-primary"></span>Loading planter…</div>';
  try {
    var garden = await apiFetch('/gardens/' + gardenId);
    shoppingState.garden = garden;
    shoppingState.shortlist = new Set(garden.shortlist_plant_cache_ids || []);
    if (opts.runFillSequence) {
      // Render the to-do list and run the API orchestration. The user's
      // "Continue" click on completion drives the rest of the flow via
      // `_finishFillAndShowGrid`; we return early here.
      _runFillSequence();
      return;
    }
    await _refreshShoppingResults();
    _renderShoppingView();
  } catch (err) {
    app.innerHTML = '<div class="error-banner">Could not load planter: ' + escapeHtml(err.message || String(err)) + '</div>';
  }
}

async function _finishFillAndShowGrid() {
  shoppingState.fillSteps = null;
  shoppingState.fillFinished = false;
  app.innerHTML = '<div class="flex flex-col items-center justify-center py-12 text-base-content/50 gap-3"><span class="loading loading-spinner loading-md text-primary"></span>Loading plants…</div>';
  try {
    await _refreshShoppingResults();
    _renderShoppingView();
  } catch (err) {
    app.innerHTML = '<div class="error-banner">Could not load plants: ' + escapeHtml(err.message || String(err)) + '</div>';
  }
}


// ── Loading orchestration ───────────────────────────────────────────────────

async function _runFillSequence() {
  // Initialize each step with status="pending" so the renderer has something
  // to draw while we wait for the first network call.
  shoppingState.fillSteps = FILL_STEP_BLUEPRINTS.map(function(s) {
    return { key: s.key, label: s.label, status: 'pending', detail: '' };
  });
  shoppingState.fillFinished = false;
  _renderFillProgress();

  // Step 1 (save) is implicit — the planter was POST'd before we got here.
  _setFillStep('save', { status: 'ok', detail: 'Saved to your planters.' });

  var body = _shoppingQueryParams();
  // /catalog/fill/* ignores the `query` param the search uses; pass everything
  // else through unchanged.
  delete body.query;

  await _runFillStep('perenual', '/catalog/fill/perenual', body, function(data) {
    var lines = [];
    if (data.fetched != null) lines.push('Fetched ' + data.fetched + ' plants from Perenual.');
    if (data.new_plants)      lines.push(data.new_plants + ' new plant(s) added to the catalog.');
    return lines.join(' ') || 'No matching plants returned.';
  });
  await _runFillStep('trefle', '/catalog/fill/trefle', body, function(data) {
    if (!data.fetched && !data.enriched) return 'No plants needed Trefle enrichment.';
    return 'Enriched ' + (data.enriched || 0) + ' of ' + (data.fetched || 0) + ' plant(s) with Trefle data.';
  });
  await _runFillStep('flora', '/catalog/fill/flora', body, function(data) {
    if (!data.fetched && !data.enriched) return 'No matching plants in Flora.';
    return 'Cross-referenced ' + (data.enriched || 0) + ' of ' + (data.fetched || 0) + ' plant(s) with Flora.';
  });
  await _runFillStep('compatible', '/catalog/fill/compatible', body, function(data) {
    return data.compatible_plants + ' plant(s) compatible with your planter.';
  });

  shoppingState.fillFinished = true;
  _renderFillProgress();
}

async function _runFillStep(key, path, body, formatDetail) {
  _setFillStep(key, { status: 'running' });
  try {
    var data = await apiFetch(path, { method: 'POST', body: body });
    if (data && data.status === 'error') {
      _setFillStep(key, { status: 'error', detail: data.error || 'Unknown error.' });
      return;
    }
    _setFillStep(key, { status: 'ok', detail: formatDetail ? formatDetail(data || {}) : '' });
  } catch (err) {
    _setFillStep(key, { status: 'error', detail: (err && err.message) || String(err) });
  }
}

function _setFillStep(key, patch) {
  if (!shoppingState.fillSteps) return;
  for (var i = 0; i < shoppingState.fillSteps.length; i++) {
    if (shoppingState.fillSteps[i].key === key) {
      Object.assign(shoppingState.fillSteps[i], patch);
      break;
    }
  }
  _renderFillProgress();
}

function _fillStepIcon(status) {
  if (status === 'ok')      return '<i data-lucide="check-circle-2" style="color:oklch(var(--su));"></i>';
  if (status === 'error')   return '<i data-lucide="alert-circle" style="color:oklch(var(--er));"></i>';
  if (status === 'running') return '<span class="loading loading-spinner loading-xs text-primary"></span>';
  return '<i data-lucide="circle" style="color:oklch(var(--bc) / 0.35);"></i>';
}

function _renderFillProgress() {
  var steps = shoppingState.fillSteps;
  if (!steps) return;
  var html = '<div class="shopping-fill-overlay">';
  html += '<div class="shopping-fill-card">';
  html += '<h3>Setting up your plant catalog</h3>';
  html += '<p class="shopping-fill-subtitle">Pulling plant data tailored to this planter\'s conditions.</p>';
  html += '<ul class="shopping-fill-list">';
  for (var i = 0; i < steps.length; i++) {
    var s = steps[i];
    html += '<li class="shopping-fill-item shopping-fill-item-' + s.status + '">';
    html +=   '<span class="shopping-fill-icon">' + _fillStepIcon(s.status) + '</span>';
    html +=   '<span class="shopping-fill-body">';
    html +=     '<span class="shopping-fill-label">' + escapeHtml(s.label) + '</span>';
    if (s.detail) {
      var cls = (s.status === 'error') ? 'shopping-fill-detail shopping-fill-detail-error' : 'shopping-fill-detail';
      html += '<span class="' + cls + '">' + escapeHtml(s.detail) + '</span>';
    }
    html +=   '</span>';
    html += '</li>';
  }
  html += '</ul>';
  if (shoppingState.fillFinished) {
    var anyError = steps.some(function(s) { return s.status === 'error'; });
    html += '<div class="shopping-fill-footer">';
    if (anyError) html += '<p class="shopping-fill-warn">Some steps had errors — you can still continue.</p>';
    html += '<button type="button" class="btn btn-primary gap-1" id="shopping-fill-continue">Continue to plant selection <i data-lucide="arrow-right" style="width:1em;height:1em"></i></button>';
    html += '</div>';
  }
  html += '</div></div>';
  app.innerHTML = html;
  _initIcons();

  if (shoppingState.fillFinished) {
    var btn = document.getElementById('shopping-fill-continue');
    if (btn) btn.onclick = function() { _finishFillAndShowGrid(); };
  }
}

function _shoppingQueryParams() {
  var g = shoppingState.garden;
  if (!g) return {};
  var params = {};
  if (g.shade_level)      params.shade_level      = g.shade_level;
  if (g.water_plan)       params.water_plan       = g.water_plan;
  if (g.usda_zone)        params.usda_zone        = g.usda_zone;
  if (g.planting_season)  params.planting_season  = g.planting_season;
  if (g.garden_type)      params.garden_type      = g.garden_type;
  if (g.grid_width)       params.grid_width       = g.grid_width;
  if (g.grid_height)      params.grid_height      = g.grid_height;
  if (shoppingState.query) params.query = shoppingState.query;
  return params;
}

async function _refreshShoppingResults() {
  shoppingState.loading = true;
  var params = _shoppingQueryParams();
  var qs = Object.keys(params)
    .map(function(k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');
  try {
    var data = await apiFetch('/catalog/search' + (qs ? '?' + qs : ''));
    shoppingState.plants = data.plants || [];
    shoppingState.fillPending = !!data.fill_triggered;
  } catch (err) {
    console.warn('[plant-planner] catalog search failed:', err);
    shoppingState.plants = [];
    shoppingState.fillPending = false;
  } finally {
    shoppingState.loading = false;
  }
}

function _renderShoppingView() {
  var g = shoppingState.garden;
  var html = '<div class="shopping-view">';
  html += '<div class="shopping-header">';
  html += '<button type="button" class="btn btn-ghost btn-sm gap-1" id="shopping-cancel"><i data-lucide="arrow-left" style="width:1em;height:1em"></i> Back to planters</button>';
  html += '<h3>Pick plants for ' + escapeHtml(g.name) + '</h3>';
  html += '<p class="shopping-subtitle">Choose what you want to grow. We\'ll save your shortlist and you can place them on the planter next.</p>';
  html += '<div class="shopping-conditions">';
  if (g.shade_level)  html += '<span class="cond-chip">' + sunlightIcon(g.shade_level) + ' ' + escapeHtml(sunlightLabel(g.shade_level)) + '</span>';
  if (g.water_plan)   html += '<span class="cond-chip">💧 ' + escapeHtml(waterPlanLabel(g.water_plan)) + '</span>';
  if (g.usda_zone)    html += '<span class="cond-chip">📍 ' + escapeHtml(g.location_label || ('Zone ' + g.usda_zone)) + '</span>';
  if (g.garden_type)  html += '<span class="cond-chip">' + plantertypeIcon(g.garden_type) + ' ' + escapeHtml(plantertypeLabel(g.garden_type)) + '</span>';
  html += '</div>';
  html += '<div class="shopping-search">';
  html += '<input type="search" id="shopping-query" placeholder="Search plants by name…" value="' + escapeHtml(shoppingState.query) + '" />';
  html += '</div>';
  html += '</div>';

  html += '<div class="shopping-grid" id="shopping-grid">' + _renderShoppingGrid() + '</div>';

  html += '<div id="shopping-detail-panel"></div>';

  html += '<div class="shopping-footer">';
  html += '<span class="shopping-count" id="shopping-count">' + _shortlistCountLabel() + '</span>';
  html += '<button type="button" class="btn btn-primary gap-1" id="shopping-continue">Continue to placement <i data-lucide="arrow-right" style="width:1em;height:1em"></i></button>';
  html += '</div>';

  html += '</div>';
  app.innerHTML = html;
  _bindShoppingEvents();
  _initIcons();
}

function _renderShoppingGrid() {
  if (shoppingState.loading) {
    return '<div class="shopping-loading"><span class="loading loading-spinner loading-md text-primary"></span> Searching the catalog…</div>';
  }
  if (!shoppingState.plants.length) {
    var emptyMsg = shoppingState.fillPending
      ? 'No matches yet — we\'re fetching new species in the background. Try again in a moment.'
      : 'No plants matched these conditions. Try a broader search term.';
    return '<div class="shopping-empty"><p>' + emptyMsg + '</p></div>';
  }

  var html = '';
  for (var i = 0; i < shoppingState.plants.length; i++) {
    var p = shoppingState.plants[i];
    var picked = shoppingState.shortlist.has(p.id);
    html += _renderShoppingCard(p, picked);
  }
  return html;
}

function _renderShoppingCard(plant, picked) {
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

  return ''
    + '<div class="shopping-card' + (picked ? ' picked' : '') + '" data-plant-id="' + plant.id + '">'
    +   '<div class="shopping-card-media">' + imgHtml + '</div>'
    +   '<div class="shopping-card-body">'
    +     '<div class="shopping-card-title">' + escapeHtml(name) + '</div>'
    +     (sub ? '<div class="shopping-card-sub"><i>' + escapeHtml(sub) + '</i></div>' : '')
    +     '<div class="shopping-card-bullets">' + bullets.map(escapeHtml).join(' · ') + '</div>'
    +   '</div>'
    +   '<button type="button" class="shopping-card-heart" data-plant-id="' + plant.id + '" aria-label="' + (picked ? 'Remove from shortlist' : 'Add to shortlist') + '">'
    +     '<i data-lucide="' + (picked ? 'heart' : 'heart') + '"' + (picked ? ' fill="currentColor"' : '') + '></i>'
    +   '</button>'
    + '</div>';
}

function _shoppingImageFor(plant, preferredSize) {
  if (!plant) return null;
  var order = preferredSize === 'thumbnail'
    ? ['thumbnail', 'medium', 'regular']
    : preferredSize === 'regular'
      ? ['regular', 'medium', 'thumbnail']
      : ['medium', 'regular', 'thumbnail'];
  for (var i = 0; i < order.length; i++) {
    var size = order[i];
    if (plant['image_' + size + '_path']) return plant['image_' + size + '_path'];
  }
  for (var j = 0; j < order.length; j++) {
    var s = order[j];
    if (plant['image_' + s + '_url']) return plant['image_' + s + '_url'];
  }
  return null;
}

function _shortlistCountLabel() {
  var n = shoppingState.shortlist.size;
  if (n === 0) return 'Tap the heart on plants you want to add to your planter.';
  return n === 1 ? '1 plant in your shortlist' : (n + ' plants in your shortlist');
}

function _bindShoppingEvents() {
  var cancel = document.getElementById('shopping-cancel');
  if (cancel) cancel.onclick = function() {
    if (confirm('Leave shopping? Your shortlist so far will be saved.')) {
      _saveShoppingShortlist().finally(function() { showView('gardens'); });
    }
  };

  var input = document.getElementById('shopping-query');
  if (input) {
    var debounce = null;
    input.oninput = function() {
      shoppingState.query = input.value.trim();
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async function() {
        await _refreshShoppingResults();
        var grid = document.getElementById('shopping-grid');
        if (grid) {
          grid.innerHTML = _renderShoppingGrid();
          _bindShoppingCardEvents();
          _initIcons();
        }
      }, 280);
    };
  }

  var cont = document.getElementById('shopping-continue');
  if (cont) cont.onclick = async function() {
    cont.disabled = true;
    cont.innerHTML = '<span class="loading loading-spinner loading-xs"></span> Saving…';
    try {
      await _saveShoppingShortlist();
      // Open the planter into the builder with the shortlist sidebar.
      openGarden(shoppingState.gardenId);
    } catch (err) {
      cont.disabled = false;
      cont.innerHTML = 'Continue to placement <i data-lucide="arrow-right" style="width:1em;height:1em"></i>';
      _initIcons();
      alert('Could not save shortlist: ' + (err.message || err));
    }
  };

  _bindShoppingCardEvents();
}

function _bindShoppingCardEvents() {
  // Card click → detail panel; heart → toggle shortlist.
  document.querySelectorAll('#shopping-grid .shopping-card').forEach(function(card) {
    card.onclick = function(e) {
      // Heart button stops propagation; everything else opens detail.
      if (e.target.closest('.shopping-card-heart')) return;
      var pid = card.dataset.plantId;
      var plant = shoppingState.plants.find(function(p) { return p.id === pid; });
      if (plant) _openShoppingDetailPanel(plant);
    };
  });
  document.querySelectorAll('#shopping-grid .shopping-card-heart').forEach(function(btn) {
    btn.onclick = function(e) {
      e.stopPropagation();
      var pid = btn.dataset.plantId;
      _toggleShortlist(pid);
    };
  });
}

function _toggleShortlist(plantId) {
  if (shoppingState.shortlist.has(plantId)) {
    shoppingState.shortlist.delete(plantId);
  } else {
    shoppingState.shortlist.add(plantId);
  }
  // Update just the affected card and the count without a full re-render.
  var card = document.querySelector('.shopping-card[data-plant-id="' + plantId + '"]');
  if (card) card.classList.toggle('picked');
  var counter = document.getElementById('shopping-count');
  if (counter) counter.textContent = _shortlistCountLabel();
}

async function _saveShoppingShortlist() {
  var ids = Array.from(shoppingState.shortlist);
  await apiFetch('/gardens/' + shoppingState.gardenId, {
    method: 'PUT',
    body: { shortlist_plant_cache_ids: ids }
  });
}

function _openShoppingDetailPanel(plant) {
  shoppingState.detailPlant = plant;
  var panel = document.getElementById('shopping-detail-panel');
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

  var picked = shoppingState.shortlist.has(plant.id);

  var html = '<div class="shopping-detail-overlay" id="shopping-detail-overlay"></div>';
  html += '<aside class="shopping-detail-panel" role="dialog">';
  html += '<button type="button" class="shopping-detail-close" id="shopping-detail-close" aria-label="Close"><i data-lucide="x"></i></button>';
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
  html += '<button type="button" class="btn btn-primary btn-block gap-1" id="shopping-detail-toggle">';
  html +=   '<i data-lucide="heart"' + (picked ? ' fill="currentColor"' : '') + '></i> ';
  html +=   (picked ? 'Remove from shortlist' : 'Add to shortlist');
  html += '</button>';
  html += '</div>';
  html += '</aside>';

  panel.innerHTML = html;
  _initIcons();

  document.getElementById('shopping-detail-overlay').onclick = _closeShoppingDetailPanel;
  document.getElementById('shopping-detail-close').onclick   = _closeShoppingDetailPanel;
  document.getElementById('shopping-detail-toggle').onclick  = function() {
    _toggleShortlist(plant.id);
    _openShoppingDetailPanel(plant);  // Refresh button label
  };
}

function _closeShoppingDetailPanel() {
  shoppingState.detailPlant = null;
  var panel = document.getElementById('shopping-detail-panel');
  if (panel) panel.innerHTML = '';
}


// ── Builder shortlist sidebar ───────────────────────────────────────────────
//
// Replaces the legacy catalog sidebar when the active garden has a populated
// shortlist. Each card is draggable onto the 2D scene; placed plants are
// shown with a checkmark.

function renderShortlistSidebar(garden) {
  var shortlist = garden.shortlist || [];
  var html = '<div class="shortlist-sidebar">';
  html += '<div class="shortlist-header">';
  html += '<h4><i data-lucide="heart" style="width:1em;height:1em"></i> Your shortlist</h4>';
  html += '<button type="button" class="btn btn-ghost btn-xs" id="shortlist-add-more"><i data-lucide="plus" style="width:1em;height:1em"></i> Add more</button>';
  html += '</div>';
  html += '<div class="shortlist-hint">Drag a plant onto the soil to place it. Tap a placed plant to remove it.</div>';
  html += '<div class="shortlist-list" id="shortlist-list">' + renderShortlistList(garden) + '</div>';
  html += '</div>';
  return html;
}

function renderShortlistList(garden) {
  var shortlist = garden.shortlist || [];
  if (!shortlist.length) {
    return '<div class="shortlist-empty">Your shortlist is empty. Tap “Add more” to pick plants.</div>';
  }
  var placedCacheIds = {};
  for (var i = 0; i < placements.length; i++) {
    var pid = placements[i].plantCacheId;
    if (pid) placedCacheIds[pid] = (placedCacheIds[pid] || 0) + 1;
  }
  var html = '';
  for (var j = 0; j < shortlist.length; j++) {
    var plant = shortlist[j];
    var img = _shoppingImageFor(plant, 'thumbnail');
    var name = plant.common_name || plant.scientific_name || 'Plant';
    var placedN = placedCacheIds[plant.id] || 0;
    html += '<div class="shortlist-tile" draggable="true" data-cache-id="' + plant.id + '">';
    html +=   '<div class="shortlist-tile-img">' + (img
                ? '<img src="' + escapeHtml(img) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'" />'
                : '<span class="shortlist-tile-emoji">' + (plant.emoji || '🌿') + '</span>') + '</div>';
    html +=   '<div class="shortlist-tile-name">' + escapeHtml(name) + '</div>';
    if (placedN > 0) html += '<span class="shortlist-tile-placed">×' + placedN + '</span>';
    html += '</div>';
  }
  return html;
}

function refreshShortlistSidebar() {
  if (!currentGarden || !Array.isArray(currentGarden.shortlist) || !currentGarden.shortlist.length) return;
  var listEl = document.getElementById('shortlist-list');
  if (listEl) listEl.innerHTML = renderShortlistList(currentGarden);
  bindShortlistEvents();
  _initIcons();
}

function bindShortlistEvents() {
  document.querySelectorAll('.shortlist-tile').forEach(function(tile) {
    tile.addEventListener('dragstart', function(e) {
      var cid = tile.dataset.cacheId;
      var plant = (currentGarden.shortlist || []).find(function(p) { return p.id === cid; });
      if (!plant) return;
      // Mark the dragged plant so the 2D drag handler can build a placement.
      var dragShape = Object.assign({}, plant, {
        __source: 'cache',
        spread_inches: plant.spread_cm ? Math.round(plant.spread_cm / 2.54) : 12
      });
      window.draggedPlant = dragShape;
      catalogDropHandled = false;
      try { e.dataTransfer.setData('text/plain', plant.id); } catch (_) {}
      tile.classList.add('dragging');
    });
    tile.addEventListener('dragend', function() {
      tile.classList.remove('dragging');
      // 2D drop handler clears draggedPlant on success; ensure we don't leak.
      setTimeout(function() { window.draggedPlant = null; }, 50);
    });
  });

  var addMore = document.getElementById('shortlist-add-more');
  if (addMore) addMore.onclick = function() {
    if (currentGarden && currentGarden.id) openShoppingForGarden(currentGarden.id);
  };
}
