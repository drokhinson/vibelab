// garden.js — Grid builder, drag-drop targets, side view, save

function renderBuilder() {
  if (!currentGarden) { showView("gardens"); return; }
  var g = currentGarden;

  var html = '<div class="builder-header">';
  html += '<div class="builder-title">';
  html += '<h4>' + escapeHtml(g.name) + '</h4>';
  html += '<span class="muted">' + g.grid_width + '×' + g.grid_height + ' ft</span>';
  html += '</div>';
  html += '<div class="builder-actions">';
  html += '<button id="toggle-view" class="outline small-btn"><i data-lucide="' + (viewMode === "top" ? "layers" : "grid-2x2") + '"></i> ' + (viewMode === "top" ? "Side View" : "Top View") + '</button>';
  html += '<button id="save-garden" class="small-btn"><i data-lucide="save"></i> Save</button>';
  html += '<button id="reseed-garden" class="secondary outline small-btn"><i data-lucide="refresh-cw"></i> Reseed</button>';
  html += '<button id="clear-grid" class="secondary outline small-btn"><i data-lucide="trash-2"></i> Clear</button>';
  html += '</div></div>';

  html += '<div class="builder-layout">';
  html += '<div id="catalog-sidebar" class="catalog-sidebar">' + renderCatalog() + '</div>';
  html += '<div class="grid-area">';
  if (viewMode === "top") {
    html += renderTopGrid(g);
  } else {
    html += renderSideView(g);
  }
  html += '</div></div>';

  // Plant info tooltip
  html += '<div id="plant-tooltip" class="plant-tooltip" style="display:none"></div>';

  app.innerHTML = html;

  bindCatalogEvents();
  bindGridEvents(g);
  bindBuilderButtons();
  _initIcons();
}

function renderTopGrid(g) {
  var html = '<div class="garden-grid" style="grid-template-columns:repeat(' + g.grid_width + ',1fr)">';
  for (var y = 0; y < g.grid_height; y++) {
    for (var x = 0; x < g.grid_width; x++) {
      var key = x + "," + y;
      var plant = gridPlacements[key];
      var cellContent = "";
      var cellClass = "grid-cell";
      if (plant) {
        cellContent = '<span class="cell-emoji">' + plant.emoji + '</span>';
        cellClass += " occupied";
      }
      html += '<div class="' + cellClass + '" data-x="' + x + '" data-y="' + y + '">' + cellContent + '</div>';
    }
  }
  html += '</div>';
  html += '<div class="muted" style="text-align:center;margin-top:0.25rem;font-size:0.75rem">Each cell = 1 sq ft</div>';
  return html;
}

function renderSideView(g) {
  var maxH = 84; // max plant height for scaling

  // Compass angle buttons
  var angles = [
    { id: "south", label: '<i data-lucide="arrow-up"></i> S' },
    { id: "north", label: '<i data-lucide="arrow-down"></i> N' },
    { id: "east",  label: '<i data-lucide="arrow-right"></i> E' },
    { id: "west",  label: '<i data-lucide="arrow-left"></i> W' }
  ];
  var html = '<div class="side-compass">';
  for (var a = 0; a < angles.length; a++) {
    var ang = angles[a];
    var active = sideViewAngle === ang.id ? " active" : "";
    html += '<button class="compass-btn' + active + '" data-angle="' + ang.id + '">' + ang.label + '</button>';
  }
  html += '</div>';

  // Build the column list based on angle
  // Each "slice" is the profile seen from that direction
  var slices = [];
  if (sideViewAngle === "south" || sideViewAngle === "north") {
    // Looking along y-axis — each column is an x position
    var xStart = sideViewAngle === "south" ? 0 : g.grid_width - 1;
    var xEnd   = sideViewAngle === "south" ? g.grid_width : -1;
    var xStep  = sideViewAngle === "south" ? 1 : -1;
    for (var x = xStart; x !== xEnd; x += xStep) {
      var tallest = null;
      for (var y = 0; y < g.grid_height; y++) {
        var p = gridPlacements[x + "," + y];
        if (p && (!tallest || p.height_inches > tallest.height_inches)) tallest = p;
      }
      slices.push(tallest);
    }
  } else {
    // Looking along x-axis — each column is a y position
    var yStart = sideViewAngle === "east" ? 0 : g.grid_height - 1;
    var yEnd   = sideViewAngle === "east" ? g.grid_height : -1;
    var yStep  = sideViewAngle === "east" ? 1 : -1;
    for (var yi = yStart; yi !== yEnd; yi += yStep) {
      var tallestY = null;
      for (var xi = 0; xi < g.grid_width; xi++) {
        var pY = gridPlacements[xi + "," + yi];
        if (pY && (!tallestY || pY.height_inches > tallestY.height_inches)) tallestY = pY;
      }
      slices.push(tallestY);
    }
  }

  html += '<div class="side-view">';
  for (var s = 0; s < slices.length; s++) {
    var tallestSlice = slices[s];
    var barH = tallestSlice ? Math.max(10, (tallestSlice.height_inches / maxH) * 100) : 0;
    html += '<div class="side-col">';
    if (tallestSlice) {
      html += '<div class="side-bar" style="height:' + barH + '%">';
      html += '<span class="side-emoji">' + tallestSlice.emoji + '</span>';
      html += '<span class="side-label">' + tallestSlice.height_inches + '"</span>';
      html += '</div>';
    } else {
      html += '<div class="side-empty"></div>';
    }
    html += '</div>';
  }
  html += '</div>';

  var dirLabel = { south: "looking North", north: "looking South", east: "looking West", west: "looking East" };
  html += '<div class="muted" style="text-align:center;margin-top:0.25rem;font-size:0.75rem">Elevation — ' + dirLabel[sideViewAngle] + '</div>';
  return html;
}

function bindGridEvents(g) {
  document.querySelectorAll(".grid-cell").forEach(function(cell) {
    cell.ondragover = function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
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
        gridPlacements[key] = draggedPlant;
        renderBuilder();
      }
    };
    // Click to remove plant
    cell.onclick = function() {
      var x = parseInt(cell.dataset.x);
      var y = parseInt(cell.dataset.y);
      var key = x + "," + y;
      if (gridPlacements[key]) {
        delete gridPlacements[key];
        renderBuilder();
      }
    };
    // Hover to show info
    cell.onmouseenter = function() {
      var x = parseInt(cell.dataset.x);
      var y = parseInt(cell.dataset.y);
      var key = x + "," + y;
      var p = gridPlacements[key];
      if (p) showTooltip(cell, p);
    };
    cell.onmouseleave = function() { hideTooltip(); };
  });
}

function bindCompassButtons() {
  document.querySelectorAll(".compass-btn").forEach(function(btn) {
    btn.onclick = function() {
      sideViewAngle = btn.dataset.angle;
      var gridArea = document.querySelector(".grid-area");
      if (gridArea) gridArea.innerHTML = renderSideView(currentGarden);
      bindCompassButtons();
      _initIcons();
    };
  });
}

function showTooltip(el, plant) {
  var tip = document.getElementById("plant-tooltip");
  if (!tip) return;
  tip.innerHTML =
    '<strong>' + plant.emoji + ' ' + escapeHtml(plant.name) + '</strong><br>' +
    sunlightIcon(plant.sunlight) + ' ' + sunlightLabel(plant.sunlight) +
    ' | ' + plant.height_inches + '" tall' +
    (plant.description ? '<br><span class="muted">' + escapeHtml(plant.description) + '</span>' : '');
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
  document.getElementById("toggle-view").onclick = function() {
    viewMode = viewMode === "top" ? "side" : "top";
    renderBuilder();
  };
  document.getElementById("save-garden").onclick = saveGarden;
  document.getElementById("reseed-garden").onclick = reseedGarden;
  document.getElementById("clear-grid").onclick = function() {
    if (!confirm("Clear all plants from this garden?")) return;
    gridPlacements = {};
    renderBuilder();
  };
  if (viewMode === "side") bindCompassButtons();
}

async function saveGarden() {
  var btn = document.getElementById("save-garden");
  btn.setAttribute("aria-busy", "true");
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
    setTimeout(function() { btn.textContent = "Save"; }, 1500);
  } catch (err) {
    alert("Save failed: " + err.message);
  } finally {
    btn.setAttribute("aria-busy", "false");
    btn.disabled = false;
  }
}

async function reseedGarden() {
  if (!confirm("Reseed for next season? This will clear all current plants and save an empty garden.")) return;
  var btn = document.getElementById("reseed-garden");
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;
  try {
    await apiFetch("/gardens/" + currentGarden.id + "/plants", {
      method: "PUT",
      body: { plants: [] }
    });
    gridPlacements = {};
    btn.textContent = "Reseeded!";
    setTimeout(function() {
      btn.textContent = "Reseed";
      renderBuilder();
    }, 1200);
  } catch (err) {
    alert("Reseed failed: " + err.message);
  } finally {
    btn.setAttribute("aria-busy", "false");
    btn.disabled = false;
  }
}
