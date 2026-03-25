// garden.js — Grid builder, drag-drop targets, side view, save

function renderBuilder() {
  if (!currentGarden) { showView("gardens"); return; }
  var g = currentGarden;

  var html = '<div class="builder-header">';
  html += '<div class="builder-title">';
  html += '<h4>' + escapeHtml(g.name) + '</h4>';
  html += '<span class="text-sm opacity-50">' + g.grid_width + '×' + g.grid_height + ' ft</span>';
  html += '</div>';
  html += '<div class="builder-actions">';
  html += '<button id="save-garden" class="btn btn-sm btn-primary gap-1"><i data-lucide="save"></i> Save</button>';
  html += '<button id="reseed-garden" class="btn btn-sm btn-outline gap-1"><i data-lucide="refresh-cw"></i> Reseed</button>';
  html += '</div></div>';

  html += '<div class="builder-layout">';

  // Catalog sidebar with separate filter and list sections
  html += '<div id="catalog-sidebar" class="catalog-sidebar">';
  html += '<div class="catalog-filters">' + renderCatalogFilters() + '</div>';
  html += '<div class="catalog-list-wrapper" id="catalog-list-wrapper">' + renderCatalogList() + '</div>';
  html += '</div>';

  html += '<div class="builder-main">';

  // Split pane: 2D grid + 3D render
  html += '<div class="split-pane">';
  html += '<div class="grid-area">';
  html += renderTopGrid(g);
  html += '</div>';

  // 3D render pane (style selector moved to settings)
  html += '<div class="render3d-pane">';
  html += '<div class="render3d-header">';
  html += '<span class="render3d-label"><i data-lucide="box"></i> 3D View</span>';
  html += '</div>';
  html += '<div id="render3d-container"></div>';
  html += '</div>';

  html += '</div>'; // .split-pane
  html += '</div>'; // .builder-main
  html += '</div>'; // .builder-layout

  // Plant info tooltip
  html += '<div id="plant-tooltip" class="plant-tooltip" style="display:none"></div>';

  app.innerHTML = html;

  bindCatalogEvents();
  bindGridEvents(g);
  bindBuilderButtons();
  _initIcons();

  // Initialize or update 3D scene
  init3DScene(g);
}

function renderTopGrid(g) {
  var html = '<div class="garden-grid" style="grid-template-columns:repeat(' + g.grid_width + ',1fr)">';
  for (var y = 0; y < g.grid_height; y++) {
    for (var x = 0; x < g.grid_width; x++) {
      var key = x + "," + y;
      var plant = gridPlacements[key];
      var cellContent = "";
      var cellClass = "grid-cell";
      var cellDrag = "";
      if (plant) {
        var thumb = getPlantThumbnail(plant, renderStyle);
        cellContent = '<img class="cell-thumbnail" src="' + thumb + '" alt="' + escapeHtml(plant.name) + '" draggable="false" />' +
          '<span class="cell-label">' + escapeHtml(plant.name) + '</span>';
        cellClass += " occupied";
        cellDrag = ' draggable="true"';
      }
      html += '<div class="' + cellClass + '"' + cellDrag + ' data-x="' + x + '" data-y="' + y + '">' + cellContent + '</div>';
    }
  }
  html += '</div>';
  html += '<div class="text-center text-xs opacity-40 mt-1">Each cell = 1 sq ft</div>';
  return html;
}


function bindGridEvents(g) {
  document.querySelectorAll(".grid-cell").forEach(function(cell) {
    // Drag start for occupied cells (moving plants within grid)
    cell.ondragstart = function(e) {
      var x = parseInt(cell.dataset.x);
      var y = parseInt(cell.dataset.y);
      var key = x + "," + y;
      var plant = gridPlacements[key];
      if (plant) {
        draggedPlant = plant;
        dragSourceKey = key;
        e.dataTransfer.setData("text/plain", plant.id);
        e.dataTransfer.effectAllowed = "move";
        cell.classList.add("dragging");
      }
    };
    cell.ondragend = function() {
      cell.classList.remove("dragging");
      dragSourceKey = null;
      draggedPlant = null;
    };
    cell.ondragover = function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = dragSourceKey ? "move" : "copy";
      cell.classList.add("drag-over");
    };
    cell.ondragleave = function() {
      cell.classList.remove("drag-over");
    };
    cell.ondrop = function(e) {
      e.preventDefault();
      cell.classList.remove("drag-over");
      var x = parseInt(cell.dataset.x);
      var y = parseInt(cell.dataset.y);
      var key = x + "," + y;
      if (draggedPlant) {
        // If moving within grid, clear source cell
        if (dragSourceKey && dragSourceKey !== key) {
          delete gridPlacements[dragSourceKey];
          var srcParts = dragSourceKey.split(",");
          var sourceCell = document.querySelector('.grid-cell[data-x="' + srcParts[0] + '"][data-y="' + srcParts[1] + '"]');
          if (sourceCell) {
            sourceCell.classList.remove("occupied", "dragging");
            sourceCell.removeAttribute("draggable");
            sourceCell.innerHTML = "";
          }
        }
        // Place plant in target cell
        gridPlacements[key] = draggedPlant;
        cell.classList.add("occupied");
        cell.setAttribute("draggable", "true");
        var thumb = getPlantThumbnail(draggedPlant, renderStyle);
        cell.innerHTML = '<img class="cell-thumbnail" src="' + thumb + '" alt="' + escapeHtml(draggedPlant.name) + '" draggable="false" />' +
          '<span class="cell-label">' + escapeHtml(draggedPlant.name) + '</span>';
        dragSourceKey = null;
        sync3DView();
      }
    };
    cell.onclick = function() {
      // Don't remove if we just finished a drag
      if (cell.classList.contains("dragging")) return;
      var x = parseInt(cell.dataset.x);
      var y = parseInt(cell.dataset.y);
      var key = x + "," + y;
      if (gridPlacements[key]) {
        delete gridPlacements[key];
        cell.classList.remove("occupied");
        cell.removeAttribute("draggable");
        cell.innerHTML = "";
        sync3DView();
      }
    };
    cell.onmouseenter = function() {
      var x = parseInt(cell.dataset.x);
      var y = parseInt(cell.dataset.y);
      var key = x + "," + y;
      var p = gridPlacements[key];
      if (p) showTooltip(cell, p);
    };
    cell.onmouseleave = function() { hideTooltip(); };
  });
  bindGridTouch();
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

function init3DScene(g) {
  if (scene3DHandle) {
    dispose3DView(scene3DHandle);
    scene3DHandle = null;
  }
  // Double RAF ensures CSS layout (including media queries) is fully committed
  // before reading container dimensions — a single RAF can fire before the browser
  // has reflowed the new DOM inserted via innerHTML, returning clientWidth = 0.
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      scene3DHandle = init3DView("render3d-container", g, gridPlacements);
    });
  });
}

function sync3DView() {
  if (scene3DHandle) {
    syncSceneWithPlacements(scene3DHandle, gridPlacements);
  }
}

function bindBuilderButtons() {
  document.getElementById("save-garden").onclick = saveGarden;
  document.getElementById("reseed-garden").onclick = reseedGarden;
}

async function saveGarden() {
  var btn = document.getElementById("save-garden");
  btn.classList.add("loading");
  btn.disabled = true;
  var placements = [];
  for (var key in gridPlacements) {
    var parts = key.split(",");
    placements.push({
      plant_id: gridPlacements[key].id,
      grid_x: parseInt(parts[0]),
      grid_y: parseInt(parts[1])
    });
  }
  try {
    await apiFetch("/gardens/" + currentGarden.id + "/plants", {
      method: "PUT",
      body: { plants: placements }
    });
    btn.textContent = "Saved!";
    setTimeout(function() { btn.innerHTML = '<i data-lucide="save"></i> Save'; _initIcons(); }, 1500);
  } catch (err) {
    alert("Save failed: " + err.message);
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}

async function reseedGarden() {
  if (!confirm("Reseed for next season? This will clear all current plants and save an empty garden.")) return;
  var btn = document.getElementById("reseed-garden");
  btn.classList.add("loading");
  btn.disabled = true;
  try {
    await apiFetch("/gardens/" + currentGarden.id + "/plants", {
      method: "PUT",
      body: { plants: [] }
    });
    gridPlacements = {};
    btn.textContent = "Reseeded!";
    setTimeout(function() {
      btn.innerHTML = '<i data-lucide="refresh-cw"></i> Reseed';
      _initIcons();
      renderBuilder();
    }, 1200);
  } catch (err) {
    alert("Reseed failed: " + err.message);
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}
