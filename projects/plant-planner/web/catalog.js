// catalog.js — Plant catalog sidebar rendering + drag source

function renderCatalogFilters() {
  // Gather unique categories for the dropdown
  var cats = [];
  for (var i = 0; i < plants.length; i++) {
    if (plants[i].category && cats.indexOf(plants[i].category) === -1) {
      cats.push(plants[i].category);
    }
  }
  cats.sort();

  var html = '<div class="catalog-filters-title"><i data-lucide="leaf" style="width:0.9em;height:0.9em"></i> Plants</div>';

  // Sunlight filter
  html += '<select id="catalog-filter-sun" class="select select-bordered select-xs w-full">';
  html += '<option value="all"' + (catalogFilter === "all" ? " selected" : "") + '>All light</option>';
  html += '<option value="full_sun"' + (catalogFilter === "full_sun" ? " selected" : "") + '>Full Sun</option>';
  html += '<option value="partial"' + (catalogFilter === "partial" ? " selected" : "") + '>Partial</option>';
  html += '<option value="shade"' + (catalogFilter === "shade" ? " selected" : "") + '>Shade</option>';
  html += '</select>';

  // Bloom season filter
  html += '<select id="catalog-filter-season" class="select select-bordered select-xs w-full">';
  html += '<option value="all"' + (catalogFilterSeason === "all" ? " selected" : "") + '>All seasons</option>';
  html += '<option value="spring"' + (catalogFilterSeason === "spring" ? " selected" : "") + '>Spring</option>';
  html += '<option value="summer"' + (catalogFilterSeason === "summer" ? " selected" : "") + '>Summer</option>';
  html += '<option value="fall"' + (catalogFilterSeason === "fall" ? " selected" : "") + '>Fall</option>';
  html += '<option value="winter"' + (catalogFilterSeason === "winter" ? " selected" : "") + '>Winter</option>';
  html += '</select>';

  // Category filter
  html += '<select id="catalog-filter-cat" class="select select-bordered select-xs w-full">';
  html += '<option value="all"' + (catalogFilterCategory === "all" ? " selected" : "") + '>All types</option>';
  for (var j = 0; j < cats.length; j++) {
    var c = cats[j];
    var label = c.charAt(0).toUpperCase() + c.slice(1);
    html += '<option value="' + c + '"' + (catalogFilterCategory === c ? " selected" : "") + '>' + label + '</option>';
  }
  html += '</select>';

  return html;
}

function renderCatalogList() {
  var filtered = plants.filter(function(p) {
    var sunOk = catalogFilter === "all" || p.sunlight === catalogFilter;
    var seasonOk = catalogFilterSeason === "all" ||
      (p.bloom_season && p.bloom_season.indexOf(catalogFilterSeason) !== -1);
    var catOk = catalogFilterCategory === "all" || p.category === catalogFilterCategory;
    return sunOk && seasonOk && catOk;
  });

  var html = '<div class="catalog-list">';
  for (var k = 0; k < filtered.length; k++) {
    var p = filtered[k];
    var catThumb = getPlantThumbnail(p, renderStyle);
    html += '\
      <div class="catalog-tile" draggable="true" data-plant-id="' + p.id + '" style="--i:' + k + '">\
        <img class="catalog-thumbnail" src="' + catThumb + '" alt="' + escapeHtml(p.name) + '" draggable="false" />\
        <div class="catalog-info">\
          <span class="catalog-name">' + escapeHtml(p.name) + '</span>\
          <span class="catalog-meta">' + sunlightIcon(p.sunlight) + ' ' + p.height_inches + '"h</span>\
        </div>\
      </div>';
  }
  if (filtered.length === 0) {
    html += '<div class="text-center text-sm py-4 opacity-50">No plants match filters</div>';
  }
  html += '</div>';
  return html;
}

function bindCatalogEvents() {
  var sunEl = document.getElementById("catalog-filter-sun");
  if (sunEl) {
    sunEl.onchange = function(e) {
      catalogFilter = e.target.value;
      refreshCatalogList();
    };
  }
  var seasonEl = document.getElementById("catalog-filter-season");
  if (seasonEl) {
    seasonEl.onchange = function(e) {
      catalogFilterSeason = e.target.value;
      refreshCatalogList();
    };
  }
  var catEl = document.getElementById("catalog-filter-cat");
  if (catEl) {
    catEl.onchange = function(e) {
      catalogFilterCategory = e.target.value;
      refreshCatalogList();
    };
  }
  bindCatalogDrag();
}

function refreshCatalogList() {
  var listWrapper = document.getElementById("catalog-list-wrapper");
  if (listWrapper) listWrapper.innerHTML = renderCatalogList();
  bindCatalogDrag();
  _initIcons();
}

function refreshCatalog() {
  var sidebar = document.getElementById("catalog-sidebar");
  if (sidebar) {
    var filtersEl = sidebar.querySelector(".catalog-filters");
    if (filtersEl) filtersEl.innerHTML = renderCatalogFilters();
    var listWrapper = document.getElementById("catalog-list-wrapper");
    if (listWrapper) listWrapper.innerHTML = renderCatalogList();
  }
  bindCatalogEvents();
  bindCatalogDrag();
  _initIcons();
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
