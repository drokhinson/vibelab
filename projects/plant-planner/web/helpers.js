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
// The detail panel renders two groups of [label, value] pairs:
//   1. Core conditions: sunlight, watering, cycle, hardiness, edible.
//   2. Extras (Trefle-sourced): height, days_to_harvest, pH, toxicity,
//      growth_rate, sowing. These ride along with the cache row but only
//      get populated after a successful Trefle detail-call enrichment, so
//      they're often missing on Perenual-only or Flora-only rows.
// `_trefleExtrasMissing(plant)` flags whether to surface the "Import from
// Trefle" CTA. `trefleEnrich(cacheId)` runs the per-plant lookup against
// the backend; the panel re-renders with the returned cache row.

function _coreInfoBullets(plant) {
  if (!plant) return [];
  var bullets = [];
  if (plant.sunlight) bullets.push(['Sunlight', plant.sunlight.replace(/_/g, ' ')]);
  if (plant.watering) bullets.push(['Watering', plant.watering]);
  if (plant.cycle)    bullets.push(['Cycle', plant.cycle]);
  if (plant.hardiness_min != null && plant.hardiness_max != null) {
    bullets.push(['Hardiness', 'Zone ' + plant.hardiness_min + '–' + plant.hardiness_max]);
  }
  if (plant.edible === true)  bullets.push(['Edible', 'yes']);
  if (plant.edible === false) bullets.push(['Edible', 'no']);
  return bullets;
}

function _trefleExtraBullets(plant) {
  if (!plant) return [];
  var bullets = [];
  if (plant.height_min_cm != null || plant.height_max_cm != null) {
    bullets.push(['Height', (plant.height_min_cm || '?') + '–' + (plant.height_max_cm || '?') + ' cm']);
  }
  if (plant.days_to_harvest != null) bullets.push(['Days to harvest', String(plant.days_to_harvest)]);
  if (plant.ph_min != null && plant.ph_max != null) bullets.push(['Soil pH', plant.ph_min + '–' + plant.ph_max]);
  if (plant.toxicity)    bullets.push(['Toxicity', plant.toxicity]);
  if (plant.growth_rate) bullets.push(['Growth rate', plant.growth_rate]);
  if (plant.sowing)      bullets.push(['Sowing', plant.sowing]);
  return bullets;
}

function _trefleExtrasMissing(plant) {
  if (!plant) return true;
  return plant.height_max_cm == null
      && plant.height_min_cm == null
      && plant.ph_min == null
      && plant.ph_max == null
      && plant.days_to_harvest == null
      && !plant.toxicity
      && !plant.growth_rate
      && !plant.sowing;
}

// Render a <dl class="shopping-detail-bullets"> from a list of [label, value]
// pairs. Returns '' for an empty list so callers can append unconditionally.
function _renderDetailBullets(bullets) {
  if (!bullets || !bullets.length) return '';
  var html = '<dl class="shopping-detail-bullets">';
  for (var i = 0; i < bullets.length; i++) {
    html += '<dt>' + escapeHtml(bullets[i][0]) + '</dt><dd>' + escapeHtml(bullets[i][1]) + '</dd>';
  }
  html += '</dl>';
  return html;
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
