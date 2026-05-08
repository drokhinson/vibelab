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

function computeWarningsForGrid(placements) {
  var result = {};
  if (!placements) return result;
  Object.keys(placements).forEach(function(cellKey) {
    var self = placements[cellKey];
    if (!self) return;
    var parts = cellKey.split(',');
    var x = parseInt(parts[0], 10), y = parseInt(parts[1], 10);
    var neighbors = [[x-1,y],[x+1,y],[x,y-1],[x,y+1]];
    neighbors.forEach(function(nb) {
      var nbKey = nb[0] + ',' + nb[1];
      var other = placements[nbKey];
      if (!other) return;
      var rel = getCompanionRelationship(self.id, other.id);
      if (rel === 'good' || rel === 'bad') {
        (result[cellKey] = result[cellKey] || []).push({
          neighborCellKey: nbKey, neighborPlantId: other.id, relationship: rel, reason: ''
        });
      }
    });
  });
  // Attach reason text from companions rows (we lost it above to keep the inner loop clean — re-attach):
  Object.keys(result).forEach(function(cellKey) {
    var self = placements[cellKey];
    result[cellKey].forEach(function(w) {
      var entries = companionsByPlantId[self.id] || [];
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].otherId === w.neighborPlantId) { w.reason = entries[i].reason; break; }
      }
    });
  });
  return result;
}

function canonicalPairKey(aId, bId) {
  return aId < bId ? aId + ':' + bId : bId + ':' + aId;
}

// ── DOM-touching companion-warning UI (chips + popover) ────────────────────

function renderCompanionChips() {
  var layer = document.getElementById('companion-chips');
  if (!layer || !scene3DHandle) return;
  var warnings = computeWarningsForGrid(gridPlacements);
  var html = '';
  Object.keys(warnings).forEach(function(cellKey) {
    var rows = warnings[cellKey];
    var selfId = gridPlacements[cellKey] && gridPlacements[cellKey].id;
    var hasBad = rows.some(function(w) {
      return w.relationship === 'bad' && !dismissedCompanionWarnings.has(canonicalPairKey(selfId, w.neighborPlantId));
    });
    var hasGood = rows.some(function(w) { return w.relationship === 'good'; });
    var type = hasBad ? 'warning' : (hasGood ? 'good' : null);
    if (!type) return;
    var pos = projectCellToScreen(cellKey);
    if (!pos) return;
    var icon = type === 'warning' ? 'alert-triangle' : 'sparkles';
    html += '<button class="companion-chip-' + type + '" data-cell-key="' + cellKey +
            '" style="left:' + pos.x + 'px;top:' + pos.y + 'px"><i data-lucide="' + icon + '"></i></button>';
  });
  layer.innerHTML = html;
  if (window.lucide) window.lucide.createIcons({ icons: layer });
  Array.prototype.forEach.call(layer.querySelectorAll('button'), function(btn) {
    btn.onclick = function(e) {
      e.stopPropagation();
      companionPopoverCellKey = btn.dataset.cellKey;
      renderCompanionPopover();
    };
  });
  if (companionPopoverCellKey) renderCompanionPopover();
  // Schedule re-positioning on the next frame while builder is mounted.
  // Bail out of the rAF loop when #companion-chips is no longer in the DOM.
  if (!_companionRafScheduled) {
    _companionRafScheduled = true;
    requestAnimationFrame(function step() {
      var layer2 = document.getElementById('companion-chips');
      if (!layer2) { _companionRafScheduled = false; return; }
      Array.prototype.forEach.call(layer2.querySelectorAll('button'), function(btn) {
        var pos = projectCellToScreen(btn.dataset.cellKey);
        if (pos) { btn.style.left = pos.x + 'px'; btn.style.top = pos.y + 'px'; }
      });
      // Keep popover anchored too
      var pop = document.getElementById('companion-popover');
      if (pop && companionPopoverCellKey) {
        var p = projectCellToScreen(companionPopoverCellKey);
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

function projectCellToScreen(cellKey) {
  if (!scene3DHandle || !scene3DHandle.renderer || !scene3DHandle.camera) return null;
  var parts = cellKey.split(',');
  var gx = parseInt(parts[0], 10);
  var gy = parseInt(parts[1], 10);
  var v = sceneCellWorldPosition(scene3DHandle, gx, gy);
  if (!v) return null;
  var canvas = scene3DHandle.renderer.domElement;
  var rect = canvas.getBoundingClientRect();
  var layer = document.getElementById('companion-chips');
  var layerRect = layer ? layer.getBoundingClientRect() : rect;
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
  var cellKey = companionPopoverCellKey;
  var self = gridPlacements[cellKey];
  if (!self) { companionPopoverCellKey = null; return; }
  var warnings = computeWarningsForGrid(gridPlacements);
  var rows = warnings[cellKey] || [];
  // Filter out dismissed bad pairs (still show good rows)
  var visibleRows = rows.filter(function(w) {
    if (w.relationship === 'bad') {
      return !dismissedCompanionWarnings.has(canonicalPairKey(self.id, w.neighborPlantId));
    }
    return true;
  });
  if (visibleRows.length === 0) { companionPopoverCellKey = null; return; }

  var pos = projectCellToScreen(cellKey);
  if (!pos) return;

  var pop = document.createElement('div');
  pop.id = 'companion-popover';
  pop.className = 'companion-popover';
  pop.style.position = 'absolute';
  pop.style.left = (pos.x + 14) + 'px';
  pop.style.top = (pos.y + 14) + 'px';

  var html = '<button class="companion-popover-close" aria-label="Close" data-action="close"><i data-lucide="x" style="width:14px;height:14px"></i></button>';
  visibleRows.forEach(function(w) {
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
      html += '<button class="companion-popover-dismiss" data-action="dismiss" data-other-id="' +
              partner.id + '">Dismiss for this garden</button>';
    }
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
    } else if (action === 'dismiss') {
      var otherId = btn.dataset.otherId;
      dismissedCompanionWarnings.add(canonicalPairKey(self.id, otherId));
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
