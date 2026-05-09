// garden.js — 3D grid builder with direct drag-and-drop onto the Three.js scene

function renderBuilder() {
  if (!currentGarden) { showView("gardens"); return; }
  var g = currentGarden;

  // Row 1: name + size + kebab menu
  var html = '<div class="builder-header">';
  html += '<div class="builder-title">';
  html += '<h4>' + escapeHtml(g.name) + '</h4>';
  html += '<span class="builder-size">' + escapeHtml(sizeLabelFor(g)) + '</span>';
  html += '</div>';
  html += '<div class="builder-actions">';
  html +=   '<div class="dropdown dropdown-end builder-kebab">';
  html +=     '<button type="button" tabindex="0" class="btn btn-ghost btn-sm btn-circle" aria-label="Garden options" id="builder-kebab-trigger">';
  html +=       '<i data-lucide="more-vertical" style="width:1.1em;height:1.1em"></i>';
  html +=     '</button>';
  html +=     '<ul tabindex="0" class="menu dropdown-content rounded-box bg-base-100 shadow-lg w-52 p-2 mt-1">';
  html +=       '<li><a id="kebab-save"><i data-lucide="save" style="width:1em;height:1em"></i> Save garden</a></li>';
  html +=       '<li><a id="kebab-reseed"><i data-lucide="refresh-cw" style="width:1em;height:1em"></i> Reseed</a></li>';
  html +=       '<li><a id="kebab-edit-zone"><i data-lucide="map-pin" style="width:1em;height:1em"></i> Change zone</a></li>';
  html +=     '</ul>';
  html +=   '</div>';
  html += '</div>';
  html += '</div>';

  // Row 2: conditions strip — read-only chips summarising the planter
  html += '<div class="builder-conditions">';
  html += '<span class="cond-chip">' + sunlightIcon(g.shade_level || 'full_sun') + ' ' + escapeHtml(sunlightLabel(g.shade_level || 'full_sun')) + '</span>';
  html += '<span class="cond-chip">💧 ' + escapeHtml(waterPlanLabel(g.water_plan || 'regular')) + '</span>';
  if (g.usda_zone) {
    html += '<button type="button" id="builder-zone-chip" class="cond-chip cond-chip-btn" title="Change zone">📍 ' + escapeHtml(g.location_label || ('Zone ' + g.usda_zone)) + '</button>';
  } else if (g.garden_type !== 'indoor' && g.garden_type !== 'greenhouse') {
    html += '<button type="button" id="builder-zone-chip" class="cond-chip cond-chip-btn cond-chip-warn" title="Set location">📍 Set location</button>';
  }
  html += '<span class="cond-chip">' + plantertypeIcon(g.garden_type || 'garden_bed') + ' ' + escapeHtml(plantertypeLabel(g.garden_type || 'garden_bed')) + '</span>';
  html += '</div>';

  html += '<div class="builder-layout">';

  // Sidebar — shortlist for new (cache-backed) gardens, legacy catalog otherwise.
  var hasShortlist = Array.isArray(g.shortlist) && g.shortlist.length > 0;
  html += '<div id="catalog-sidebar" class="catalog-sidebar">';
  if (hasShortlist) {
    html += renderShortlistSidebar(g);
  } else {
    html += '<div class="catalog-filters">' + renderCatalogFilters() + '</div>';
    html += '<div class="catalog-list-wrapper" id="catalog-list-wrapper">' + renderCatalogList() + '</div>';
    html += '<div id="plant-detail-panel"></div>';
  }
  html += '</div>';

  // 2D top-down view (drag from sidebar to place; tap to remove).
  html += '<div class="builder-main">';
  html += '<div class="render2d-pane">';
  html += '<div class="render2d-header">';
  html += '<span class="render2d-label"><i data-lucide="layout-grid"></i> Drag from your shortlist to place &nbsp;·&nbsp; tap to remove</span>';
  html += '</div>';
  html += '<div id="render2d-container"></div>';
  html += '<div id="companion-chips" class="companion-chips-layer"></div>';
  html += '</div>';
  html += '<section id="bloom-calendar-strip" class="bloom-calendar"></section>';
  html += '</div>'; // .builder-main
  html += '</div>'; // .builder-layout

  // Plant info tooltip
  html += '<div id="plant-tooltip" class="plant-tooltip" style="display:none"></div>';

  app.innerHTML = html;

  if (Array.isArray(g.shortlist) && g.shortlist.length > 0) {
    bindShortlistEvents();
  } else {
    bindCatalogEvents();
  }
  bindBuilderButtons();
  _initIcons();

  // Initialize 2D scene, then wire up drag-drop and click handlers.
  init2DScene(g);
}

function init2DScene(g) {
  if (scene3DHandle && typeof dispose2DView === 'function' && scene3DHandle.isTwoD) {
    dispose2DView(scene3DHandle);
  } else if (scene3DHandle && typeof dispose3DView === 'function') {
    try { dispose3DView(scene3DHandle); } catch (_) {}
  }
  scene3DHandle = null;
  // Double RAF ensures CSS layout has committed before we measure the container.
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      scene3DHandle = init2DView("render2d-container", g, placements);
      if (scene3DHandle) {
        bind2DDragDrop();
        bind2DClickHandler();
        renderCompanionChips();
        if (typeof refreshCatalogList === 'function') refreshCatalogList();
        if (typeof renderBloomCalendar === 'function') renderBloomCalendar();
      }
    });
  });
}

// Backwards-compat alias for callers that still reference the old name.
var init3DScene = init2DScene;

function sync3DView() {
  if (scene3DHandle && scene3DHandle.isTwoD) {
    syncSceneWithPlacements(scene3DHandle, placements);
  } else if (scene3DHandle && typeof syncSceneWithPlacements === 'function') {
    syncSceneWithPlacements(scene3DHandle, placements);
  }
}

function _newPlacementId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function bind2DDragDrop() {
  setup2DDragDrop(scene3DHandle, {
    onDrop: function(pos_x, pos_y) {
      if (draggedPlant) {
        var r = _spreadFeetFor(draggedPlant);
        var gw = scene3DHandle.garden.grid_width;
        var gh = scene3DHandle.garden.grid_height;
        var valid = validatePlacement(pos_x, pos_y, r, gw, gh, placements);
        if (valid !== 'ok') {
          showPreviewDisk(scene3DHandle, pos_x, pos_y, r, valid);
          setTimeout(function() { hidePreviewDisk(scene3DHandle); }, 350);
        } else {
          hidePreviewDisk(scene3DHandle);
          placements.push({
            id: _newPlacementId(),
            plantId: draggedPlant.id,
            // Cache-backed placements stash the cache id; legacy placements use
            // plantId. Save logic checks both.
            plantCacheId: draggedPlant.__source === 'cache' ? draggedPlant.id : null,
            plant: draggedPlant,
            pos_x: pos_x,
            pos_y: pos_y,
            radius_feet: r
          });
          sync3DView();
          renderCompanionChips();
          if (typeof refreshCatalogList === 'function') refreshCatalogList();
          if (typeof refreshShortlistSidebar === 'function') refreshShortlistSidebar();
          if (typeof renderBloomCalendar === 'function') renderBloomCalendar();
        }
      }
      catalogDropHandled = true;
      draggedPlant = null;
    },
    onLeave: function() {}
  });
}

function bind2DClickHandler() {
  bind2DClick(scene3DHandle, function(placementId) {
    var idx = placements.findIndex(function(p) { return p.id === placementId; });
    if (idx >= 0) placements.splice(idx, 1);
    if (companionPopoverCellKey === placementId) {
      companionPopoverCellKey = null;
      var existingPop = document.getElementById('companion-popover');
      if (existingPop) existingPop.remove();
    }
    sync3DView();
    renderCompanionChips();
    if (typeof refreshCatalogList === 'function') refreshCatalogList();
    if (typeof refreshShortlistSidebar === 'function') refreshShortlistSidebar();
    if (typeof renderBloomCalendar === 'function') renderBloomCalendar();
  });
}

// Cache plants store spread in cm; legacy seed plants store it in inches.
function _spreadFeetFor(plant) {
  if (!plant) return 0.5;
  if (plant.spread_inches) return plant.spread_inches / 24;
  if (plant.spread_cm)     return plant.spread_cm / 30.48 / 2;  // diameter cm → radius ft
  return 0.5;
}

function showTooltip(el, plant) {
  var tip = document.getElementById("plant-tooltip");
  if (!tip) return;
  tip.innerHTML =
    '<strong>' + escapeHtml(plant.name) + '</strong><br>' +
    sunlightIcon(plant.sunlight) + ' ' + sunlightLabel(plant.sunlight) +
    ' | ' + plant.height_inches + '" tall' +
    (plant.description ? '<br><span class="opacity-50 text-sm">' + escapeHtml(plant.description) + '</span>' : '');
  tip.style.display = "block";
  var rect = el.getBoundingClientRect();
  tip.style.left = rect.left + "px";
  tip.style.top = (rect.bottom + 4) + "px";
}

function hideTooltip() {
  var tip = document.getElementById("plant-tooltip");
  if (tip) tip.style.display = "none";
}

function bindBuilderButtons() {
  // DaisyUI div-based dropdown: closing means blurring the focused trigger.
  function closeKebab() {
    var kebab = document.querySelector('.builder-kebab');
    if (!kebab) return;
    var active = document.activeElement;
    if (active && kebab.contains(active)) active.blur();
  }

  var saveItem = document.getElementById('kebab-save');
  if (saveItem) saveItem.onclick = function(e) { e.preventDefault(); closeKebab(); saveGarden(); };
  var reseedItem = document.getElementById('kebab-reseed');
  if (reseedItem) reseedItem.onclick = function(e) { e.preventDefault(); closeKebab(); reseedGarden(); };
  var zoneItem = document.getElementById('kebab-edit-zone');
  if (zoneItem) zoneItem.onclick = function(e) { e.preventDefault(); closeKebab(); openZoneEditor(); };

  // Toolbar zone chip — same destination as the kebab "Change zone" item.
  var zoneChip = document.getElementById('builder-zone-chip');
  if (zoneChip) zoneChip.onclick = openZoneEditor;

}

// USDA zones 1a..13b
var USDA_ZONES = (function() {
  var out = [];
  for (var i = 1; i <= 13; i++) { out.push(i + 'a'); out.push(i + 'b'); }
  return out;
})();

// openZoneEditor opens the location picker (geolocation + ZIP + manual)
// from location.js. On resolve, saves zone + label back to the garden via PUT
// and re-renders the toolbar so the new zone shows in the conditions strip.
function openZoneEditor() {
  if (!currentGarden) return;
  if (typeof openLocationPicker !== 'function') return;
  openLocationPicker({
    onResolve: async function(loc) {
      await setGardenLocation(loc.zone, loc.label);
    }
  });
}

// Kept as openZonePicker so any older call sites still work.
var openZonePicker = openZoneEditor;

async function setGardenLocation(zone, label) {
  if (!currentGarden) return;
  var prevZone  = currentGarden.usda_zone;
  var prevLabel = currentGarden.location_label;
  currentGarden.usda_zone     = zone;
  currentGarden.location_label = label;
  // Re-render the toolbar/conditions strip with the new value.
  renderBuilder();
  try {
    await apiFetch("/gardens/" + currentGarden.id, {
      method: "PUT",
      body: { usda_zone: zone, location_label: label }
    });
  } catch (err) {
    currentGarden.usda_zone     = prevZone;
    currentGarden.location_label = prevLabel;
    renderBuilder();
    alert("Could not update zone: " + err.message);
  }
}

// Backwards-compat — older modules call setGardenZone(zone).
async function setGardenZone(zone) {
  return setGardenLocation(zone, 'Zone ' + zone);
}

function _showBuilderToast(msg) {
  var existing = document.getElementById('builder-toast');
  if (existing) existing.remove();
  var t = document.createElement('div');
  t.id = 'builder-toast';
  t.className = 'builder-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function() { t.classList.add('show'); }, 0);
  setTimeout(function() {
    t.classList.remove('show');
    setTimeout(function() { t.remove(); }, 200);
  }, 1600);
}

async function saveGarden() {
  if (!currentGarden) return;
  var payload = placements.map(function(p) {
    var row = { pos_x: p.pos_x, pos_y: p.pos_y, radius_feet: p.radius_feet };
    if (p.plantCacheId) row.plant_cache_id = p.plantCacheId;
    else                row.plant_id = p.plantId;
    return row;
  });
  try {
    await apiFetch("/gardens/" + currentGarden.id + "/plants", {
      method: "PUT",
      body: { plants: payload }
    });
    // Persist dismissed companion warnings; non-fatal on failure.
    try {
      await apiFetch("/gardens/" + currentGarden.id, {
        method: "PUT",
        body: { settings_json: { dismissed_companion_warnings: Array.from(dismissedCompanionWarnings) } }
      });
    } catch (e) {
      console.warn('[plant-planner] persist dismissed companion warnings failed:', e);
    }
    _showBuilderToast('Saved');
  } catch (err) {
    alert("Save failed: " + err.message);
  }
}

async function reseedGarden() {
  if (!currentGarden) return;
  if (!confirm("Reseed for next season? This will clear all current plants and save an empty garden.")) return;
  try {
    await apiFetch("/gardens/" + currentGarden.id + "/plants", {
      method: "PUT",
      body: { plants: [] }
    });
    placements = [];
    sync3DView();
    renderCompanionChips();
    refreshCatalogList();
    if (typeof renderBloomCalendar === 'function') renderBloomCalendar();
    _showBuilderToast('Reseeded');
  } catch (err) {
    alert("Reseed failed: " + err.message);
  }
}
