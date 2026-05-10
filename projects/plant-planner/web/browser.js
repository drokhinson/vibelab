// browser.js — "Plant Browser" view.
//
// Standalone catalog search, no garden context. Free-text query + an optional
// collapsible filter panel (sunlight, watering, hardiness, cycle, edible)
// against /catalog/search. Each card has two action buttons:
//   • "Add to plant list"     → POST/PUT user_plants status=current
//   • "Add to favorite list"  → POST/PUT user_plants status=wishlist
// The two are mutually exclusive (UNIQUE on user_id+plant_cache_id), so a
// plant is in at most one list at a time. Tapping the same button when
// already in that status removes the row entirely (DELETE).
//
// Reuses the .shopping-card / .shopping-detail-* CSS so look-and-feel matches
// the wizard's shopping step.

var browserState = {
  query: '',
  plants: [],                // Last result set from /catalog/search.
  loading: false,
  fillPending: false,
  // plant_cache_id -> { id: user_plant_id, status: 'current'|'wishlist'|'former' }
  inLibrary: new Map(),
  busyIds: new Set(),        // Cache ids mid-mutate.
  detailPlant: null,
  filtersOpen: false,
  filters: {
    sunlight: null,          // full_sun | sun-part_shade | part_shade | full_shade
    watering: null,          // frequent | average | minimum | none
    usda_zone: '',           // free text (e.g. "6b")
    cycle: null,             // annual | perennial | biennial
    edible: false,           // true to require edible
  },
};

var BROWSER_FILTER_OPTIONS = {
  sunlight: [
    { value: 'full_sun',       label: 'Full sun',     icon: '☀️' },
    { value: 'sun-part_shade', label: 'Sun & part',   icon: '🌤️' },
    { value: 'part_shade',     label: 'Part shade',   icon: '⛅' },
    { value: 'full_shade',     label: 'Full shade',   icon: '☁️' },
  ],
  watering: [
    { value: 'frequent', label: 'Frequent', icon: '💧💧💧' },
    { value: 'average',  label: 'Average',  icon: '💧💧' },
    { value: 'minimum',  label: 'Minimum',  icon: '💧' },
    { value: 'none',     label: 'None' },
  ],
  cycle: [
    { value: 'annual',    label: 'Annual' },
    { value: 'perennial', label: 'Perennial' },
    { value: 'biennial',  label: 'Biennial' },
  ],
};


// ── Entry point ────────────────────────────────────────────────────────────

async function renderBrowser() {
  app.innerHTML = '<div class="flex flex-col items-center justify-center py-12 text-base-content/50 gap-3"><span class="loading loading-spinner loading-md text-primary"></span>Loading the catalog…</div>';
  browserState.loading = true;
  browserState.detailPlant = null;
  try {
    await Promise.all([
      _refreshBrowserResults(),
      _refreshBrowserLibrary(),
    ]);
  } catch (err) {
    app.innerHTML = '<div class="error-banner">Could not load the catalog: ' + escapeHtml(err.message || String(err)) + '</div>';
    return;
  }
  _renderBrowserView();
}


// ── Data ────────────────────────────────────────────────────────────────────

function _browserSearchParams() {
  var f = browserState.filters;
  return {
    query:     browserState.query,
    sunlight:  f.sunlight,
    watering:  f.watering,
    usda_zone: f.usda_zone,
    cycle:     f.cycle,
    edible:    f.edible || null,  // only send when true
  };
}

async function _refreshBrowserResults() {
  browserState.loading = true;
  var qs = _qs(_browserSearchParams());
  try {
    var data = await apiFetch('/catalog/search' + (qs ? '?' + qs : ''));
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
      var r = rows[i];
      browserState.inLibrary.set(r.plant_cache_id, { id: r.id, status: r.status });
    }
  } catch (err) {
    console.warn('[plant-planner] browser library fetch failed:', err);
    browserState.inLibrary = new Map();
  }
}

function _activeFilterCount() {
  var f = browserState.filters;
  var n = 0;
  if (f.sunlight)  n += 1;
  if (f.watering)  n += 1;
  if (f.usda_zone) n += 1;
  if (f.cycle)     n += 1;
  if (f.edible)    n += 1;
  return n;
}


// ── Render ─────────────────────────────────────────────────────────────────

function _renderBrowserView() {
  var html = '<div class="shopping-view browser-view">';
  html += '<div class="shopping-header">';
  html += '<h3>Plant Browser</h3>';
  html += '<p class="shopping-subtitle">Browse every plant in our catalog. Add a plant to your list, or save it as a favorite.</p>';

  html += '<div class="browser-controls">';
  html +=   '<input type="search" id="browser-query" class="browser-search-input" placeholder="Search plants by name…" value="' + escapeHtml(browserState.query) + '" />';
  html +=   '<button type="button" class="btn btn-sm btn-outline gap-1" id="browser-filters-toggle">'
       +     '<i data-lucide="sliders-horizontal" style="width:1em;height:1em"></i> '
       +     'Filters' + (_activeFilterCount() ? ' · ' + _activeFilterCount() : '')
       +   '</button>';
  html +=   '<button type="button" class="btn btn-sm btn-ghost gap-1" id="browser-import-btn" title="Pull more species from external APIs">'
       +     '<i data-lucide="download-cloud" style="width:1em;height:1em"></i> Import'
       +   '</button>';
  html += '</div>';

  if (browserState.filtersOpen) {
    html += _renderBrowserFilterPanel();
  }
  html += '</div>';

  html += '<div class="shopping-grid" id="browser-grid">' + _renderBrowserGrid() + '</div>';

  html += '<div id="browser-detail-panel"></div>';
  html += '</div>';

  app.innerHTML = html;
  _bindBrowserEvents();
  _initIcons();
}

function _renderBrowserFilterPanel() {
  var f = browserState.filters;
  var html = '<div class="browser-filter-panel">';
  html += renderFilterChipRow('Sunlight', BROWSER_FILTER_OPTIONS.sunlight, f.sunlight, 'sunlight');
  html += renderFilterChipRow('Watering', BROWSER_FILTER_OPTIONS.watering, f.watering, 'watering');
  html += renderFilterChipRow('Cycle',    BROWSER_FILTER_OPTIONS.cycle,    f.cycle,    'cycle');

  html += '<div class="filter-group">';
  html +=   '<div class="filter-group-label">Hardiness zone</div>';
  html +=   '<input type="text" id="browser-filter-zone" class="browser-zone-input"'
       +     ' placeholder="e.g. 6b" value="' + escapeHtml(f.usda_zone || '') + '" />';
  html += '</div>';

  html += '<div class="filter-group" data-filter-group="edible">';
  html +=   '<div class="filter-group-label">Edible</div>';
  html +=   '<div class="filter-row">';
  html +=     '<button type="button" class="chip toggle' + (f.edible ? ' active' : '') + '" data-filter-value="true">'
       +       '🥗 Edible only'
       +     '</button>';
  html +=   '</div>';
  html += '</div>';

  html += '<div class="browser-filter-actions">';
  html +=   '<button type="button" class="btn btn-ghost btn-xs" id="browser-filters-clear">Clear all</button>';
  html += '</div>';
  html += '</div>';
  return html;
}

function _renderBrowserGrid() {
  if (browserState.loading) {
    return '<div class="shopping-loading"><span class="loading loading-spinner loading-md text-primary"></span> Searching the catalog…</div>';
  }
  if (!browserState.plants.length) {
    var emptyMsg = browserState.fillPending
      ? 'No matches yet — we\'re fetching new species in the background. Try again in a moment.'
      : (browserState.query
          ? 'No plants matched "' + escapeHtml(browserState.query) + '". Try a different search or clear filters.'
          : 'No plants matched. Try clearing some filters.');
    return '<div class="shopping-empty"><p>' + emptyMsg + '</p></div>';
  }

  var html = '';
  for (var i = 0; i < browserState.plants.length; i++) {
    var p = browserState.plants[i];
    var entry = browserState.inLibrary.get(p.id) || null;
    html += _renderBrowserCard(p, entry);
  }
  return html;
}

function _renderBrowserCard(plant, entry) {
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

  var inCurrent  = !!(entry && entry.status === 'current');
  var inWishlist = !!(entry && entry.status === 'wishlist');
  var cardClasses = 'shopping-card browser-card'
                  + (inCurrent  ? ' picked'   : '')
                  + (inWishlist ? ' favorite' : '');

  return ''
    + '<div class="' + cardClasses + '" data-plant-id="' + plant.id + '">'
    +   '<div class="shopping-card-media">' + imgHtml + '</div>'
    +   '<div class="shopping-card-body">'
    +     '<div class="shopping-card-title">' + escapeHtml(name) + '</div>'
    +     (sub ? '<div class="shopping-card-sub"><i>' + escapeHtml(sub) + '</i></div>' : '')
    +     '<div class="shopping-card-bullets">' + bullets.map(escapeHtml).join(' · ') + '</div>'
    +   '</div>'
    +   '<div class="browser-card-actions">'
    +     '<button type="button" class="browser-action plant-action' + (inCurrent ? ' on' : '') + '"'
    +       ' data-plant-id="' + plant.id + '" data-action="current"'
    +       ' aria-label="' + (inCurrent ? 'Remove from plant list' : 'Add to plant list') + '"'
    +       ' title="' + (inCurrent ? 'In your plant list — tap to remove' : 'Add to plant list') + '">'
    +       '<i data-lucide="leaf"' + (inCurrent ? ' fill="currentColor"' : '') + '></i>'
    +     '</button>'
    +     '<button type="button" class="browser-action favorite-action' + (inWishlist ? ' on' : '') + '"'
    +       ' data-plant-id="' + plant.id + '" data-action="wishlist"'
    +       ' aria-label="' + (inWishlist ? 'Remove from favorites' : 'Add to favorites') + '"'
    +       ' title="' + (inWishlist ? 'In your favorites — tap to remove' : 'Add to favorites') + '">'
    +       '<i data-lucide="heart"' + (inWishlist ? ' fill="currentColor"' : '') + '></i>'
    +     '</button>'
    +   '</div>'
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
      debounce = setTimeout(_browserApplyAndRefresh, 280);
    };
  }

  var toggle = document.getElementById('browser-filters-toggle');
  if (toggle) toggle.onclick = function() {
    browserState.filtersOpen = !browserState.filtersOpen;
    _renderBrowserView();  // re-render to expand/collapse
  };

  var importBtn = document.getElementById('browser-import-btn');
  if (importBtn) importBtn.onclick = function() { showView('import'); };

  if (browserState.filtersOpen) {
    var panel = document.querySelector('.browser-filter-panel');
    bindFilterChipRow(panel, 'sunlight', function(v) {
      browserState.filters.sunlight = v;
      _browserApplyAndRefresh();
    });
    bindFilterChipRow(panel, 'watering', function(v) {
      browserState.filters.watering = v;
      _browserApplyAndRefresh();
    });
    bindFilterChipRow(panel, 'cycle', function(v) {
      browserState.filters.cycle = v;
      _browserApplyAndRefresh();
    });

    var zoneInput = document.getElementById('browser-filter-zone');
    if (zoneInput) {
      var zoneDebounce = null;
      zoneInput.oninput = function() {
        browserState.filters.usda_zone = zoneInput.value.trim();
        if (zoneDebounce) clearTimeout(zoneDebounce);
        zoneDebounce = setTimeout(_browserApplyAndRefresh, 320);
      };
    }

    var ediblePanel = panel && panel.querySelector('[data-filter-group="edible"]');
    if (ediblePanel) {
      ediblePanel.querySelectorAll('.chip').forEach(function(btn) {
        btn.onclick = function() {
          browserState.filters.edible = !browserState.filters.edible;
          _browserApplyAndRefresh();
        };
      });
    }

    var clearBtn = document.getElementById('browser-filters-clear');
    if (clearBtn) clearBtn.onclick = function() {
      browserState.filters = { sunlight: null, watering: null, usda_zone: '', cycle: null, edible: false };
      _browserApplyAndRefresh();
    };
  }

  _bindBrowserCardEvents();
}

async function _browserApplyAndRefresh() {
  await _refreshBrowserResults();
  // Re-render the whole view so the filter button's count + panel chip
  // states stay in sync with state (cheap; the grid is the heaviest part).
  _renderBrowserView();
}

function _bindBrowserCardEvents() {
  document.querySelectorAll('#browser-grid .shopping-card').forEach(function(card) {
    card.onclick = function(e) {
      if (e.target.closest('.browser-action')) return;
      var pid = card.dataset.plantId;
      var plant = browserState.plants.find(function(p) { return p.id === pid; });
      if (plant) _openBrowserDetailPanel(plant);
    };
  });
  document.querySelectorAll('#browser-grid .browser-action').forEach(function(btn) {
    btn.onclick = function(e) {
      e.stopPropagation();
      var pid = btn.dataset.plantId;
      var action = btn.dataset.action;  // 'current' | 'wishlist'
      _toggleBrowserList(pid, action);
    };
  });
}

async function _toggleBrowserList(plantCacheId, targetStatus) {
  if (browserState.busyIds.has(plantCacheId)) return;
  browserState.busyIds.add(plantCacheId);
  var existing = browserState.inLibrary.get(plantCacheId);
  try {
    if (existing && existing.status === targetStatus) {
      // Already in the requested list — remove the row entirely.
      await apiFetch('/user_plants/' + existing.id, { method: 'DELETE' });
      browserState.inLibrary.delete(plantCacheId);
    } else if (existing) {
      // Row exists but in a different status — flip it.
      var updated = await apiFetch('/user_plants/' + existing.id, {
        method: 'PUT',
        body: { status: targetStatus },
      });
      browserState.inLibrary.set(plantCacheId, { id: existing.id, status: updated.status });
    } else {
      // No row yet — create one in the target status.
      var row = await apiFetch('/user_plants', {
        method: 'POST',
        body: { plant_cache_id: plantCacheId, status: targetStatus },
      });
      // POST is idempotent and may return an existing row with a different
      // status; if so, follow up with a PUT to land on the target.
      if (row && row.status !== targetStatus) {
        var fixed = await apiFetch('/user_plants/' + row.id, {
          method: 'PUT',
          body: { status: targetStatus },
        });
        browserState.inLibrary.set(plantCacheId, { id: fixed.id, status: fixed.status });
      } else if (row) {
        browserState.inLibrary.set(plantCacheId, { id: row.id, status: row.status });
      }
    }
  } catch (err) {
    alert('Could not update your library: ' + (err.message || err));
    return;
  } finally {
    browserState.busyIds.delete(plantCacheId);
  }
  _refreshBrowserCard(plantCacheId);
  if (browserState.detailPlant && browserState.detailPlant.id === plantCacheId) {
    _openBrowserDetailPanel(browserState.detailPlant);
  }
}

function _refreshBrowserCard(plantCacheId) {
  var card = document.querySelector('#browser-grid .shopping-card[data-plant-id="' + plantCacheId + '"]');
  if (!card) return;
  var entry = browserState.inLibrary.get(plantCacheId) || null;
  var inCurrent  = !!(entry && entry.status === 'current');
  var inWishlist = !!(entry && entry.status === 'wishlist');
  card.classList.toggle('picked',   inCurrent);
  card.classList.toggle('favorite', inWishlist);
  var plantBtn = card.querySelector('.plant-action');
  var favBtn   = card.querySelector('.favorite-action');
  if (plantBtn) {
    plantBtn.classList.toggle('on', inCurrent);
    plantBtn.innerHTML = '<i data-lucide="leaf"' + (inCurrent ? ' fill="currentColor"' : '') + '></i>';
  }
  if (favBtn) {
    favBtn.classList.toggle('on', inWishlist);
    favBtn.innerHTML = '<i data-lucide="heart"' + (inWishlist ? ' fill="currentColor"' : '') + '></i>';
  }
  _initIcons();
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

  var entry = browserState.inLibrary.get(plant.id) || null;
  var inCurrent  = !!(entry && entry.status === 'current');
  var inWishlist = !!(entry && entry.status === 'wishlist');

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

  html += '<div class="browser-detail-actions">';
  html +=   '<button type="button" class="btn btn-block gap-1' + (inCurrent ? ' btn-primary' : ' btn-outline btn-primary') + '" id="browser-detail-plant">'
       +     '<i data-lucide="leaf"' + (inCurrent ? ' fill="currentColor"' : '') + '></i> '
       +     (inCurrent ? 'In your plant list' : 'Add to plant list')
       +   '</button>';
  html +=   '<button type="button" class="btn btn-block gap-1 mt-2' + (inWishlist ? ' btn-secondary' : ' btn-outline') + '" id="browser-detail-favorite">'
       +     '<i data-lucide="heart"' + (inWishlist ? ' fill="currentColor"' : '') + '></i> '
       +     (inWishlist ? 'In your favorites' : 'Add to favorites')
       +   '</button>';
  html += '</div>';

  html += '</div>';
  html += '</aside>';

  panel.innerHTML = html;
  _initIcons();

  document.getElementById('browser-detail-overlay').onclick = _closeBrowserDetailPanel;
  document.getElementById('browser-detail-close').onclick   = _closeBrowserDetailPanel;
  document.getElementById('browser-detail-plant').onclick   = function() { _toggleBrowserList(plant.id, 'current'); };
  document.getElementById('browser-detail-favorite').onclick = function() { _toggleBrowserList(plant.id, 'wishlist'); };
}

function _closeBrowserDetailPanel() {
  browserState.detailPlant = null;
  var panel = document.getElementById('browser-detail-panel');
  if (panel) panel.innerHTML = '';
}
