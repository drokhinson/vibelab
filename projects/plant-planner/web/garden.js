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
  html +=   '<details class="dropdown dropdown-end builder-kebab">';
  html +=     '<summary class="btn btn-ghost btn-sm btn-circle" aria-label="Garden options"><i data-lucide="more-vertical" style="width:1.1em;height:1.1em"></i></summary>';
  html +=     '<ul class="menu dropdown-content rounded-box bg-base-100 shadow-lg z-50 w-52 p-2 mt-1">';
  html +=       '<li><a id="kebab-save"><i data-lucide="save" style="width:1em;height:1em"></i> Save garden</a></li>';
  html +=       '<li><a id="kebab-reseed"><i data-lucide="refresh-cw" style="width:1em;height:1em"></i> Reseed</a></li>';
  html +=       '<li><a id="kebab-edit-zone"><i data-lucide="map-pin" style="width:1em;height:1em"></i> Change zone</a></li>';
  html +=     '</ul>';
  html +=   '</details>';
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

  // Catalog sidebar
  html += '<div id="catalog-sidebar" class="catalog-sidebar">';
  html += '<div class="catalog-filters">' + renderCatalogFilters() + '</div>';
  html += '<div class="catalog-list-wrapper" id="catalog-list-wrapper">' + renderCatalogList() + '</div>';
  html += '<div id="plant-detail-panel"></div>';
  html += '</div>';

  // 3D view (full width — drag catalog plants directly onto scene)
  html += '<div class="builder-main">';
  html += '<div class="render3d-pane">';
  html += '<div class="render3d-header">';
  html += '<span class="render3d-label"><i data-lucide="box"></i> Drag from catalog to place &nbsp;·&nbsp; hold to move &nbsp;·&nbsp; tap to remove</span>';
  html += '<div class="year-scrubber" role="group" aria-label="Growth preview year" title="Preview only — placement is saved at mature size.">';
  html +=   '<button type="button" class="year-pill" data-year="1">Y1</button>';
  html +=   '<button type="button" class="year-pill" data-year="2">Y2</button>';
  html +=   '<button type="button" class="year-pill" data-year="3">Y3+</button>';
  html += '</div>';
  html += '</div>';
  html += '<div id="render3d-container"></div>';
  html += '<div id="companion-chips" class="companion-chips-layer"></div>';
  html += '</div>';
  html += '<section id="bloom-calendar-strip" class="bloom-calendar"></section>';
  html += '</div>'; // .builder-main
  html += '</div>'; // .builder-layout

  // Plant info tooltip
  html += '<div id="plant-tooltip" class="plant-tooltip" style="display:none"></div>';

  app.innerHTML = html;

  bindCatalogEvents();
  bindBuilderButtons();
  _initIcons();

  // Initialize 3D scene, then wire up drag-drop and click handlers
  init3DScene(g);
}

function init3DScene(g) {
  if (scene3DHandle) {
    dispose3DView(scene3DHandle);
    scene3DHandle = null;
  }
  // Double RAF ensures CSS layout is fully committed before reading container dimensions
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      scene3DHandle = init3DView("render3d-container", g, placements);
      if (scene3DHandle) {
        bind3DDragDrop();
        bind3DClick();
        bindPlantDrag(scene3DHandle);
        renderCompanionChips();
        refreshCatalogList();
        if (typeof renderBloomCalendar === 'function') renderBloomCalendar();
      }
    });
  });
}

function sync3DView() {
  if (scene3DHandle) {
    syncSceneWithPlacements(scene3DHandle, placements);
  }
}

function _newPlacementId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function bind3DDragDrop() {
  setup3DDragDrop(scene3DHandle, {
    onDrop: function(pos_x, pos_y) {
      if (draggedPlant) {
        var r = (draggedPlant.spread_inches || 12) / 24;
        placements.push({
          id: _newPlacementId(),
          plantId: draggedPlant.id,
          plant: draggedPlant,
          pos_x: pos_x,
          pos_y: pos_y,
          radius_feet: r
        });
        sync3DView();
        renderCompanionChips();
        refreshCatalogList();
        if (typeof renderBloomCalendar === 'function') renderBloomCalendar();
      }
      catalogDropHandled = true;
      draggedPlant = null;
    },
    onMiss: function(clientX, clientY) {
      // Drop landed on the canvas but outside the grid — toss the plant onto
      // the ground at the drop location.
      if (draggedPlant && scene3DHandle) {
        tossNewPlantToGround(draggedPlant, clientX, clientY, scene3DHandle);
      }
      catalogDropHandled = true;
      draggedPlant = null;
    },
    // dragleave just clears the cell highlight; keep draggedPlant so the user
    // can leave + re-enter the canvas during a single drag, and so a
    // follow-up dragend off-canvas can still trigger the toss animation.
    onLeave: function() {}
  });
}

function bind3DClick() {
  var canvas = scene3DHandle.renderer.domElement;
  canvas.addEventListener("click", function(e) {
    if (Date.now() - _lastPickupEndTime < 300) return;
    var rect = canvas.getBoundingClientRect();
    var mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    var raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, scene3DHandle.camera);
    var hits = raycaster.intersectObjects(scene3DHandle.plantsGroup.children, true);
    if (hits.length > 0) {
      var obj = hits[0].object;
      while (obj && !obj.userData.placementId) obj = obj.parent;
      if (obj && obj.userData.placementId) {
        var pid = obj.userData.placementId;
        var idx = placements.findIndex(function(p) { return p.id === pid; });
        if (idx >= 0) placements.splice(idx, 1);
        if (companionPopoverCellKey === pid) {
          companionPopoverCellKey = null;
          var existingPop = document.getElementById('companion-popover');
          if (existingPop) existingPop.remove();
        }
        sync3DView();
        renderCompanionChips();
        refreshCatalogList();
        if (typeof renderBloomCalendar === 'function') renderBloomCalendar();
      }
    }
  });
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
  function closeKebab() {
    var kebab = document.querySelector('.builder-kebab');
    if (kebab) kebab.removeAttribute('open');
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

  // Year-preview scrubber
  var pills = document.querySelectorAll('.year-scrubber .year-pill');
  Array.prototype.forEach.call(pills, function(btn) {
    btn.onclick = function() {
      var y = parseInt(btn.dataset.year, 10);
      if (![1, 2, 3].includes(y)) return;
      previewYear = y;
      localStorage.setItem('pp_preview_year', String(previewYear));
      updateYearPills();
      sync3DView();
      renderCompanionChips();
    };
  });
  updateYearPills();
}

function updateYearPills() {
  var pills = document.querySelectorAll('.year-scrubber .year-pill');
  Array.prototype.forEach.call(pills, function(btn) {
    var y = parseInt(btn.dataset.year, 10);
    if (y === previewYear) btn.classList.add('active');
    else btn.classList.remove('active');
  });
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
    return { plant_id: p.plantId, pos_x: p.pos_x, pos_y: p.pos_y, radius_feet: p.radius_feet };
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
