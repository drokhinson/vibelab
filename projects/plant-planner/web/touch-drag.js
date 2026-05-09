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

// Offset the floating preview up-and-to-the-left of the touch point so a
// right-thumb user can see the plant they're carrying without their thumb
// covering it. Clamp to the viewport so the ghost can never escape off-screen.
var GHOST_OFFSET_X = 92; // ghost width (80) + 12 px gap
var GHOST_OFFSET_Y = 92; // ≈ ghost height (img + label + gap) + 12 px gap

function _positionGhost(ghost, x, y) {
  var left = Math.max(4, x - GHOST_OFFSET_X);
  var top = Math.max(4, y - GHOST_OFFSET_Y);
  ghost.style.left = left + "px";
  ghost.style.top = top + "px";
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
          var valid = validatePlacement(pt.x, pt.y, rTouch, gw, gh, placements);
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
        unlockCamera(scene3DHandle);
        var gw = scene3DHandle.gridWidth;
        var gh = scene3DHandle.gridHeight;
        var r = (plant.spread_inches || 12) / 24;
        // In-grid drops are validated (overlap / radius-out-of-bounds = reject
        // with red flash). Off-grid drops on the soil/lawn area still toss to
        // ground so the user keeps the existing discard affordance.
        var inGrid = pt && pt.x >= 0 && pt.x <= gw && pt.y >= 0 && pt.y <= gh;
        if (inGrid) {
          var valid = validatePlacement(pt.x, pt.y, r, gw, gh, placements);
          if (valid === 'ok') {
            hidePreviewDisk(scene3DHandle);
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
            showPreviewDisk(scene3DHandle, pt.x, pt.y, r, valid);
            setTimeout(function() { hidePreviewDisk(scene3DHandle); }, 350);
            if (navigator.vibrate) navigator.vibrate(20);
          }
        } else {
          hidePreviewDisk(scene3DHandle);
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
