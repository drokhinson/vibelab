// companions.js — Companion-planting data + warning helpers (no DOM)

async function loadCompanions() {
  try {
    companions = await apiFetch('/companions') || [];
    buildCompanionLookup();
  } catch (e) {
    console.warn('[plant-planner] loadCompanions failed:', e);
    companions = [];
    companionsByPlantId = {};
  }
}

function buildCompanionLookup() {
  companionsByPlantId = {};
  companions.forEach(function(row) {
    (companionsByPlantId[row.plant_a_id] = companionsByPlantId[row.plant_a_id] || []).push({
      otherId: row.plant_b_id, relationship: row.relationship, reason: row.reason
    });
    (companionsByPlantId[row.plant_b_id] = companionsByPlantId[row.plant_b_id] || []).push({
      otherId: row.plant_a_id, relationship: row.relationship, reason: row.reason
    });
  });
}

function getCompanionRelationship(aId, bId) {
  if (!aId || !bId || aId === bId) return null;
  var entries = companionsByPlantId[aId];
  if (!entries) return null;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].otherId === bId) return entries[i].relationship;
  }
  return null;
}

function computeWarningsForPlacements(placementsArr) {
  var result = {};
  if (!placementsArr || placementsArr.length === 0) return result;
  for (var i = 0; i < placementsArr.length; i++) {
    for (var j = i + 1; j < placementsArr.length; j++) {
      var a = placementsArr[i], b = placementsArr[j];
      var dx = a.pos_x - b.pos_x, dy = a.pos_y - b.pos_y;
      var d = Math.sqrt(dx * dx + dy * dy);
      // Year-preview: re-evaluate radii at the current scrubber year.
      var sa = (typeof yearScale === 'function') ? yearScale(a.plant, previewYear) : 1.0;
      var sb = (typeof yearScale === 'function') ? yearScale(b.plant, previewYear) : 1.0;
      var ra = a.radius_feet * sa;
      var rb = b.radius_feet * sb;
      var adj = ra + rb + 0.5;
      if (d > adj) continue;
      var rel = getCompanionRelationship(a.plantId, b.plantId);
      if (rel === 'good' || rel === 'bad') {
        var reasonAB = '';
        var entriesA = companionsByPlantId[a.plantId] || [];
        for (var k = 0; k < entriesA.length; k++) {
          if (entriesA[k].otherId === b.plantId) { reasonAB = entriesA[k].reason; break; }
        }
        (result[a.id] = result[a.id] || []).push({
          type: 'companion', neighborPlacementId: b.id, neighborPlantId: b.plantId,
          relationship: rel, reason: reasonAB
        });
        (result[b.id] = result[b.id] || []).push({
          type: 'companion', neighborPlacementId: a.id, neighborPlantId: a.plantId,
          relationship: rel, reason: reasonAB
        });
      }
      // Crowd: disks overlap by more than 6 inches (0.5 ft)
      var crowd = ra + rb - 0.5;
      if (d < crowd) {
        (result[a.id] = result[a.id] || []).push({
          type: 'crowd', neighborPlacementId: b.id, neighborPlantId: b.plantId
        });
        (result[b.id] = result[b.id] || []).push({
          type: 'crowd', neighborPlacementId: a.id, neighborPlantId: a.plantId
        });
      }
    }
  }
  return result;
}

function canonicalPairKey(prefix, aId, bId) {
  var ordered = aId < bId ? aId + ':' + bId : bId + ':' + aId;
  return prefix + ':' + ordered;
}

function _isDismissed(prefix, aId, bId) {
  if (dismissedCompanionWarnings.has(canonicalPairKey(prefix, aId, bId))) return true;
  // Legacy: pre-iter-3 entries had no prefix and used plant-id ordering
  if (prefix === 'companion') {
    var ordered = aId < bId ? aId + ':' + bId : bId + ':' + aId;
    if (dismissedCompanionWarnings.has(ordered)) return true;
  }
  return false;
}

// ── DOM-touching companion-warning UI (chips + popover) ────────────────────

function renderCompanionChips() {
  var layer = document.getElementById('companion-chips');
  if (!layer || !scene3DHandle) return;
  var warnings = computeWarningsForPlacements(placements);
  var shadeWarnings = (typeof computeShadeConflicts === 'function')
    ? computeShadeConflicts(placements, previewYear)
    : {};
  var html = '';
  // Build a unified set of placement ids that have any kind of warning/good
  var allIds = {};
  for (var k in warnings) { if (warnings.hasOwnProperty(k)) allIds[k] = true; }
  for (var k2 in shadeWarnings) { if (shadeWarnings.hasOwnProperty(k2)) allIds[k2] = true; }
  for (var i = 0; i < placements.length; i++) {
    var placement = placements[i];
    if (!allIds[placement.id]) continue;
    var rows = warnings[placement.id] || [];
    var shadeRows = shadeWarnings[placement.id] || [];
    var selfPlantId = placement.plantId;
    var hasBadCompanion = rows.some(function(w) {
      return w.type === 'companion' && w.relationship === 'bad' &&
             !_isDismissed('companion', selfPlantId, w.neighborPlantId);
    });
    var hasCrowd = rows.some(function(w) {
      return w.type === 'crowd' && !_isDismissed('crowd', placement.id, w.neighborPlacementId);
    });
    var hasShade = shadeRows.some(function(w) {
      return !_isDismissed('shade', placement.id, w.shadingPlacementId);
    });
    var hasGood = rows.some(function(w) {
      return w.type === 'companion' && w.relationship === 'good';
    });
    var type = (hasBadCompanion || hasCrowd || hasShade) ? 'warning' : (hasGood ? 'good' : null);
    if (!type) continue;
    var pos = projectPlacementToScreen(placement.id);
    if (!pos) continue;
    var icon = type === 'warning' ? 'alert-triangle' : 'sparkles';
    html += '<button class="companion-chip-' + type + '" data-placement-id="' + placement.id + '"' +
            ' style="left:' + pos.x + 'px;top:' + pos.y + 'px"><i data-lucide="' + icon + '"></i></button>';
  }
  layer.innerHTML = html;
  if (window.lucide) window.lucide.createIcons({ icons: layer });
  Array.prototype.forEach.call(layer.querySelectorAll('button'), function(btn) {
    btn.onclick = function(e) {
      e.stopPropagation();
      companionPopoverCellKey = btn.dataset.placementId;
      renderCompanionPopover();
    };
  });
  if (companionPopoverCellKey) renderCompanionPopover();
  // Schedule re-positioning on the next frame while builder is mounted.
  if (!_companionRafScheduled) {
    _companionRafScheduled = true;
    requestAnimationFrame(function step() {
      var layer2 = document.getElementById('companion-chips');
      if (!layer2) { _companionRafScheduled = false; return; }
      Array.prototype.forEach.call(layer2.querySelectorAll('button'), function(btn) {
        var pos = projectPlacementToScreen(btn.dataset.placementId);
        if (pos) { btn.style.left = pos.x + 'px'; btn.style.top = pos.y + 'px'; }
      });
      var pop = document.getElementById('companion-popover');
      if (pop && companionPopoverCellKey) {
        var p = projectPlacementToScreen(companionPopoverCellKey);
        if (p) {
          pop.style.left = (p.x + 14) + 'px';
          pop.style.top = (p.y + 14) + 'px';
        }
      }
      requestAnimationFrame(step);
    });
  }
}

var _companionRafScheduled = false;

function projectPlacementToScreen(placementId) {
  if (!scene3DHandle || !scene3DHandle.renderer) return null;
  var placement = placements.find(function(p) { return p.id === placementId; });
  if (!placement) return null;

  var canvas = scene3DHandle.renderer.domElement;
  var rect = canvas.getBoundingClientRect();
  var layer = document.getElementById('companion-chips');
  var layerRect = layer ? layer.getBoundingClientRect() : rect;

  // 2D top-down renderer: handle exposes a direct screen-coord projection.
  if (scene3DHandle.isTwoD && typeof scene3DHandle.projectPlacement === 'function') {
    var p2d = scene3DHandle.projectPlacement(placement);
    if (!p2d) return null;
    return {
      x: p2d.x + (rect.left - layerRect.left),
      y: p2d.y + (rect.top - layerRect.top)
    };
  }

  // 3D renderer: project via the THREE camera.
  if (!scene3DHandle.camera) return null;
  var v = scenePlacementWorldPosition(scene3DHandle, placement);
  if (!v) return null;
  var projected = v.clone().project(scene3DHandle.camera);
  if (projected.z < -1 || projected.z > 1) return null;
  var x = (projected.x + 1) / 2 * rect.width + (rect.left - layerRect.left);
  var y = (-projected.y + 1) / 2 * rect.height + (rect.top - layerRect.top);
  return { x: x, y: y };
}

function renderCompanionPopover() {
  // Remove any existing popover
  var existing = document.getElementById('companion-popover');
  if (existing) existing.remove();
  if (!companionPopoverCellKey) return;
  var self = placements.find(function(p) { return p.id === companionPopoverCellKey; });
  if (!self) { companionPopoverCellKey = null; return; }
  var warnings = computeWarningsForPlacements(placements);
  var rows = warnings[self.id] || [];
  var shadeWarnings = (typeof computeShadeConflicts === 'function')
    ? computeShadeConflicts(placements, previewYear)
    : {};
  var shadeRowsRaw = shadeWarnings[self.id] || [];
  var visibleShadeRows = shadeRowsRaw.filter(function(w) {
    return !_isDismissed('shade', self.id, w.shadingPlacementId);
  });
  // Filter dismissed rows
  var visibleRows = rows.filter(function(w) {
    if (w.type === 'companion' && w.relationship === 'bad') {
      return !_isDismissed('companion', self.plantId, w.neighborPlantId);
    }
    if (w.type === 'crowd') {
      return !_isDismissed('crowd', self.id, w.neighborPlacementId);
    }
    return true;
  });
  if (visibleRows.length === 0 && visibleShadeRows.length === 0) { companionPopoverCellKey = null; return; }

  var pos = projectPlacementToScreen(self.id);
  if (!pos) return;

  var pop = document.createElement('div');
  pop.id = 'companion-popover';
  pop.className = 'companion-popover';
  pop.style.position = 'absolute';
  pop.style.left = (pos.x + 14) + 'px';
  pop.style.top = (pos.y + 14) + 'px';

  var html = '<button class="companion-popover-close" aria-label="Close" data-action="close"><i data-lucide="x" style="width:14px;height:14px"></i></button>';
  visibleRows.forEach(function(w) {
    if (w.type === 'companion') {
      var partner = getPlantById(w.neighborPlantId);
      if (!partner) return;
      var thumb = getPlantThumbnail(partner, renderStyle);
      var pillClass = w.relationship === 'good' ? 'good' : 'bad';
      var pillText = w.relationship === 'good' ? 'Good' : 'Avoid';
      html += '<div class="companion-popover-row">';
      html +=   '<img class="companion-popover-thumb" src="' + thumb + '" alt="" />';
      html +=   '<div class="companion-popover-text">';
      html +=     '<div class="companion-popover-name">' + escapeHtml(partner.name) +
                  ' <span class="companion-popover-pill ' + pillClass + '">' + pillText + '</span></div>';
      if (w.reason) html += '<div class="companion-popover-reason">' + escapeHtml(w.reason) + '</div>';
      if (w.relationship === 'bad') {
        html += '<button class="companion-popover-dismiss" data-action="dismiss-companion" data-other-plant-id="' +
                partner.id + '">Dismiss for this garden</button>';
      }
      html +=   '</div>';
      html += '</div>';
    } else if (w.type === 'crowd') {
      var neighbor = placements.find(function(p) { return p.id === w.neighborPlacementId; });
      var nplant = neighbor && neighbor.plant;
      if (!nplant) return;
      var nthumb = getPlantThumbnail(nplant, renderStyle);
      html += '<div class="companion-popover-row">';
      html +=   '<img class="companion-popover-thumb" src="' + nthumb + '" alt="" />';
      html +=   '<div class="companion-popover-text">';
      html +=     '<div class="companion-popover-name">' + escapeHtml(nplant.name) + ' is crowding this spot' +
                  ' <span class="companion-popover-pill crowd">Crowded</span></div>';
      html +=     '<button class="companion-popover-dismiss" data-action="dismiss-crowd" data-other-placement-id="' +
                  neighbor.id + '">It\'s fine, dismiss</button>';
      html +=   '</div>';
      html += '</div>';
    }
  });
  visibleShadeRows.forEach(function(w) {
    var shading = placements.find(function(p) { return p.id === w.shadingPlacementId; });
    var splant = shading && shading.plant;
    if (!splant) return;
    var sthumb = getPlantThumbnail(splant, renderStyle);
    var heightInches = splant.height_inches || 12;
    var selfName = (self.plant && self.plant.name) || 'This plant';
    var reason = 'Tall ' + escapeHtml(splant.name) + ' (' + heightInches + '") to the north blocks midday sun. ' +
                 escapeHtml(selfName) + ' needs full sun.';
    html += '<div class="companion-popover-row">';
    html +=   '<img class="companion-popover-thumb" src="' + sthumb + '" alt="" />';
    html +=   '<div class="companion-popover-text">';
    html +=     '<div class="companion-popover-name">' + escapeHtml(splant.name) + ' is shading this spot' +
                ' <span class="companion-popover-pill shade">Shaded</span></div>';
    html +=     '<div class="companion-popover-reason">' + reason + '</div>';
    html +=     '<button class="companion-popover-dismiss" data-action="dismiss-shade" data-shading-placement-id="' +
                shading.id + '">It\'s fine, dismiss</button>';
    html +=   '</div>';
    html += '</div>';
  });
  pop.innerHTML = html;

  var layer = document.getElementById('companion-chips');
  if (layer && layer.parentNode) layer.parentNode.appendChild(pop);
  else document.body.appendChild(pop);

  if (window.lucide) window.lucide.createIcons({ icons: pop });

  pop.addEventListener('click', function(e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    e.stopPropagation();
    var action = btn.dataset.action;
    if (action === 'close') {
      companionPopoverCellKey = null;
      pop.remove();
    } else if (action === 'dismiss-companion') {
      var otherPlantId = btn.dataset.otherPlantId;
      dismissedCompanionWarnings.add(canonicalPairKey('companion', self.plantId, otherPlantId));
      renderCompanionChips();
      renderCompanionPopover();
    } else if (action === 'dismiss-crowd') {
      var otherPlacementId = btn.dataset.otherPlacementId;
      dismissedCompanionWarnings.add(canonicalPairKey('crowd', self.id, otherPlacementId));
      renderCompanionChips();
      renderCompanionPopover();
    } else if (action === 'dismiss-shade') {
      var shadingPlacementId = btn.dataset.shadingPlacementId;
      dismissedCompanionWarnings.add(canonicalPairKey('shade', self.id, shadingPlacementId));
      renderCompanionChips();
      renderCompanionPopover();
    }
  });

  // Outside click / Esc to dismiss — bind once per popover render
  setTimeout(function() {
    function onDocClick(e) {
      if (!pop.contains(e.target) && !e.target.closest('#companion-chips button')) {
        companionPopoverCellKey = null;
        pop.remove();
        document.removeEventListener('mousedown', onDocClick, true);
        document.removeEventListener('keydown', onEsc, true);
      }
    }
    function onEsc(e) {
      if (e.key === 'Escape') {
        companionPopoverCellKey = null;
        pop.remove();
        document.removeEventListener('mousedown', onDocClick, true);
        document.removeEventListener('keydown', onEsc, true);
      }
    }
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onEsc, true);
  }, 0);
}
