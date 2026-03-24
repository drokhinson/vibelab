// touch-drag.js — Touch-based drag and drop for mobile (long-press to pick up)

var _touchDragState = null; // { plant, sourceKey, ghost, startX, startY }
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

function _getCellAt(x, y) {
  var el = document.elementFromPoint(x, y);
  if (!el) return null;
  if (el.classList.contains("grid-cell")) return el;
  var parent = el.closest(".grid-cell");
  return parent;
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
        _touchDragState = { plant: plant, sourceKey: null, ghost: ghost };
        tile.classList.add("dragging");
      }, TOUCH_HOLD_MS);
    }, { passive: false });

    tile.addEventListener("touchmove", function(e) {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (!_touchDragState) return;
      e.preventDefault();
      var touch = e.touches[0];
      _positionGhost(_touchDragState.ghost, touch.clientX, touch.clientY);

      // Highlight cell under finger
      document.querySelectorAll(".grid-cell.drag-over").forEach(function(c) { c.classList.remove("drag-over"); });
      var cell = _getCellAt(touch.clientX, touch.clientY);
      if (cell) cell.classList.add("drag-over");
    }, { passive: false });

    tile.addEventListener("touchend", function(e) {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      tile.classList.remove("dragging");
      if (!_touchDragState) return;

      var touch = e.changedTouches[0];
      var cell = _getCellAt(touch.clientX, touch.clientY);
      document.querySelectorAll(".grid-cell.drag-over").forEach(function(c) { c.classList.remove("drag-over"); });

      if (cell) {
        var x = parseInt(cell.dataset.x);
        var y = parseInt(cell.dataset.y);
        var key = x + "," + y;
        gridPlacements[key] = _touchDragState.plant;
        cell.classList.add("occupied");
        var thumb = getPlantThumbnail(_touchDragState.plant, renderStyle);
        cell.innerHTML = '<img class="cell-thumbnail" src="' + thumb + '" alt="' + escapeHtml(_touchDragState.plant.name) + '" draggable="false" />' +
          '<span class="cell-label">' + escapeHtml(_touchDragState.plant.name) + '</span>';
        sync3DView();
      }
      _removeGhost();
      _touchDragState = null;
    });

    tile.addEventListener("touchcancel", function() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      tile.classList.remove("dragging");
      _removeGhost();
      _touchDragState = null;
    });
  });
}

function bindGridTouch() {
  document.querySelectorAll(".grid-cell").forEach(function(cell) {
    var holdTimer = null;

    cell.addEventListener("touchstart", function(e) {
      var x = parseInt(cell.dataset.x);
      var y = parseInt(cell.dataset.y);
      var key = x + "," + y;
      var plant = gridPlacements[key];
      if (!plant) return;

      var touch = e.touches[0];
      var startX = touch.clientX;
      var startY = touch.clientY;

      holdTimer = setTimeout(function() {
        holdTimer = null;
        e.preventDefault();
        var ghost = _createGhost(plant);
        _positionGhost(ghost, startX, startY);
        _touchDragState = { plant: plant, sourceKey: key, ghost: ghost };
        cell.classList.add("dragging");
      }, TOUCH_HOLD_MS);
    }, { passive: false });

    cell.addEventListener("touchmove", function(e) {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (!_touchDragState) return;
      e.preventDefault();
      var touch = e.touches[0];
      _positionGhost(_touchDragState.ghost, touch.clientX, touch.clientY);

      document.querySelectorAll(".grid-cell.drag-over").forEach(function(c) { c.classList.remove("drag-over"); });
      var target = _getCellAt(touch.clientX, touch.clientY);
      if (target) target.classList.add("drag-over");
    }, { passive: false });

    cell.addEventListener("touchend", function(e) {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      cell.classList.remove("dragging");
      if (!_touchDragState) return;

      var touch = e.changedTouches[0];
      var target = _getCellAt(touch.clientX, touch.clientY);
      document.querySelectorAll(".grid-cell.drag-over").forEach(function(c) { c.classList.remove("drag-over"); });

      if (target) {
        var tx = parseInt(target.dataset.x);
        var ty = parseInt(target.dataset.y);
        var tKey = tx + "," + ty;

        // Clear source cell if moving within grid
        if (_touchDragState.sourceKey && _touchDragState.sourceKey !== tKey) {
          delete gridPlacements[_touchDragState.sourceKey];
          var srcParts = _touchDragState.sourceKey.split(",");
          var srcCell = document.querySelector('.grid-cell[data-x="' + srcParts[0] + '"][data-y="' + srcParts[1] + '"]');
          if (srcCell) {
            srcCell.classList.remove("occupied", "dragging");
            srcCell.removeAttribute("draggable");
            srcCell.innerHTML = "";
          }
        }

        gridPlacements[tKey] = _touchDragState.plant;
        target.classList.add("occupied");
        target.setAttribute("draggable", "true");
        var thumb = getPlantThumbnail(_touchDragState.plant, renderStyle);
        target.innerHTML = '<img class="cell-thumbnail" src="' + thumb + '" alt="' + escapeHtml(_touchDragState.plant.name) + '" draggable="false" />' +
          '<span class="cell-label">' + escapeHtml(_touchDragState.plant.name) + '</span>';
        sync3DView();
      }
      _removeGhost();
      _touchDragState = null;
    });

    cell.addEventListener("touchcancel", function() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      cell.classList.remove("dragging");
      _removeGhost();
      _touchDragState = null;
    });
  });
}
