// garden.js — 2D top-down planter builder. Sidebar is always the user's
// shortlist of cache-backed plants; the legacy seed-table catalog has been
// retired in the Phase-2 cutover.

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
  } else if (!gardenTypeIsClimateControlled(g.garden_type)) {
    html += '<button type="button" id="builder-zone-chip" class="cond-chip cond-chip-btn cond-chip-warn" title="Set location">📍 Set location</button>';
  }
  html += '<span class="cond-chip">' + plantertypeIcon(g.garden_type || 'garden_bed') + ' ' + escapeHtml(plantertypeLabel(g.garden_type || 'garden_bed')) + '</span>';
  html += '</div>';

  html += '<div class="builder-layout">';

  // Sidebar — always the user's shortlist.
  html += '<div id="catalog-sidebar" class="catalog-sidebar">';
  html += renderShortlistSidebar(g);
  html += '</div>';

  // 2D top-down view (drag from sidebar to place; tap to remove).
  html += '<div class="builder-main">';
  html += '<div class="render2d-pane">';
  html += '<div class="render2d-header">';
  html += '<span class="render2d-label"><i data-lucide="layout-grid"></i> Drag from your shortlist to place &nbsp;·&nbsp; tap to remove</span>';
  html += '</div>';
  html += '<div id="render2d-container"></div>';
  html += '</div>';
  html += '</div>'; // .builder-main
  html += '</div>'; // .builder-layout

  app.innerHTML = html;

  bindShortlistEvents();
  bindBuilderButtons();
  _initIcons();

  init2DScene(g);
}

function init2DScene(g) {
  if (scene3DHandle && typeof dispose2DView === 'function') {
    dispose2DView(scene3DHandle);
  }
  scene3DHandle = null;
  // Double RAF ensures CSS layout has committed before we measure the container.
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      scene3DHandle = init2DView("render2d-container", g, placements);
      if (scene3DHandle) {
        bind2DDragDrop();
        bind2DClickHandler();
        if (typeof refreshShortlistSidebar === 'function') refreshShortlistSidebar();
      }
    });
  });
}

function sync3DView() {
  if (scene3DHandle && typeof syncSceneWithPlacements === 'function') {
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
        // The 2D handle exposes effective feet dimensions; use those so
        // bounds-checking is unit-correct for indoor pots.
        var gw = scene3DHandle.gridWidthFt;
        var gh = scene3DHandle.gridHeightFt;
        var valid = validatePlacement(pos_x, pos_y, r, gw, gh, placements);
        if (valid !== 'ok') {
          showPreviewDisk(scene3DHandle, pos_x, pos_y, r, valid);
          setTimeout(function() { hidePreviewDisk(scene3DHandle); }, 350);
        } else {
          hidePreviewDisk(scene3DHandle);
          placements.push({
            id: _newPlacementId(),
            plantCacheId: draggedPlant.id,
            plant: draggedPlant,
            pos_x: pos_x,
            pos_y: pos_y,
            radius_feet: r
          });
          sync3DView();
          if (typeof refreshShortlistSidebar === 'function') refreshShortlistSidebar();
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
    sync3DView();
    if (typeof refreshShortlistSidebar === 'function') refreshShortlistSidebar();
  });
}

// Cache plants store spread in cm; convert to a radius in feet.
function _spreadFeetFor(plant) {
  if (!plant) return 0.5;
  if (plant.spread_cm)     return plant.spread_cm / 30.48 / 2;  // diameter cm → radius ft
  if (plant.spread_inches) return plant.spread_inches / 24;     // legacy seed-table compat
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
  var payload = placements
    .filter(function(p) { return p.plantCacheId; })
    .map(function(p) {
      return {
        plant_cache_id: p.plantCacheId,
        pos_x: p.pos_x,
        pos_y: p.pos_y,
        radius_feet: p.radius_feet
      };
    });
  try {
    await apiFetch("/gardens/" + currentGarden.id + "/plants", {
      method: "PUT",
      body: { plants: payload }
    });
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
    if (typeof refreshShortlistSidebar === 'function') refreshShortlistSidebar();
    _showBuilderToast('Reseeded');
  } catch (err) {
    alert("Reseed failed: " + err.message);
  }
}
