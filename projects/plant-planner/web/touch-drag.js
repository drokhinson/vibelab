// touch-drag.js — Touch-based drag and drop for mobile (long-press to pick up, drop onto 3D scene)

var _touchDragState = null; // { plant, ghost }
var TOUCH_HOLD_MS = 300;

function _createGhost(plant) {
  var ghost = document.createElement("div");
  ghost.className = "touch-drag-ghost";
  var thumb = getPlantThumbnail(plant, renderStyle);
  ghost.innerHTML = '<img src="' + thumb + '" draggable="false" /><span>' + escapeHtml(plant.name) + '</span>';
  document.body.appendChild(ghost);
  return ghost;
}

function _positionGhost(ghost, x, y) {
  ghost.style.left = (x - 40) + "px";
  ghost.style.top = (y - 40) + "px";
}

function _removeGhost() {
  if (_touchDragState && _touchDragState.ghost) {
    _touchDragState.ghost.remove();
  }
}

function bindCatalogTouch() {
  document.querySelectorAll(".catalog-tile").forEach(function(tile) {
    var holdTimer = null;

    tile.addEventListener("touchstart", function(e) {
      var touch = e.touches[0];
      var startX = touch.clientX;
      var startY = touch.clientY;
      var pid = tile.dataset.plantId;

      holdTimer = setTimeout(function() {
        holdTimer = null;
        var plant = plants.find(function(p) { return p.id === pid; });
        if (!plant) return;
        e.preventDefault();
        var ghost = _createGhost(plant);
        _positionGhost(ghost, startX, startY);
        _touchDragState = { plant: plant, ghost: ghost };
        tile.classList.add("dragging");
      }, TOUCH_HOLD_MS);
    }, { passive: false });

    tile.addEventListener("touchmove", function(e) {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (!_touchDragState) return;
      e.preventDefault();
      var touch = e.touches[0];
      _positionGhost(_touchDragState.ghost, touch.clientX, touch.clientY);

      // Preview disk under finger via 3D raycasting
      if (scene3DHandle) {
        lockBirdsEye(scene3DHandle);
        var pt = getRaycastPoint(scene3DHandle, touch.clientX, touch.clientY);
        if (pt) {
          var plantTouch = _touchDragState.plant;
          var rTouch = (plantTouch.spread_inches || 12) / 24;
          var gw = scene3DHandle.gridWidth;
          var gh = scene3DHandle.gridHeight;
          var oob = pt.x < 0 || pt.x > gw || pt.y < 0 || pt.y > gh;
          var overlaps = false;
          if (!oob && Array.isArray(placements)) {
            for (var i = 0; i < placements.length; i++) {
              var pp = placements[i];
              var dx = pt.x - pp.pos_x, dy = pt.y - pp.pos_y;
              if (Math.hypot(dx, dy) < rTouch + pp.radius_feet) { overlaps = true; break; }
            }
          }
          var valid = oob ? 'oob' : (overlaps ? 'overlap' : 'ok');
          showPreviewDisk(scene3DHandle, pt.x, pt.y, rTouch, valid);
        } else {
          hidePreviewDisk(scene3DHandle);
        }
      }
    }, { passive: false });

    tile.addEventListener("touchend", function(e) {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      tile.classList.remove("dragging");
      if (!_touchDragState) return;

      var touch = e.changedTouches[0];
      var plant = _touchDragState.plant;
      if (scene3DHandle) {
        var pt = getRaycastPoint(scene3DHandle, touch.clientX, touch.clientY);
        hidePreviewDisk(scene3DHandle);
        unlockCamera(scene3DHandle);
        var gw = scene3DHandle.gridWidth;
        var gh = scene3DHandle.gridHeight;
        var inBounds = pt && pt.x >= 0 && pt.x <= gw && pt.y >= 0 && pt.y <= gh;
        if (inBounds) {
          var r = (plant.spread_inches || 12) / 24;
          var newId = (window.crypto && typeof crypto.randomUUID === 'function')
            ? crypto.randomUUID()
            : ('p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
          placements.push({
            id: newId,
            plantId: plant.id,
            plant: plant,
            pos_x: pt.x,
            pos_y: pt.y,
            radius_feet: r
          });
          sync3DView();
          if (typeof renderCompanionChips === 'function') renderCompanionChips();
          if (typeof refreshCatalogList === 'function') refreshCatalogList();
        } else {
          // Released outside the bed — toss the plant onto the ground so it
          // matches the desktop behavior and the picked-up-plant toss arc.
          tossNewPlantToGround(plant, touch.clientX, touch.clientY, scene3DHandle);
        }
      }
      _removeGhost();
      _touchDragState = null;
    });

    tile.addEventListener("touchcancel", function() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      tile.classList.remove("dragging");
      if (scene3DHandle) {
        hidePreviewDisk(scene3DHandle);
        unlockCamera(scene3DHandle);
      }
      _removeGhost();
      _touchDragState = null;
    });
  });
}
