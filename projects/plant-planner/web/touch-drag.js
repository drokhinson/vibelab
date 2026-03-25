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

      // Highlight cell under finger via 3D raycasting
      if (scene3DHandle) {
        lockBirdsEye(scene3DHandle);
        var cell = getRaycastCell(scene3DHandle, touch.clientX, touch.clientY);
        if (cell) showCellHighlight(scene3DHandle, cell.gx, cell.gy);
        else hideCellHighlight(scene3DHandle);
      }
    }, { passive: false });

    tile.addEventListener("touchend", function(e) {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      tile.classList.remove("dragging");
      if (!_touchDragState) return;

      var touch = e.changedTouches[0];
      if (scene3DHandle) {
        var cell = getRaycastCell(scene3DHandle, touch.clientX, touch.clientY);
        hideCellHighlight(scene3DHandle);
        unlockCamera(scene3DHandle);
        if (cell) {
          gridPlacements[cell.gx + "," + cell.gy] = _touchDragState.plant;
          sync3DView();
        }
      }
      _removeGhost();
      _touchDragState = null;
    });

    tile.addEventListener("touchcancel", function() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      tile.classList.remove("dragging");
      if (scene3DHandle) {
        hideCellHighlight(scene3DHandle);
        unlockCamera(scene3DHandle);
      }
      _removeGhost();
      _touchDragState = null;
    });
  });
}
