// catalog.js — Plant catalog sidebar rendering + drag source + detail panel

// ── Search debounce timer ──────────────────────────────────────────────────
var _catalogSearchDebounce = null;

// ── Click-vs-drag detection state ──────────────────────────────────────────
var _tilePressState = null; // { plantId, x, y, t }
var CLICK_MAX_PX = 5;
var CLICK_MAX_MS = 300;

function renderCatalogFilters() {
  var g = currentGarden || {};
  var hasGarden = !!currentGarden;

  // Header: title + match-toggle
  var html = '<div class="catalog-filters-title">'
           +   '<span><i data-lucide="leaf" style="width:0.9em;height:0.9em"></i> Plants</span>'
           +   (hasGarden
               ? '<label class="catalog-match-toggle">'
                 +   '<input type="checkbox" id="catalog-match-toggle"' + (catalogFilters.matchGarden ? ' checked' : '') + ' />'
                 +   '<span>Match my garden</span>'
                 + '</label>'
               : '')
           + '</div>';

  // Read-only conditions strip showing what "Match my garden" filters by.
  if (hasGarden) {
    var dim = catalogFilters.matchGarden ? '' : ' dim';
    html += '<div class="catalog-conditions' + dim + '">';
    html += '<span class="cond-chip">' + sunlightIcon(g.shade_level || 'full_sun') + ' ' + escapeHtml(sunlightLabel(g.shade_level || 'full_sun')) + '</span>';
    html += '<span class="cond-chip">💧 ' + escapeHtml(waterPlanLabel(g.water_plan || 'regular')) + '</span>';
    if (g.usda_zone) {
      html += '<span class="cond-chip">📍 ' + escapeHtml(g.location_label || ('Zone ' + g.usda_zone)) + '</span>';
    }
    html += '<span class="cond-chip">' + plantertypeIcon(g.garden_type || 'garden_bed') + ' ' + escapeHtml(plantertypeLabel(g.garden_type || 'garden_bed')) + '</span>';
    html += '</div>';
  }

  // Search
  var q = escapeHtml(catalogSearch || '');
  html += '<input id="catalog-search" class="catalog-search" type="search" autocomplete="off" placeholder="Search plants..." value="' + q + '" />';

  // Refinement: bloom season (multi)
  html += '<div class="filter-group"><div class="filter-group-label">Bloom season</div><div class="filter-row" id="filter-row-seasons">';
  for (var s = 0; s < FILTER_SEASONS.length; s++) {
    var so = FILTER_SEASONS[s];
    var active = !!(catalogFilters.seasons && catalogFilters.seasons[so.id]);
    html += '<button type="button" class="chip' + (active ? ' active' : '') + '" data-group="seasons" data-id="' + so.id + '">' + escapeHtml(so.label) + '</button>';
  }
  html += '</div></div>';

  // Refinement: type (multi)
  html += '<div class="filter-group"><div class="filter-group-label">Type</div><div class="filter-row" id="filter-row-types">';
  for (var t = 0; t < FILTER_TYPES.length; t++) {
    var to = FILTER_TYPES[t];
    var actT = !!(catalogFilters.types && catalogFilters.types[to.id]);
    html += '<button type="button" class="chip' + (actT ? ' active' : '') + '" data-group="types" data-id="' + to.id + '">' + escapeHtml(to.label) + '</button>';
  }
  html += '</div></div>';

  // Toggles row
  html += '<div class="filter-toggles">';
  html += '<button type="button" class="chip toggle' + (catalogFilters.native ? ' active' : '') + '" data-toggle="native"><i data-lucide="leaf" style="width:0.85em;height:0.85em"></i> Native to my region</button>';
  html += '<button type="button" class="chip toggle' + (catalogFilters.pollinators ? ' active' : '') + '" data-toggle="pollinators"><i data-lucide="bug" style="width:0.85em;height:0.85em"></i> Pollinators</button>';
  html += '</div>';

  return html;
}

function _pollinatorIconsHtml(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  var html = '<div class="pollinator-icons">';
  var n = Math.min(3, arr.length);
  for (var i = 0; i < n; i++) {
    var key = arr[i];
    var iconName = POLLINATOR_ICONS[key] || 'sparkles';
    html += '<i data-lucide="' + iconName + '" style="width:14px;height:14px"></i>';
  }
  html += '</div>';
  return html;
}

function _nativeBadgeHtml() {
  // Tiny inline Lucide-style leaf
  return '<span class="native-badge" title="Native"><i data-lucide="leaf" style="width:14px;height:14px"></i></span>';
}

function _companionBadgesForTile(plantId) {
  if (!placements || placements.length === 0) return '';
  var goodNames = [], badNames = [];
  for (var i = 0; i < placements.length; i++) {
    var placed = placements[i].plant;
    if (!placed || placed.id === plantId) continue;
    var rel = getCompanionRelationship(plantId, placed.id);
    if (rel === 'good' && goodNames.indexOf(placed.name) === -1) goodNames.push(placed.name);
    if (rel === 'bad'  && badNames.indexOf(placed.name)  === -1) badNames.push(placed.name);
  }
  var html = '';
  if (goodNames.length) html += '<span class="tile-companion-badge good" aria-label="Good with: ' + escapeHtml(goodNames.join(', ')) + '"><i data-lucide="leaf" style="width:10px;height:10px"></i></span>';
  if (badNames.length)  html += '<span class="tile-companion-badge bad"  aria-label="Avoid near: ' + escapeHtml(badNames.join(', '))  + '"><i data-lucide="alert-circle" style="width:10px;height:10px"></i></span>';
  return html;
}

function renderCatalogList() {
  var q = catalogSearch || '';
  var filtered = plants.filter(function(p) {
    return plantMatchesSearch(p, q) && plantMatchesFilters(p);
  });

  // Match-count summary so users see the impact of their filters.
  var html = '<div class="catalog-count">' + filtered.length + ' of ' + plants.length + ' plants</div>';
  html += '<div class="catalog-list">';
  for (var k = 0; k < filtered.length; k++) {
    var p = filtered[k];
    var pngUrl = (typeof _getPlantImageUrl === 'function') ? _getPlantImageUrl(p) : '';
    var fallbackUrl = 'assets/sprites/plants/_' + (p.category || 'flower') + '.png';
    var safeFallback = fallbackUrl.replace(/'/g, "\\'");
    html += '<div class="catalog-tile" draggable="true" data-plant-id="' + p.id + '" style="--i:' + k + '">';
    html += _companionBadgesForTile(p.id);
    if (p.native === true) html += _nativeBadgeHtml();
    html += '<img class="catalog-thumbnail" src="' + pngUrl + '" alt="' + escapeHtml(p.name) + '" draggable="false"'
         + ' onerror="this.onerror=null;this.src=\'' + safeFallback + '\'" />';
    html += '<span class="catalog-name">' + escapeHtml(p.name) + '</span>';
    html += _pollinatorIconsHtml(p.pollinator_attracts);
    html += '</div>';
  }
  if (filtered.length === 0) {
    html += '<div class="text-center text-sm py-4 opacity-50">No plants match filters</div>';
  }
  html += '</div>';
  return html;
}

function bindCatalogEvents() {
  // Search input — debounce 180ms
  var searchEl = document.getElementById("catalog-search");
  if (searchEl) {
    searchEl.oninput = function(e) {
      var v = e.target.value;
      if (_catalogSearchDebounce) clearTimeout(_catalogSearchDebounce);
      _catalogSearchDebounce = setTimeout(function() {
        catalogSearch = v;
        refreshCatalogList();
      }, 180);
    };
  }

  // "Match my garden" toggle
  var matchEl = document.getElementById('catalog-match-toggle');
  if (matchEl) {
    matchEl.onchange = function(e) {
      catalogFilters.matchGarden = !!e.target.checked;
      refreshCatalog();
    };
  }

  // Refinement chip rows (seasons, types) — event delegation per group
  ['filter-row-seasons', 'filter-row-types'].forEach(function(rowId) {
    var row = document.getElementById(rowId);
    if (!row) return;
    row.onclick = function(e) {
      var btn = e.target.closest('.chip');
      if (!btn) return;
      var group = btn.dataset.group;
      var id = btn.dataset.id;
      if (!group || !id) return;
      if (!catalogFilters[group]) catalogFilters[group] = {};
      catalogFilters[group][id] = !catalogFilters[group][id];
      btn.classList.toggle('active', !!catalogFilters[group][id]);
      refreshCatalogList();
    };
  });

  // Toggle chips: Native / Pollinators
  document.querySelectorAll('.chip.toggle').forEach(function(btn) {
    btn.onclick = function() {
      var key = btn.dataset.toggle;
      if (key === 'native' && !catalogFilters.native) {
        // Activating Native without a garden zone — open the location picker.
        if (!currentGarden || !currentGarden.usda_zone) {
          if (typeof openLocationPicker === 'function') {
            openLocationPicker({
              onResolve: async function(loc) {
                if (currentGarden && currentGarden.id) {
                  try {
                    await apiFetch('/gardens/' + currentGarden.id, {
                      method: 'PUT',
                      body: { usda_zone: loc.zone, location_label: loc.label }
                    });
                    currentGarden.usda_zone = loc.zone;
                    currentGarden.location_label = loc.label;
                  } catch (e) { console.warn('Save garden zone failed:', e); }
                }
                catalogFilters.native = true;
                refreshCatalog();
              }
            });
            return;
          }
        }
      }
      catalogFilters[key] = !catalogFilters[key];
      btn.classList.toggle('active', !!catalogFilters[key]);
      refreshCatalogList();
      // The conditions strip dim-state depends on matchGarden, but Native
      // doesn't change it. No full re-render needed.
    };
  });

  bindCatalogDrag();
}

function refreshCatalogList() {
  var listWrapper = document.getElementById("catalog-list-wrapper");
  if (listWrapper) listWrapper.innerHTML = renderCatalogList();
  bindCatalogDrag();
  _initIcons();
}

function refreshCatalog() {
  var sidebar = document.getElementById("catalog-sidebar");
  if (sidebar) {
    var filtersEl = sidebar.querySelector(".catalog-filters");
    if (filtersEl) filtersEl.innerHTML = renderCatalogFilters();
    var listWrapper = document.getElementById("catalog-list-wrapper");
    if (listWrapper) listWrapper.innerHTML = renderCatalogList();
  }
  bindCatalogEvents();
  bindCatalogDrag();
  _initIcons();
}

function bindCatalogDrag() {
  document.querySelectorAll(".catalog-tile").forEach(function(tile) {
    // Click-vs-drag detection: a "click" is mouse moved < 5px AND released within 300ms
    tile.onmousedown = function(e) {
      _tilePressState = {
        plantId: tile.dataset.plantId,
        x: e.clientX,
        y: e.clientY,
        t: Date.now()
      };
    };
    tile.onmouseup = function(e) {
      var ps = _tilePressState;
      _tilePressState = null;
      if (!ps || ps.plantId !== tile.dataset.plantId) return;
      var dx = e.clientX - ps.x;
      var dy = e.clientY - ps.y;
      var dt = Date.now() - ps.t;
      var moved = Math.sqrt(dx*dx + dy*dy);
      if (moved < CLICK_MAX_PX && dt < CLICK_MAX_MS) {
        openPlantDetailPanel(tile.dataset.plantId);
      }
    };

    tile.ondragstart = function(e) {
      _tilePressState = null; // a drag — don't treat the matching mouseup as a click
      var pid = tile.dataset.plantId;
      draggedPlant = plants.find(function(p) { return p.id === pid; });
      catalogDropHandled = false;
      e.dataTransfer.setData("text/plain", pid);
      e.dataTransfer.effectAllowed = "copy";
    };
    tile.ondragend = function(e) {
      // Drops over the 3D canvas are handled by setup3DDragDrop's onDrop /
      // onMiss callbacks (which set catalogDropHandled). If we get here
      // without that flag set, the drop landed off-canvas (sidebar, etc.) —
      // toss the plant to the ground from wherever the cursor was released.
      if (!catalogDropHandled && draggedPlant && scene3DHandle) {
        tossNewPlantToGround(draggedPlant, e.clientX, e.clientY, scene3DHandle);
      }
      draggedPlant = null;
      catalogDropHandled = false;
    };
  });
  bindCatalogTouch();
}

function getPlantById(id) {
  return plants.find(function(p) { return p.id === id; });
}

// ── Plant detail panel ──────────────────────────────────────────────────────
function openPlantDetailPanel(plantId) {
  detailPanelPlantId = plantId;
  renderPlantDetailPanel();
}

function closePlantDetailPanel() {
  detailPanelPlantId = null;
  var panel = document.getElementById("plant-detail-panel");
  if (panel) panel.innerHTML = '';
}

function _careLine(p) {
  if (p.care_summary) return escapeHtml(p.care_summary);
  var parts = [];
  if (p.water_need) parts.push(p.water_need + ' water');
  if (p.sunlight) parts.push(sunlightLabel(p.sunlight).toLowerCase());
  if (p.spread_inches) parts.push('spreads ~' + p.spread_inches + '"');
  var bloomStr = bloomMonthsString(p.bloom_months);
  if (bloomStr) parts.push('blooms ' + bloomStr);
  return parts.length ? escapeHtml(parts.join(' · ')) : '';
}

function _bloomStripHtml(months) {
  var set = {};
  if (Array.isArray(months)) months.forEach(function(m) { set[m] = true; });
  var dots = '';
  var labels = '';
  for (var m = 1; m <= 12; m++) {
    dots += '<span class="bloom-dot' + (set[m] ? ' on' : '') + '"></span>';
    labels += '<span class="bloom-label">' + MONTH_LETTERS[m-1] + '</span>';
  }
  return '<div class="bloom-strip">' +
           '<div class="bloom-dots">' + dots + '</div>' +
           '<div class="bloom-labels">' + labels + '</div>' +
         '</div>';
}

function _companionsSectionHtml(plantId) {
  var entries = companionsByPlantId[plantId] || [];
  var goods = entries.filter(function(e) { return e.relationship === 'good'; }).slice(0, 6);
  var bads  = entries.filter(function(e) { return e.relationship === 'bad';  }).slice(0, 6);
  if (goods.length === 0 && bads.length === 0) return '';
  var html = '<div class="detail-companions">';
  if (goods.length) {
    html += '<div class="detail-companion-row"><div class="detail-companion-label">Grows well with</div><div class="detail-companion-chips">';
    goods.forEach(function(e) {
      var partner = getPlantById(e.otherId);
      if (!partner) return;
      html += '<button class="detail-companion-chip good" data-partner-id="' + partner.id + '"><img src="' + getPlantThumbnail(partner, renderStyle) + '" alt="" />' + escapeHtml(partner.name) + '</button>';
    });
    html += '</div></div>';
  }
  if (bads.length) {
    html += '<div class="detail-companion-row"><div class="detail-companion-label">Avoid planting near</div><div class="detail-companion-chips">';
    bads.forEach(function(e) {
      var partner = getPlantById(e.otherId);
      if (!partner) return;
      html += '<button class="detail-companion-chip bad" data-partner-id="' + partner.id + '"><img src="' + getPlantThumbnail(partner, renderStyle) + '" alt="" />' + escapeHtml(partner.name) + '</button>';
    });
    html += '</div></div>';
  }
  html += '</div>';
  return html;
}

function _pollinatorRowHtml(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  var icons = '';
  var labels = [];
  for (var i = 0; i < arr.length; i++) {
    var key = arr[i];
    var iconName = POLLINATOR_ICONS[key] || 'sparkles';
    icons += '<i data-lucide="' + iconName + '" style="width:16px;height:16px"></i>';
    labels.push(POLLINATOR_LABELS[key] || key);
  }
  return '<div class="detail-pollinators"><div class="detail-pollinator-icons">' + icons + '</div>' +
         '<div class="detail-pollinator-labels">' + escapeHtml(labels.join(', ')) + '</div></div>';
}

function renderPlantDetailPanel() {
  var panel = document.getElementById("plant-detail-panel");
  if (!panel) return;
  if (!detailPanelPlantId) { panel.innerHTML = ''; return; }
  var p = getPlantById(detailPanelPlantId);
  if (!p) { panel.innerHTML = ''; return; }

  var html = '<div class="plant-detail-backdrop" id="plant-detail-backdrop"></div>';
  html += '<aside class="plant-detail-panel" role="dialog" aria-label="Plant details">';

  // Header
  html += '<div class="detail-header">';
  html += '<h3 class="detail-title">' + escapeHtml(p.name) + '</h3>';
  html += '<button class="close-btn" id="plant-detail-close" aria-label="Close"><i data-lucide="x"></i></button>';
  html += '</div>';

  html += '<div class="detail-body">';

  // Native-to-zone badge
  var zn = currentGarden && zoneNumber(currentGarden.usda_zone);
  if (p.native === true && zn != null && p.usda_zones &&
      typeof p.usda_zones.min === 'number' && typeof p.usda_zones.max === 'number' &&
      zn >= p.usda_zones.min && zn <= p.usda_zones.max) {
    html += '<div class="detail-native-badge"><i data-lucide="leaf" style="width:14px;height:14px"></i> Native to your zone</div>';
  }

  // Care line
  var care = _careLine(p);
  if (care) html += '<p class="detail-care">' + care + '</p>';

  // Bloom strip
  if (Array.isArray(p.bloom_months) && p.bloom_months.length > 0) {
    html += _bloomStripHtml(p.bloom_months);
  }

  // Pollinators
  html += _pollinatorRowHtml(p.pollinator_attracts);

  // Companions (Iteration 2)
  html += _companionsSectionHtml(p.id);

  // Hardiness range
  var zr = zoneRangeString(p.usda_zones);
  if (zr) html += '<p class="detail-zones">' + escapeHtml(zr) + '</p>';

  // Description
  if (p.description) html += '<p class="detail-description">' + escapeHtml(p.description) + '</p>';

  html += '</div>'; // .detail-body
  html += '</aside>';

  panel.innerHTML = html;
  _initIcons();

  // Wire up dismissal: close button + backdrop click
  var closeBtn = document.getElementById("plant-detail-close");
  if (closeBtn) closeBtn.onclick = closePlantDetailPanel;
  var backdrop = document.getElementById("plant-detail-backdrop");
  if (backdrop) backdrop.onclick = closePlantDetailPanel;

  // Companion partner chips swap the panel to the partner plant
  Array.prototype.forEach.call(panel.querySelectorAll('.detail-companion-chip'), function(btn) {
    btn.onclick = function() { detailPanelPlantId = btn.dataset.partnerId; renderPlantDetailPanel(); };
  });
}

// Esc-key handler — wired once on script load
(function bindDetailPanelEsc() {
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && detailPanelPlantId) closePlantDetailPanel();
  });
})();
