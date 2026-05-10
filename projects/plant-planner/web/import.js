// import.js — "Import plants" view (currentView === "import").
//
// Standalone version of the wizard's catalog-fill orchestration. The user
// picks the same conditions the wizard collects (light, water, zone, season,
// edible) without committing to a planter; we then run the /catalog/fill
// endpoints (perenual + compatible) so new species land in the cache and
// become searchable from the browser.
//
// Reuses runFillStep / renderFillProgress / renderFilterChipRow from
// helpers.js. There is no "save planter" step here — orchestration starts at
// Perenual.

var importState = {
  filters: {
    shade_level:     null,
    water_plan:      null,
    usda_zone:       '',
    planting_season: null,
    edible:          false,
  },
  fillSteps: null,
  fillFinished: false,
  busy: false,
};

var IMPORT_FILL_STEP_BLUEPRINTS = [
  { key: 'perenual',   label: 'Loading plants from Perenual (with full species details)' },
  { key: 'compatible', label: 'Counting plants compatible with these conditions' },
];

var IMPORT_LIGHT_OPTIONS = [
  { value: 'full_sun',       label: 'Full sun',     icon: '☀️' },
  { value: 'sun-part_shade', label: 'Sun & part',   icon: '🌤️' },
  { value: 'part_shade',     label: 'Part shade',   icon: '⛅' },
  { value: 'full_shade',     label: 'Full shade',   icon: '☁️' },
];
var IMPORT_WATER_OPTIONS = [
  { value: 'frequent', label: 'Frequent', icon: '💧💧💧' },
  { value: 'average',  label: 'Average',  icon: '💧💧' },
  { value: 'minimum',  label: 'Minimum',  icon: '💧' },
  { value: 'none',     label: 'None' },
];
var IMPORT_SEASON_OPTIONS = [
  { value: 'spring', label: 'Spring', icon: '🌷' },
  { value: 'summer', label: 'Summer', icon: '☀️' },
  { value: 'fall',   label: 'Fall',   icon: '🍂' },
  { value: 'winter', label: 'Winter', icon: '❄️' },
];


// ── Entry ───────────────────────────────────────────────────────────────────

function renderImport() {
  // If the orchestration is mid-run, keep showing the progress card so a
  // re-render (e.g. navbar reflow) doesn't drop the to-do list.
  if (importState.fillSteps) {
    renderFillProgress(importState, _importRenderOpts());
    return;
  }
  _renderImportForm();
}

function _renderImportForm() {
  var f = importState.filters;
  var html = '<div class="import-view">';
  html += '<div class="import-header">';
  html += '<button type="button" class="btn btn-ghost btn-sm gap-1" id="import-cancel">'
       +    '<i data-lucide="arrow-left" style="width:1em;height:1em"></i> Back to browser'
       +  '</button>';
  html += '<h3>Import more plants</h3>';
  html += '<p class="import-subtitle">Pull species matching these conditions from Trefle / Perenual / FloraAPI into the catalog. This usually takes 30–60 seconds.</p>';
  html += '</div>';

  html += '<div class="import-form">';
  html += renderFilterChipRow('Light',    IMPORT_LIGHT_OPTIONS,  f.shade_level,     'shade_level');
  html += renderFilterChipRow('Water',    IMPORT_WATER_OPTIONS,  f.water_plan,      'water_plan');
  html += renderFilterChipRow('Season',   IMPORT_SEASON_OPTIONS, f.planting_season, 'planting_season');

  html += '<div class="filter-group">';
  html +=   '<div class="filter-group-label">Hardiness zone (optional)</div>';
  html +=   '<input type="text" id="import-filter-zone" class="browser-zone-input" placeholder="e.g. 6b" value="' + escapeHtml(f.usda_zone || '') + '" />';
  html += '</div>';

  html += '<div class="filter-group" data-filter-group="edible">';
  html +=   '<div class="filter-group-label">Edible</div>';
  html +=   '<div class="filter-row">';
  html +=     '<button type="button" class="chip toggle' + (f.edible ? ' active' : '') + '" data-filter-value="true">'
       +       '🥗 Edible only'
       +     '</button>';
  html +=   '</div>';
  html += '</div>';
  html += '</div>';

  html += '<div class="import-actions">';
  html +=   '<button type="button" class="btn btn-primary gap-1" id="import-run"' + (importState.busy ? ' disabled' : '') + '>'
       +     '<i data-lucide="download-cloud" style="width:1em;height:1em"></i> Run import'
       +   '</button>';
  html += '</div>';
  html += '</div>';

  app.innerHTML = html;
  _bindImportFormEvents();
  _initIcons();
}

function _bindImportFormEvents() {
  var cancel = document.getElementById('import-cancel');
  if (cancel) cancel.onclick = function() { showView('browser'); };

  var root = document.querySelector('.import-form');
  bindFilterChipRow(root, 'shade_level', function(v) {
    importState.filters.shade_level = v; _renderImportForm();
  });
  bindFilterChipRow(root, 'water_plan', function(v) {
    importState.filters.water_plan = v; _renderImportForm();
  });
  bindFilterChipRow(root, 'planting_season', function(v) {
    importState.filters.planting_season = v; _renderImportForm();
  });

  var zoneInput = document.getElementById('import-filter-zone');
  if (zoneInput) zoneInput.oninput = function() {
    importState.filters.usda_zone = zoneInput.value.trim();
  };

  var ediblePanel = root && root.querySelector('[data-filter-group="edible"]');
  if (ediblePanel) {
    ediblePanel.querySelectorAll('.chip').forEach(function(btn) {
      btn.onclick = function() {
        importState.filters.edible = !importState.filters.edible;
        _renderImportForm();
      };
    });
  }

  var runBtn = document.getElementById('import-run');
  if (runBtn) runBtn.onclick = _runImportFillSequence;
}


// ── Orchestration ───────────────────────────────────────────────────────────

function _importRenderOpts() {
  return {
    title: 'Importing plants…',
    subtitle: 'Fetching matching species from each source. New plants are added to the catalog as they arrive.',
    continueLabel: 'Back to browser',
    onContinue: function() {
      // Reset for next time, then bounce to browser and refresh the grid.
      importState.fillSteps = null;
      importState.fillFinished = false;
      importState.busy = false;
      // Carry the import filters into the browser so the user immediately
      // sees the matching subset of the (now-larger) catalog.
      browserState.filters.sunlight  = importState.filters.shade_level;
      browserState.filters.watering  = importState.filters.water_plan;
      browserState.filters.usda_zone = importState.filters.usda_zone || '';
      browserState.filters.edible    = !!importState.filters.edible;
      browserState.filtersOpen = true;
      showView('browser');
    },
  };
}

function _importFillBody() {
  var f = importState.filters;
  var body = {};
  if (f.shade_level)     body.shade_level     = f.shade_level;
  if (f.water_plan)      body.water_plan      = f.water_plan;
  if (f.usda_zone)       body.usda_zone       = f.usda_zone;
  if (f.planting_season) body.planting_season = f.planting_season;
  if (f.edible)          body.edible          = true;
  return body;
}

async function _runImportFillSequence() {
  importState.busy = true;
  importState.fillSteps = IMPORT_FILL_STEP_BLUEPRINTS.map(function(s) {
    return { key: s.key, label: s.label, status: 'pending', detail: '' };
  });
  importState.fillFinished = false;
  var renderOpts = _importRenderOpts();
  renderFillProgress(importState, renderOpts);

  var body = _importFillBody();

  await runFillStep(importState, 'perenual', '/catalog/fill/perenual', body, function(data) {
    var lines = [];
    if (data.fetched != null) lines.push('Fetched ' + data.fetched + ' plants from Perenual.');
    if (data.new_plants)      lines.push(data.new_plants + ' new plant(s) added to the catalog.');
    return lines.join(' ') || 'No matching plants returned.';
  }, renderOpts);
  await runFillStep(importState, 'compatible', '/catalog/fill/compatible', body, function(data) {
    return data.compatible_plants + ' plant(s) match these conditions in the catalog now.';
  }, renderOpts);

  importState.fillFinished = true;
  renderFillProgress(importState, renderOpts);
}
