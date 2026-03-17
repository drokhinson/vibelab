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
  html += '<button id="toggle-view" class="outline small-btn">' + (viewMode === "top" ? "Side View" : "Top View") + '</button>';
  html += '<button id="save-garden" class="small-btn">Save</button>';
  html += '<button id="clear-grid" class="secondary outline small-btn">Clear</button>';
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
  // Coordinates label
  html += '<div class="muted" style="text-align:center;margin-top:0.25rem;font-size:0.75rem">Each cell = 1 sq ft</div>';
  return html;
}

function renderSideView(g) {
  var maxH = 84; // max plant height for scaling
  var html = '<div class="side-view">';
  // Render one column per grid x, showing tallest plant in that column
  for (var x = 0; x < g.grid_width; x++) {
    var tallest = null;
    for (var y = 0; y < g.grid_height; y++) {
      var p = gridPlacements[x + "," + y];
      if (p && (!tallest || p.height_inches > tallest.height_inches)) tallest = p;
    }
    var barH = tallest ? Math.max(10, (tallest.height_inches / maxH) * 100) : 0;
    html += '<div class="side-col">';
    if (tallest) {
      html += '<div class="side-bar" style="height:' + barH + '%">';
      html += '<span class="side-emoji">' + tallest.emoji + '</span>';
      html += '<span class="side-label">' + tallest.height_inches + '"</span>';
      html += '</div>';
    } else {
      html += '<div class="side-empty"></div>';
    }
    html += '</div>';
  }
  html += '</div>';
  html += '<div class="muted" style="text-align:center;margin-top:0.25rem;font-size:0.75rem">Tallest plant per column (side elevation)</div>';
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
  document.getElementById("clear-grid").onclick = function() {
    if (!confirm("Clear all plants from this garden?")) return;
    gridPlacements = {};
    renderBuilder();
  };
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
