// helpers.js — apiFetch, auth token, navigation, formatting

var API = window.APP_CONFIG?.apiBase ?? "http://localhost:8000";
var PREFIX = "/api/v1/plant_planner";
var app = document.getElementById("app");

async function apiFetch(path, opts = {}) {
  var headers = opts.headers || {};
  var accessToken = session && session.access_token;
  if (accessToken) headers["Authorization"] = "Bearer " + accessToken;
  if (opts.body && typeof opts.body === "object") {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  var res = await fetch(API + PREFIX + path, { ...opts, headers });
  if (!res.ok) {
    var err;
    try { err = (await res.json()).detail; } catch (_) { err = res.statusText; }
    throw new Error(err || "Request failed");
  }
  return res.json();
}

function showView(view) {
  // Dispose any active scene when leaving the builder.
  if (currentView === "builder" && view !== "builder" && scene3DHandle) {
    if (scene3DHandle.isTwoD && typeof dispose2DView === 'function') {
      dispose2DView(scene3DHandle);
    } else if (typeof dispose3DView === 'function') {
      try { dispose3DView(scene3DHandle); } catch (_) {}
    }
    scene3DHandle = null;
  }
  currentView = view;
  render();
}

async function logout() {
  if (supabaseClient) {
    try { await supabaseClient.auth.signOut(); } catch (e) {
      console.error("[plant-planner] signOut error:", e);
    }
    // onAuthStateChange (SIGNED_OUT) handles state reset + view switch.
    return;
  }
  // No Supabase configured — local cleanup fallback.
  session = null;
  currentUser = null;
  currentGarden = null;
  placements = [];
  showView("auth");
}

function updateNav() {
  var navRight = document.getElementById("nav-right");
  var bottomNav = document.getElementById("bottom-nav");
  if (!navRight) return;

  // Settings icon always lives in the header
  navRight.innerHTML =
    '<button class="btn btn-ghost btn-sm btn-circle" id="nav-settings" title="Settings"><i data-lucide="settings" style="width:1.1em;height:1.1em"></i></button>';
  document.getElementById("nav-settings").onclick = showThemeSettings;

  // Three tabs go into the bottom nav when logged in
  if (bottomNav) {
    if (session && currentUser) {
      var browserActive = currentView === 'browser' || currentView === 'import';
      var libraryActive = currentView === 'library';
      var gardensActive = currentView === 'gardens' || currentView === 'wizard'
                       || currentView === 'shopping' || currentView === 'builder';
      bottomNav.innerHTML =
        '<nav class="btm-nav btm-nav-sm" id="btm-nav-bar">' +
          '<button class="' + (browserActive ? 'active' : '') + '" id="nav-browser">' +
            '<i data-lucide="search" style="width:1.25em;height:1.25em"></i>' +
            '<span class="btm-nav-label">Plant Browser</span>' +
          '</button>' +
          '<button class="' + (libraryActive ? 'active' : '') + '" id="nav-library">' +
            '<i data-lucide="sprout" style="width:1.25em;height:1.25em"></i>' +
            '<span class="btm-nav-label">My Plants</span>' +
          '</button>' +
          '<button class="' + (gardensActive ? 'active' : '') + '" id="nav-gardens">' +
            '<i data-lucide="layout-grid" style="width:1.25em;height:1.25em"></i>' +
            '<span class="btm-nav-label">My Gardens</span>' +
          '</button>' +
        '</nav>';
      document.getElementById("nav-browser").onclick = function(e) { e.preventDefault(); showView("browser"); };
      document.getElementById("nav-library").onclick = function(e) { e.preventDefault(); showView("library"); };
      document.getElementById("nav-gardens").onclick = function(e) { e.preventDefault(); showView("gardens"); };
    } else {
      bottomNav.innerHTML = '';
    }
  }
}

function showThemeSettings() {
  var existing = document.getElementById("settings-dialog");
  if (existing) { existing.showModal(); return; }

  var dialog = document.createElement("dialog");
  dialog.id = "settings-dialog";

  var optionsHtml = Object.keys(THEMES).map(function(key) {
    var t = THEMES[key];
    return '<label class="theme-option">' +
      '<input type="radio" name="pp-theme" value="' + key + '"' + (currentTheme === key ? " checked" : "") + ' class="radio radio-sm radio-primary">' +
      '<span class="theme-swatch ' + (t.swatch || "swatch-" + key) + '"></span>' +
      '<span class="text-sm">' + t.label + '</span>' +
      '</label>';
  }).join("");

  // Draw-style options retired alongside the legacy 3D renderer.
  var styleHtml = '';

  var showAccount = !!(session && currentUser);
  var accountHtml = showAccount
    ? '<fieldset class="space-y-2 mt-3 settings-account">' +
        '<legend class="text-sm font-medium mb-2">Account</legend>' +
        '<button type="button" id="settings-logout" class="btn btn-sm btn-outline btn-error w-full gap-1">' +
          '<i data-lucide="log-out" style="width:1em;height:1em"></i> Log out' +
        '</button>' +
      '</fieldset>'
    : '';

  dialog.innerHTML =
    '<div class="dialog-body">' +
      '<div class="dialog-header"><i data-lucide="settings"></i> Settings</div>' +
      '<fieldset class="space-y-2">' +
        '<legend class="text-sm font-medium mb-2">Color Theme</legend>' +
        optionsHtml +
      '</fieldset>' +
      '<fieldset class="space-y-2 mt-3" hidden>' +
        styleHtml +
      '</fieldset>' +
      accountHtml +
      '<div class="mt-4"><button id="settings-close" class="btn btn-sm btn-primary w-full">Close</button></div>' +
    '</div>';

  document.body.appendChild(dialog);
  dialog.showModal();
  _initIcons();

  dialog.querySelectorAll('input[name="pp-theme"]').forEach(function(radio) {
    radio.onchange = function() { applyTheme(this.value); };
  });
  // 3D render-style selector retired with the legacy renderer; intentionally left empty.
  var logoutBtn = document.getElementById("settings-logout");
  if (logoutBtn) logoutBtn.onclick = function() {
    dialog.close();
    dialog.remove();
    logout();
  };
  document.getElementById("settings-close").onclick = function() {
    dialog.close();
    dialog.remove();
  };
}

function yearScale(plant, year) {
  if (!plant) return 1.0;
  if (plant.lifecycle === 'annual') return 1.0;
  if (plant.lifecycle === 'biennial') return year >= 2 ? 1.0 : 0.5;
  // perennial: ramp to 1.0 at years_to_maturity; floor 0.4 at year 1
  var ytm = plant.years_to_maturity || 3;
  if (year >= ytm) return 1.0;
  return Math.max(0.4, year / ytm);
}

function sunlightLabel(s) {
  if (s === "full_sun") return "Full sun";
  if (s === "sun-part_shade") return "Sun & part shade";
  if (s === "part_shade") return "Part shade";
  if (s === "full_shade") return "Full shade";
  return s;
}

function sunlightIcon(s) {
  if (s === "full_sun") return "☀️";
  if (s === "sun-part_shade") return "🌤️";
  if (s === "part_shade") return "⛅";
  if (s === "full_shade") return "☁️";
  return "";
}

function _initIcons() {
  if (window.lucide) requestAnimationFrame(function() { lucide.createIcons(); });
}

// Build a `?a=1&b=2` query string from a plain params object. Drops null /
// undefined / '' so callers can blindly pass partial filter state. Used by
// browser.js, shopping.js, and import.js to query /catalog/search.
function _qs(params) {
  if (!params) return '';
  var keys = Object.keys(params).filter(function(k) {
    var v = params[k];
    return v !== null && v !== undefined && v !== '' && v !== false;
  });
  if (!keys.length) return '';
  return keys.map(function(k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
}

// Render a row of `.chip` buttons for a single-select filter group.
//   label          — uppercase group label shown above the row
//   options        — Array<{ value, label, icon? }>
//   selectedValue  — currently-selected value (null = none)
//   groupAttr      — `data-filter-group` value used by the click binder
//
// Each chip carries `data-filter-value="<value>"`. Wire chip clicks via
// `bindFilterChipRow(container, groupAttr, onPick)` which toggles selection
// (clicking the active chip clears it).
function renderFilterChipRow(label, options, selectedValue, groupAttr) {
  var html = '<div class="filter-group" data-filter-group="' + groupAttr + '">';
  html += '<div class="filter-group-label">' + escapeHtml(label) + '</div>';
  html += '<div class="filter-row">';
  for (var i = 0; i < options.length; i++) {
    var opt = options[i];
    var active = opt.value === selectedValue;
    html += '<button type="button" class="chip' + (active ? ' active' : '') + '"'
         +  ' data-filter-value="' + escapeHtml(String(opt.value)) + '">'
         +  (opt.icon ? opt.icon + ' ' : '')
         +  escapeHtml(opt.label)
         +  '</button>';
  }
  html += '</div></div>';
  return html;
}

// Wire a previously-rendered filter chip row. `onPick` is called with the
// chosen value, or null if the active chip was clicked again to clear.
function bindFilterChipRow(rootEl, groupAttr, onPick) {
  if (!rootEl) return;
  var group = rootEl.querySelector('[data-filter-group="' + groupAttr + '"]');
  if (!group) return;
  group.querySelectorAll('.chip').forEach(function(btn) {
    btn.onclick = function() {
      var v = btn.dataset.filterValue;
      var wasActive = btn.classList.contains('active');
      onPick(wasActive ? null : v);
    };
  });
}

// ── Plant detail bullets (shared by browser.js + library.js + shopping.js) ──
//
// The detail panel renders a fixed schema:
//   1. Description paragraph (Perenual raw_perenual_json.description).
//   2. Core bullets — always-on list (sunlight, watering, cycle, hardiness,
//      indoor, edible, vegetable, type, care_level).
//   3. Extra bullets — always-on list of Trefle/Perenual fields (height,
//      spread, pH, toxicity, watering_period, drought_tolerant, etc.).
//   4. Chip rows — labeled rows for tags + Perenual/Trefle array fields.
//   5. "Data from <source>" footer.
// Missing values render as `_PLANT_DETAIL_PLACEHOLDER` ("—") so the user
// can scan the popup for unknown fields. The bottom-anchored "Import from
// Trefle" CTA appears when `_anyTrefleExtraMissing(plant)` is true; a
// successful POST /catalog/{id}/enrich/trefle re-renders the panel.

// Fixed placeholder for unknown values. Every bullet/chip row renders even
// when the underlying data is missing so the user can scan for "—" rows.
var _PLANT_DETAIL_PLACEHOLDER = '—';

function _plantRawPerenual(plant) {
  return (plant && plant.raw_perenual_json) || {};
}
function _plantRawTrefle(plant) {
  return (plant && plant.raw_trefle_json) || {};
}

function _yesNoOrMissing(v) {
  if (v === true || v === 1 || v === '1') return 'yes';
  if (v === false || v === 0 || v === '0') return 'no';
  return null;  // unknown → caller fills placeholder
}

function _firstNonEmpty(/* values */) {
  for (var i = 0; i < arguments.length; i++) {
    var v = arguments[i];
    if (v === 0 || v === false) return v;
    if (v != null && v !== '') return v;
  }
  return null;
}

function _wateringBenchmarkLabel(bench) {
  if (!bench || typeof bench !== 'object') return null;
  var v = bench.value, u = bench.unit || '';
  if (v == null || v === '') return null;
  return String(v) + (u ? ' ' + u : '');
}

function _hardinessLocationLabel(loc) {
  if (!loc) return null;
  if (typeof loc === 'string') return loc;
  return loc.full_name || loc.name || null;
}

function _plantTypeLabel(plant) {
  return _firstNonEmpty(_plantRawPerenual(plant).type, _plantRawTrefle(plant).type);
}

// Always-on core bullet schema. Returns the same set of [label, value-or-null]
// pairs every time so the detail panel structure is stable. `null` values are
// rendered as the placeholder by `_renderDetailBullets`.
function _plantCoreBullets(plant) {
  plant = plant || {};
  var pe = _plantRawPerenual(plant);
  var hardiness = (plant.hardiness_min != null && plant.hardiness_max != null)
    ? 'Zone ' + plant.hardiness_min + '–' + plant.hardiness_max : null;
  return [
    ['Sunlight',    plant.sunlight ? plant.sunlight.replace(/_/g, ' ') : null],
    ['Watering',    plant.watering || null],
    ['Cycle',       plant.cycle || null],
    ['Hardiness',   hardiness],
    ['Indoor',      _yesNoOrMissing(plant.indoor)],
    ['Edible',      _yesNoOrMissing(plant.edible)],
    ['Vegetable',   _yesNoOrMissing(plant.vegetable)],
    ['Type',        _plantTypeLabel(plant)],
    ['Care level',  pe.care_level || null]
  ];
}

// Always-on extra-info bullet schema. Combines Trefle-derived columns with
// Perenual raw-JSON fallbacks so the user sees a stable, comprehensive list.
function _plantExtraBullets(plant) {
  plant = plant || {};
  var pe = _plantRawPerenual(plant);
  var height = (plant.height_min_cm != null || plant.height_max_cm != null)
    ? (plant.height_min_cm || '?') + '–' + (plant.height_max_cm || '?') + ' cm'
    : null;
  var ph = (plant.ph_min != null && plant.ph_max != null)
    ? plant.ph_min + '–' + plant.ph_max : null;
  return [
    ['Height',             height],
    ['Spread',             plant.spread_cm != null ? plant.spread_cm + ' cm' : null],
    ['Days to harvest',    plant.days_to_harvest != null ? String(plant.days_to_harvest) : null],
    ['Soil pH',            ph],
    ['Toxicity',           plant.toxicity || null],
    ['Growth rate',        plant.growth_rate || null],
    ['Sowing',             plant.sowing || null],
    ['Nitrogen-fixing',    _yesNoOrMissing(plant.nitrogen_fixation)],
    ['Watering frequency', pe.watering_period || null],
    ['Watering benchmark', _wateringBenchmarkLabel(pe.watering_general_benchmark)],
    ['Hardiness location', _hardinessLocationLabel(pe.hardiness_location)],
    ['Drought tolerant',   _yesNoOrMissing(pe.drought_tolerant)],
    ['Salt tolerant',      _yesNoOrMissing(pe.salt_tolerant)],
    ['Invasive',           _yesNoOrMissing(pe.invasive)],
    ['Flowers',            _yesNoOrMissing(pe.flowers)],
    ['Toxic to humans',    _yesNoOrMissing(pe.poisonous_to_humans)],
    ['Toxic to pets',      _yesNoOrMissing(pe.poisonous_to_pets)],
    ['Pruning months',     (Array.isArray(pe.pruning_month) && pe.pruning_month.length) ? String(pe.pruning_month.length) : null]
  ];
}

// True when any Trefle-derived extra bullet is unknown — drives the bottom
// "Import extra info from Trefle" CTA visibility. Perenual-only rows are
// excluded so the CTA still appears for species we could enrich from Trefle.
function _anyTrefleExtraMissing(plant) {
  if (!plant) return true;
  return plant.height_max_cm == null
      || plant.height_min_cm == null
      || plant.spread_cm == null
      || plant.ph_min == null
      || plant.ph_max == null
      || plant.days_to_harvest == null
      || !plant.toxicity
      || !plant.growth_rate
      || !plant.sowing
      || plant.nitrogen_fixation == null;
}

// Description paragraph — Perenual `description` is occasionally HTML; strip
// tags and cap at ~600 chars. Always renders the container so the popup
// structure is stable; falls back to "No description available." when missing.
function _plantDescriptionHtml(plant) {
  var desc = _plantRawPerenual(plant).description;
  if (typeof desc === 'string') desc = desc.replace(/<[^>]+>/g, '').trim();
  if (!desc) {
    return '<p class="plant-detail-description plant-detail-description-empty">No description available.</p>';
  }
  if (desc.length > 600) desc = desc.slice(0, 600).replace(/\s+\S*$/, '') + '…';
  return '<p class="plant-detail-description">' + escapeHtml(desc) + '</p>';
}

var _MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function _monthChipFor(m) {
  if (m == null) return null;
  if (typeof m === 'string') {
    var n = parseInt(m, 10);
    if (!isNaN(n) && n >= 1 && n <= 12) return _MONTH_NAMES[n - 1];
    return m.length > 3 ? m.slice(0, 3) : m;
  }
  if (typeof m === 'number' && m >= 1 && m <= 12) return _MONTH_NAMES[m - 1];
  return String(m);
}

function _normalizeAttractsItem(item) {
  if (item == null) return null;
  if (typeof item === 'string') return item;
  if (typeof item === 'object') return item.name || item.label || item.common_name || null;
  return String(item);
}

function _trefleDistributionList(plant, key) {
  var dist = _plantRawTrefle(plant).distribution;
  if (!dist || typeof dist !== 'object') return [];
  var arr = dist[key];
  return Array.isArray(arr) ? arr : [];
}

// Fixed list of labeled chip rows. Each row always renders its label; when
// the underlying array is empty we render a single muted "—" chip so the
// user can see what's tracked but unknown for this species.
function _plantChipRowsHtml(plant) {
  plant = plant || {};
  var pe = _plantRawPerenual(plant);
  var growingMonths = (Array.isArray(pe.growing_months) ? pe.growing_months : []).map(_monthChipFor).filter(Boolean);
  var floweringSeason = pe.flowering_season;
  if (typeof floweringSeason === 'string') floweringSeason = floweringSeason ? [floweringSeason] : [];
  if (!Array.isArray(floweringSeason)) floweringSeason = [];
  var attracts = (Array.isArray(pe.attracts) ? pe.attracts : []).map(_normalizeAttractsItem).filter(Boolean);

  var rows = [
    ['Tags',             plant.tags || []],
    ['Soil',             pe.soil || []],
    ['Growing months',   growingMonths],
    ['Flowering season', floweringSeason],
    ['Flower color',     pe.flower_color || []],
    ['Leaf color',       pe.leaf_color || []],
    ['Attracts',         attracts],
    ['Propagation',      pe.propagation || []],
    ['Native range',     _trefleDistributionList(plant, 'native')],
    ['Introduced range', _trefleDistributionList(plant, 'introduced')]
  ];

  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var label = rows[i][0];
    var items = (rows[i][1] || []).filter(function(v) { return v != null && v !== ''; });
    html += '<div class="shopping-detail-section-label">' + escapeHtml(label) + '</div>';
    html += '<div class="plant-detail-tags">';
    if (items.length) {
      for (var j = 0; j < items.length; j++) {
        html += '<span class="plant-detail-tag">' + escapeHtml(String(items[j])) + '</span>';
      }
    } else {
      html += '<span class="plant-detail-tag plant-detail-tag-empty">' + escapeHtml(_PLANT_DETAIL_PLACEHOLDER) + '</span>';
    }
    html += '</div>';
  }
  return html;
}

// Small "Data from <source>" footer — surfaces which API the cache row came
// from so users know how to interpret missing fields.
function _plantSourceHtml(plant) {
  if (!plant || !plant.source) return '';
  var labels = { trefle: 'Trefle', perenual: 'Perenual', merged: 'Trefle + Perenual' };
  var label = labels[plant.source] || plant.source;
  return '<div class="plant-detail-source">Data from ' + escapeHtml(label) + '</div>';
}

// Render a <dl class="shopping-detail-bullets"> from a list of [label, value]
// pairs. `null`/empty values render as the canonical placeholder with a
// `dd--missing` modifier so users can scan for unknown fields at a glance.
function _renderDetailBullets(bullets) {
  if (!bullets || !bullets.length) return '';
  var html = '<dl class="shopping-detail-bullets">';
  for (var i = 0; i < bullets.length; i++) {
    var label = bullets[i][0];
    var value = bullets[i][1];
    var missing = (value == null || value === '');
    var displayed = missing ? _PLANT_DETAIL_PLACEHOLDER : String(value);
    html += '<dt>' + escapeHtml(label) + '</dt>';
    html += '<dd' + (missing ? ' class="dd--missing"' : '') + '>' + escapeHtml(displayed) + '</dd>';
  }
  html += '</dl>';
  return html;
}

// Bottom-anchored "Import extra info from Trefle" CTA. Visible only when at
// least one Trefle-derived extra is unknown AND the row has a cache id.
// Returns the markup; the caller wires the click handler on the button id.
function _plantTrefleImportButtonHtml(plant, cacheId, btnId) {
  if (!cacheId || !_anyTrefleExtraMissing(plant)) return '';
  return '<div class="plant-detail-import">'
       +   '<button type="button" class="btn btn-block btn-outline btn-sm gap-1" id="' + btnId + '">'
       +     '<i data-lucide="download-cloud" style="width:0.9em;height:0.9em"></i> '
       +     'Import extra info from Trefle'
       +   '</button>'
       + '</div>';
}

async function trefleEnrich(cacheId) {
  return apiFetch('/catalog/' + encodeURIComponent(cacheId) + '/enrich/trefle', {
    method: 'POST',
  });
}

// ── Catalog-fill orchestration (shared by shopping.js + import.js) ──────────
//
// Each call site owns a state bag with `{ fillSteps: [...], fillFinished }`
// and passes it in. setFillStep/runFillStep mutate the bag and re-render via
// renderFillProgress; the caller controls title/subtitle/continue handling
// through `renderOpts`.
//
// renderOpts shape:
//   { title, subtitle, continueLabel, onContinue, getApp? }

function _fillStepIcon(status) {
  if (status === 'ok')      return '<i data-lucide="check-circle-2" style="color:oklch(var(--su));"></i>';
  if (status === 'error')   return '<i data-lucide="alert-circle" style="color:oklch(var(--er));"></i>';
  if (status === 'running') return '<span class="loading loading-spinner loading-xs text-primary"></span>';
  return '<i data-lucide="circle" style="color:oklch(var(--bc) / 0.35);"></i>';
}

function renderFillProgress(state, opts) {
  var steps = state && state.fillSteps;
  if (!steps) return;
  opts = opts || {};
  var html = '<div class="shopping-fill-overlay">';
  html += '<div class="shopping-fill-card">';
  html += '<h3>' + escapeHtml(opts.title || 'Setting up your plant catalog') + '</h3>';
  if (opts.subtitle) {
    html += '<p class="shopping-fill-subtitle">' + escapeHtml(opts.subtitle) + '</p>';
  }
  html += '<ul class="shopping-fill-list">';
  for (var i = 0; i < steps.length; i++) {
    var s = steps[i];
    html += '<li class="shopping-fill-item shopping-fill-item-' + s.status + '">';
    html +=   '<span class="shopping-fill-icon">' + _fillStepIcon(s.status) + '</span>';
    html +=   '<span class="shopping-fill-body">';
    html +=     '<span class="shopping-fill-label">' + escapeHtml(s.label) + '</span>';
    if (s.detail) {
      var cls = (s.status === 'error') ? 'shopping-fill-detail shopping-fill-detail-error' : 'shopping-fill-detail';
      html += '<span class="' + cls + '">' + escapeHtml(s.detail) + '</span>';
    }
    html +=   '</span>';
    html += '</li>';
  }
  html += '</ul>';
  if (state.fillFinished) {
    var anyError = steps.some(function(s) { return s.status === 'error'; });
    html += '<div class="shopping-fill-footer">';
    if (anyError) html += '<p class="shopping-fill-warn">Some steps had errors — you can still continue.</p>';
    html += '<button type="button" class="btn btn-primary gap-1" id="fill-continue">'
         +   escapeHtml(opts.continueLabel || 'Continue')
         +   ' <i data-lucide="arrow-right" style="width:1em;height:1em"></i>'
         +   '</button>';
    html += '</div>';
  }
  html += '</div></div>';
  app.innerHTML = html;
  _initIcons();

  if (state.fillFinished && opts.onContinue) {
    var btn = document.getElementById('fill-continue');
    if (btn) btn.onclick = opts.onContinue;
  }
}

function setFillStep(state, key, patch, renderOpts) {
  if (!state || !state.fillSteps) return;
  for (var i = 0; i < state.fillSteps.length; i++) {
    if (state.fillSteps[i].key === key) {
      Object.assign(state.fillSteps[i], patch);
      break;
    }
  }
  renderFillProgress(state, renderOpts);
}

async function runFillStep(state, key, path, body, formatDetail, renderOpts) {
  setFillStep(state, key, { status: 'running' }, renderOpts);
  try {
    var data = await apiFetch(path, { method: 'POST', body: body });
    if (data && data.status === 'error') {
      setFillStep(state, key, { status: 'error', detail: data.error || 'Unknown error.' }, renderOpts);
      return data;
    }
    setFillStep(state, key, { status: 'ok', detail: formatDetail ? formatDetail(data || {}) : '' }, renderOpts);
    return data;
  } catch (err) {
    setFillStep(state, key, { status: 'error', detail: (err && err.message) || String(err) }, renderOpts);
    return null;
  }
}

function render() {
  updateNav();
  if (currentView === "auth") renderAuth();
  else if (currentView === "gardens") renderGardens();
  else if (currentView === "wizard") renderGardenWizard();
  else if (currentView === "shopping") {
    // Shopping renders itself imperatively via openShoppingForGarden(); on a
    // direct refresh the gardens list is the safe fallback.
    if (typeof renderGardens === 'function') renderGardens();
  }
  else if (currentView === "library") {
    if (typeof renderLibrary === 'function') renderLibrary();
  }
  else if (currentView === "browser") {
    if (typeof renderBrowser === 'function') renderBrowser();
  }
  else if (currentView === "import") {
    if (typeof renderImport === 'function') renderImport();
  }
  else if (currentView === "builder") renderBuilder();
  _initIcons();
}

// Returns 'ok' | 'overlap' | 'oob'. Single source of truth used by every drag
// path (desktop tile drag, picked-up plant move, mobile touch drag) to keep
// preview state and commit-time validation in lockstep — the bug they fix is
// drops being committed even when the preview disk shows an invalid spot.
// `ignoreId` lets a picked-up placement skip its own row in the overlap check.
function validatePlacement(posX, posY, r, gw, gh, existingPlacements, ignoreId) {
  if ((posX - r) < 0 || (posX + r) > gw || (posY - r) < 0 || (posY + r) > gh) return 'oob';
  if (Array.isArray(existingPlacements)) {
    for (var i = 0; i < existingPlacements.length; i++) {
      var p = existingPlacements[i];
      if (ignoreId && p.id === ignoreId) continue;
      var dx = posX - p.pos_x, dy = posY - p.pos_y;
      if (Math.hypot(dx, dy) < r + p.radius_feet) return 'overlap';
    }
  }
  return 'ok';
}
