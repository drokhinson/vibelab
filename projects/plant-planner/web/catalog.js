// catalog.js — Plant catalog sidebar rendering + drag source

function renderCatalog() {
  var filtered = plants;
  if (catalogFilter !== "all") {
    filtered = plants.filter(function(p) { return p.sunlight === catalogFilter; });
  }

  var html = '<div class="catalog-header">';
  html += '<h5>Plants</h5>';
  html += '<select id="catalog-filter" class="catalog-filter-select">';
  html += '<option value="all"' + (catalogFilter === "all" ? " selected" : "") + '>All</option>';
  html += '<option value="full_sun"' + (catalogFilter === "full_sun" ? " selected" : "") + '>Full Sun</option>';
  html += '<option value="partial"' + (catalogFilter === "partial" ? " selected" : "") + '>Partial</option>';
  html += '<option value="shade"' + (catalogFilter === "shade" ? " selected" : "") + '>Shade</option>';
  html += '</select></div>';

  html += '<div class="catalog-list">';
  for (var i = 0; i < filtered.length; i++) {
    var p = filtered[i];
    html += '\
      <div class="catalog-tile" draggable="true" data-plant-id="' + p.id + '">\
        <span class="catalog-emoji">' + p.emoji + '</span>\
        <div class="catalog-info">\
          <span class="catalog-name">' + escapeHtml(p.name) + '</span>\
          <span class="catalog-meta">' + sunlightIcon(p.sunlight) + ' ' + p.height_inches + '"h</span>\
        </div>\
      </div>';
  }
  if (filtered.length === 0) {
    html += '<div class="muted" style="padding:1rem;text-align:center">No plants match filter</div>';
  }
  html += '</div>';
  return html;
}

function bindCatalogEvents() {
  var filterEl = document.getElementById("catalog-filter");
  if (filterEl) {
    filterEl.onchange = function(e) {
      catalogFilter = e.target.value;
      var sidebar = document.getElementById("catalog-sidebar");
      if (sidebar) sidebar.innerHTML = renderCatalog();
      bindCatalogEvents();
      bindCatalogDrag();
    };
  }
  bindCatalogDrag();
}

function bindCatalogDrag() {
  document.querySelectorAll(".catalog-tile").forEach(function(tile) {
    tile.ondragstart = function(e) {
      var pid = tile.dataset.plantId;
      draggedPlant = plants.find(function(p) { return p.id === pid; });
      e.dataTransfer.setData("text/plain", pid);
      e.dataTransfer.effectAllowed = "copy";
    };
    tile.ondragend = function() {
      draggedPlant = null;
    };
  });
}

function getPlantById(id) {
  return plants.find(function(p) { return p.id === id; });
}
