// gardens.js — My Gardens list view + 5-step New-Garden wizard.
//
// Wizard flow:
//   1. Type + size     — pick a planter type, then resize with a live mini 3D preview
//   2. Light           — full_sun | partial | shade
//   3. Location → zone — geolocation + ZIP fallback (skipped for indoor/greenhouse)
//   4. Water plan      — regular | occasional | rain_only
//   5. Review          — editable Name (auto-prefilled "<type> #<n>"), summary, Confirm
//
// Nothing is written to the DB until step 5's Confirm. wizardDraft holds the
// in-flight values; cancel discards them.

// ── My Gardens list ─────────────────────────────────────────────────────────

async function renderGardens() {
  app.innerHTML = '<div class="flex flex-col items-center justify-center py-12 text-base-content/50 gap-3"><span class="loading loading-spinner loading-md text-primary"></span>Loading gardens...</div>';
  try {
    gardens = await apiFetch("/gardens");
  } catch (err) {
    app.innerHTML = '<div class="error-banner">' + err.message + '</div>';
    return;
  }

  var html = '<div class="flex justify-between items-center mb-5">';
  html += '<h3 class="text-xl font-display font-semibold">My Gardens</h3>';
  html += '<button id="new-garden-btn" class="btn btn-primary btn-sm gap-1"><i data-lucide="plus-circle" style="width:1em;height:1em"></i> New Garden</button>';
  html += '</div>';

  if (gardens.length === 0) {
    html += '<div class="empty-state-illustration">' +
      '<svg width="200" height="160" viewBox="0 0 200 160" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<ellipse cx="100" cy="148" rx="70" ry="8" fill="currentColor" opacity="0.06"/>' +
        '<rect x="40" y="100" width="120" height="40" rx="6" fill="#7BAE7F" opacity="0.15"/>' +
        '<rect x="45" y="95" width="110" height="10" rx="3" fill="#7BAE7F" opacity="0.25"/>' +
        '<path d="M70 95 Q70 70 60 55 Q68 60 70 50 Q72 60 80 55 Q70 70 70 95Z" fill="#7BAE7F" opacity="0.5"/>' +
        '<path d="M100 95 Q98 60 88 40 Q98 50 100 35 Q102 50 112 40 Q102 60 100 95Z" fill="#7BAE7F" opacity="0.65"/>' +
        '<path d="M130 95 Q130 72 122 60 Q128 64 130 55 Q132 64 138 60 Q130 72 130 95Z" fill="#7BAE7F" opacity="0.45"/>' +
        '<circle cx="88" cy="42" r="5" fill="#E8856C" opacity="0.8"/>' +
        '<circle cx="112" cy="38" r="4" fill="#E8856C" opacity="0.7"/>' +
        '<circle cx="60" cy="56" r="3.5" fill="#B8A9D4" opacity="0.6"/>' +
      '</svg>' +
      '<p class="text-base-content/50">No gardens yet. Create your first garden!</p>' +
    '</div>';
  } else {
    html += '<div class="gardens-grid">';
    for (var i = 0; i < gardens.length; i++) {
      var g = gardens[i];
      var typeLabel = plantertypeLabel(g.garden_type);
      var typeIcon  = plantertypeIcon(g.garden_type);
      var shadeIcon = sunlightIcon(g.shade_level || "full_sun");
      var shadeLabel = sunlightLabel(g.shade_level || "full_sun");
      var sizeLabel = sizeLabelFor(g);
      var waterLabel = waterPlanLabel(g.water_plan);

      html += '\
        <div class="garden-card" data-id="' + g.id + '" style="--i:' + i + '">\
          <div>\
            <div class="garden-card-title">' + escapeHtml(g.name) + '</div>\
            <div class="garden-card-meta">\
              <span class="garden-chip">' + typeIcon + ' ' + typeLabel + '</span>\
              <span class="garden-chip">' + sizeLabel + '</span>\
            </div>\
            <div class="garden-card-meta mt-1">\
              <span class="garden-chip">' + shadeIcon + ' ' + shadeLabel + '</span>\
              <span class="garden-chip">💧 ' + waterLabel + '</span>' +
              (g.usda_zone ? '<span class="garden-chip">📍 Zone ' + escapeHtml(g.usda_zone) + '</span>' : '') +
            '</div>\
          </div>\
          <div class="garden-card-actions">\
            <button class="btn btn-sm btn-primary gap-1 open-garden-btn" data-id="' + g.id + '"><i data-lucide="layout-grid" style="width:0.85em;height:0.85em"></i> Open</button>\
            <button class="btn btn-sm btn-ghost text-error gap-1 delete-garden-btn" data-id="' + g.id + '"><i data-lucide="trash-2" style="width:0.85em;height:0.85em"></i> Delete</button>\
          </div>\
        </div>';
    }
    html += '</div>';
  }
  app.innerHTML = html;

  document.getElementById("new-garden-btn").onclick = startGardenWizard;
  document.querySelectorAll(".open-garden-btn").forEach(function(btn) {
    btn.onclick = function() { openGarden(btn.dataset.id); };
  });
  document.querySelectorAll(".delete-garden-btn").forEach(function(btn) {
    btn.onclick = function() { deleteGarden(btn.dataset.id); };
  });
  _initIcons();
}

// ── Display helpers ─────────────────────────────────────────────────────────

function plantertypeLabel(t) {
  switch (t) {
    case 'indoor_pot':          return 'Indoor pot';
    case 'indoor_planter_box':  return 'Indoor planter box';
    case 'greenhouse':          return 'Greenhouse';
    case 'outdoor_pot':         return 'Outdoor pot';
    case 'outdoor_planter_box': return 'Outdoor planter box';
    case 'raised_bed':          return 'Raised bed';
    case 'garden_bed':
    default:                    return 'Garden bed';
  }
}

function plantertypeIcon(t) {
  switch (t) {
    case 'indoor_pot':          return '🪴';
    case 'indoor_planter_box':  return '🪟';
    case 'greenhouse':          return '🏠';
    case 'outdoor_pot':         return '🌿';
    case 'outdoor_planter_box': return '🟫';
    case 'raised_bed':          return '🟫';
    case 'garden_bed':
    default:                    return '🌱';
  }
}

function waterPlanLabel(w) {
  switch (w) {
    case 'frequent': return 'Frequent';
    case 'minimum':  return 'Minimum';
    case 'none':     return 'Rain only';
    case 'average':
    default:         return 'Average';
  }
}

function sizeLabelFor(g) {
  var t = g.garden_type;
  var inUnit  = gardenTypeUsesInches(t);
  var unitSym = inUnit ? '"' : ' ft';
  // Pots: radius × height.
  if (t === 'indoor_pot' || t === 'outdoor_pot') {
    return 'r ' + g.grid_width + unitSym + ' × h ' + g.grid_height + unitSym;
  }
  // Box-shape types: width × length × height.
  if (typeof _gardenTypeHasHeightField === 'function' && _gardenTypeHasHeightField(t)) {
    var dh = (g.dim_height != null) ? g.dim_height : '?';
    return g.grid_width + unitSym + ' × ' + g.grid_height + unitSym + ' × ' + dh + unitSym;
  }
  // Garden bed (flat).
  return g.grid_width + '×' + g.grid_height + ' ft';
}

// ── Wizard entry / dispatch ─────────────────────────────────────────────────

// Default name: "<Planter type> #<n>" where n is one more than the count of
// existing gardens of the same type. Falls back to "<Planter type> #1" if
// `gardens` hasn't loaded yet (cold start).
function _autoGardenName(gardenType) {
  var label = plantertypeLabel(gardenType);
  var n = 1;
  if (Array.isArray(gardens)) {
    for (var i = 0; i < gardens.length; i++) {
      if (gardens[i] && gardens[i].garden_type === gardenType) n += 1;
    }
  }
  return label + ' #' + n;
}

function startGardenWizard() {
  // Defaults — pulled from the user's most recent garden where reasonable.
  var prev = (gardens && gardens[0]) || null;
  var initialType = prev ? prev.garden_type : 'garden_bed';
  wizardDraft = {
    // Name is auto-generated until the user types something custom on the
    // planter step.
    name: _autoGardenName(initialType),
    name_was_auto: true,
    garden_type: initialType,
    grid_width:  _defaultGridFor(initialType).w,
    grid_height: _defaultGridFor(initialType).h,
    dim_height:  _defaultGridFor(initialType).dh,
    shade_level: prev ? (prev.shade_level || 'full_sun') : 'full_sun',
    water_plan:  prev ? (prev.water_plan  || 'average')  : 'average',
    planting_season: prev ? (prev.planting_season || 'spring') : 'spring',
    usda_zone:      prev ? (prev.usda_zone || null)      : null,
    location_label: prev ? (prev.location_label || null) : null,
    // Sync-or-cache choice on step 3. Default to sync to match prior behavior.
    run_fill_sequence: true,
  };
  wizardStep = 1;
  wizardEditReturnTo = null;
  showView('wizard');
}

// 4-step flow:
//   1. Filters (light + water + zone + season + edible)
//   2. Planter (type + size + name)
//   3. Sync-or-cache choice
//   4. Review
function renderGardenWizard() {
  if (!wizardDraft) { showView('gardens'); return; }
  // Tear down the live preview whenever we're not on the planter step.
  if (wizardStep !== 2) _disposeWizardPreview();
  if      (wizardStep === 1) renderWizardStepFilters();
  else if (wizardStep === 2) renderWizardStepPlanter();
  else if (wizardStep === 3) renderWizardStepSyncChoice();
  else                       renderWizardStepReview();
}

var WIZARD_TOTAL_STEPS = 4;

function _wizardStepsTotal() { return WIZARD_TOTAL_STEPS; }
function _wizardStepLabel() {
  return 'Step ' + wizardStep + ' of ' + WIZARD_TOTAL_STEPS;
}

function _seasonLabel(s) {
  return ({ spring: 'Spring', summer: 'Summer', fall: 'Fall', winter: 'Winter' })[s] || 'Spring';
}
function _seasonIcon(s) {
  return ({ spring: '🌷', summer: '☀️', fall: '🍂', winter: '❄️' })[s] || '🌷';
}

function _wizardHeader(title, subtitle) {
  return ''
    + '<div class="wizard-header">'
    +   '<button type="button" class="btn btn-ghost btn-sm" id="wizard-cancel">'
    +     '<i data-lucide="x" style="width:1em;height:1em"></i> Cancel'
    +   '</button>'
    +   '<span class="wizard-step-label">' + escapeHtml(_wizardStepLabel()) + '</span>'
    + '</div>'
    + '<div class="wizard-progress">' + _wizardProgressDots() + '</div>'
    + '<div class="wizard-title">'
    +   '<h3>' + escapeHtml(title) + '</h3>'
    +   (subtitle ? '<p class="wizard-subtitle">' + escapeHtml(subtitle) + '</p>' : '')
    + '</div>';
}

function _wizardProgressDots() {
  var html = '';
  for (var i = 1; i <= WIZARD_TOTAL_STEPS; i++) {
    var cls = 'wizard-dot' + (i < wizardStep ? ' done' : (i === wizardStep ? ' active' : ''));
    html += '<span class="' + cls + '"></span>';
  }
  return html;
}

function _wizardFooter(opts) {
  // opts: { canBack, nextLabel, nextDisabled, nextId }
  var canBack = opts.canBack !== false && wizardStep > 1;
  var nextLabel = opts.nextLabel || (wizardEditReturnTo ? 'Save & review' : 'Next');
  var nextId = opts.nextId || 'wizard-next';
  var disabled = opts.nextDisabled ? ' disabled' : '';
  return ''
    + '<div class="wizard-footer">'
    + (canBack ? '<button type="button" class="btn btn-ghost btn-sm gap-1" id="wizard-back"><i data-lucide="arrow-left" style="width:1em;height:1em"></i> Back</button>' : '<span></span>')
    +   '<button type="button" class="btn btn-primary btn-sm gap-1" id="' + nextId + '"' + disabled + '>'
    +     escapeHtml(nextLabel) + ' <i data-lucide="arrow-right" style="width:1em;height:1em"></i>'
    +   '</button>'
    + '</div>';
}

function _wizardBindCommon() {
  var cancelBtn = document.getElementById('wizard-cancel');
  if (cancelBtn) cancelBtn.onclick = function() {
    if (confirm('Discard this new garden?')) {
      _disposeWizardPreview();
      wizardDraft = null;
      wizardStep = 1;
      wizardEditReturnTo = null;
      showView('gardens');
    }
  };
  var backBtn = document.getElementById('wizard-back');
  if (backBtn) backBtn.onclick = function() {
    if (wizardEditReturnTo) {
      // Editing from review — Back returns to review without saving the change.
      wizardEditReturnTo = null;
      wizardStep = WIZARD_TOTAL_STEPS;
    } else {
      wizardStep = Math.max(1, wizardStep - 1);
    }
    renderGardenWizard();
    _initIcons();
  };
}

function _wizardAdvance() {
  if (wizardEditReturnTo) {
    // Returning to review after an edit.
    wizardEditReturnTo = null;
    wizardStep = WIZARD_TOTAL_STEPS;
  } else {
    wizardStep = Math.min(WIZARD_TOTAL_STEPS, wizardStep + 1);
  }
  renderGardenWizard();
  _initIcons();
}

// ── Step 1: Planter type + size + live preview ──────────────────────────────

// Two-column type picker. Indoor types are climate-controlled (skip the
// Location step); outdoor types use the user's local hardiness zone — even
// outdoor pots (a 12" pot on a balcony in zone 4 still freezes).
var PLANTER_TYPE_COLUMNS = {
  indoor: [
    { id: 'indoor_pot',         label: 'Pot',          icon: '🪴', desc: 'Container indoors. Inches.' },
    { id: 'indoor_planter_box', label: 'Planter box',  icon: '🪟', desc: 'Rectangular indoor planter (window box, sill). Inches.' },
    { id: 'greenhouse',         label: 'Greenhouse',   icon: '🏠', desc: 'Climate-controlled structure. Feet.' }
  ],
  outdoor: [
    { id: 'outdoor_pot',         label: 'Pot',          icon: '🌿', desc: 'Container outside (deck, balcony, patio). Inches.' },
    { id: 'outdoor_planter_box', label: 'Planter box',  icon: '🟫', desc: 'Rectangular outdoor planter / trough. Inches.' },
    { id: 'garden_bed',          label: 'Garden bed',   icon: '🌱', desc: 'In-ground bed. Feet.' },
    { id: 'raised_bed',          label: 'Raised bed',   icon: '🟫', desc: 'Elevated bed with controlled soil. Feet.' }
  ]
};

// Default geometry when the user picks each type. Per the migration-014 model:
//   • Pots: w = RADIUS, h = HEIGHT (in). dh unused.
//   • Planter boxes / raised bed / greenhouse: w = WIDTH, h = LENGTH, dh = HEIGHT.
//   • Garden bed: w × h footprint only; dh unused.
var _DEFAULT_GRID_BY_TYPE = {
  indoor_pot:          { w: 6,  h: 8,  dh: null },   // 6-in radius (12-in dia), 8-in tall
  outdoor_pot:         { w: 8,  h: 10, dh: null },   // 8-in radius (16-in dia), 10-in tall
  indoor_planter_box:  { w: 24, h: 12, dh: 8  },     // 24×12-in box, 8 in tall
  outdoor_planter_box: { w: 36, h: 12, dh: 10 },     // 36×12-in trough, 10 in tall
  raised_bed:          { w: 4,  h: 4,  dh: 1  },     // 4×4 ft, 1 ft wall
  greenhouse:          { w: 8,  h: 8,  dh: 8  },     // 8×8 ft, 8 ft tall
  garden_bed:          { w: 4,  h: 4,  dh: null }    // 4×4 ft flat
};

function _defaultGridFor(t) {
  return _DEFAULT_GRID_BY_TYPE[t] || { w: 4, h: 4, dh: null };
}

// Which types carry a vertical-height field separate from grid_height.
function _gardenTypeHasHeightField(t) {
  return t === 'indoor_planter_box' || t === 'outdoor_planter_box'
      || t === 'raised_bed' || t === 'greenhouse';
}

// Flat list helper for any code that still needs to iterate every option.
function _allPlanterTypes() {
  return PLANTER_TYPE_COLUMNS.indoor.concat(PLANTER_TYPE_COLUMNS.outdoor);
}

// Mini-preview state: a Three.js handle reused on each rebuild + a debounce id.
var _wizardPreviewHandle = null;
var _wizardPreviewRebuildId = null;

function _disposeWizardPreview() {
  if (_wizardPreviewHandle && typeof disposePreview3D === 'function') {
    try { disposePreview3D(_wizardPreviewHandle); } catch (_) {}
  }
  _wizardPreviewHandle = null;
  if (_wizardPreviewRebuildId) {
    clearTimeout(_wizardPreviewRebuildId);
    _wizardPreviewRebuildId = null;
  }
}

function _rebuildWizardPreview() {
  // Tear down → re-init. Debounced so dragging a number input doesn't thrash.
  if (_wizardPreviewRebuildId) clearTimeout(_wizardPreviewRebuildId);
  _wizardPreviewRebuildId = setTimeout(function() {
    _wizardPreviewRebuildId = null;
    var container = document.getElementById('wz-preview');
    if (!container) return;
    if (_wizardPreviewHandle && typeof disposePreview3D === 'function') {
      try { disposePreview3D(_wizardPreviewHandle); } catch (_) {}
      _wizardPreviewHandle = null;
    }
    var fakeGarden = {
      grid_width:  wizardDraft.grid_width  || 4,
      grid_height: wizardDraft.grid_height || 4,
      dim_height:  wizardDraft.dim_height,
      garden_type: wizardDraft.garden_type
    };
    if (typeof initPreview3D === 'function') {
      _wizardPreviewHandle = initPreview3D('wz-preview', fakeGarden);
    }
  }, 120);
}

function _renderWizardTypeColumn(title, options) {
  var html = '<div class="wizard-options-col">';
  html += '<div class="wizard-options-col-header">' + escapeHtml(title) + '</div>';
  for (var i = 0; i < options.length; i++) {
    var o = options[i];
    var active = wizardDraft.garden_type === o.id ? ' active' : '';
    html += ''
      + '<button type="button" class="wizard-option' + active + '" data-type="' + o.id + '">'
      +   '<span class="wizard-option-icon">' + o.icon + '</span>'
      +   '<span class="wizard-option-body">'
      +     '<span class="wizard-option-label">' + escapeHtml(o.label) + '</span>'
      +     '<span class="wizard-option-desc">' + escapeHtml(o.desc) + '</span>'
      +   '</span>'
      + '</button>';
  }
  html += '</div>';
  return html;
}

function renderWizardStepPlanter() {
  var html = '<div class="wizard-page">';
  html += _wizardHeader('Pick a planter — and name it', 'Choose a type, size it, and give it a name. The preview updates live.');

  // Two columns — Indoor (climate-controlled) vs Outdoor (uses your zone).
  html += '<div class="wizard-options-2col">';
  html += _renderWizardTypeColumn('Indoor',  PLANTER_TYPE_COLUMNS.indoor);
  html += _renderWizardTypeColumn('Outdoor', PLANTER_TYPE_COLUMNS.outdoor);
  html += '</div>';

  // Size + preview block (revealed once a type is picked). Stacked: controls
  // on top, full-width preview canvas below.
  if (wizardDraft.garden_type) {
    var unit = gardenTypeUnitLabel(wizardDraft.garden_type);
    var dimsLabel = gardenTypeUsesInches(wizardDraft.garden_type)
      ? 'Pot / box dimensions (' + unit + ')'
      : 'Bed dimensions (' + unit + ')';
    html += '<div class="wizard-size-block">';
    html +=   '<div class="wizard-size-controls">';
    html +=     '<div class="wizard-field-label">' + escapeHtml(dimsLabel) + '</div>';
    html +=     _renderSizeControls();
    html +=   '</div>';
    html +=   '<div class="wizard-preview-wrap">';
    html +=     '<div class="wizard-preview-label">Live preview</div>';
    html +=     '<div id="wz-preview" class="wizard-preview-canvas"></div>';
    html +=     '<div id="wz-preview-cap" class="wizard-preview-caption">' + escapeHtml(sizeLabelFor(wizardDraft)) + '</div>';
    html +=   '</div>';
    html += '</div>';

    html += '<div class="wizard-review-name">'
         +   '<label class="wizard-field">'
         +     '<span class="wizard-field-label">Garden name</span>'
         +     '<input id="wz-name" type="text" class="input input-bordered input-sm" '
         +       'value="' + escapeHtml(wizardDraft.name) + '" placeholder="' + escapeHtml(_autoGardenName(wizardDraft.garden_type)) + '" />'
         +   '</label>'
         + '</div>';
  }

  html += _wizardFooter({ nextDisabled: !wizardDraft.garden_type });
  html += '</div>';
  app.innerHTML = html;

  document.querySelectorAll('.wizard-option').forEach(function(btn) {
    btn.onclick = function() {
      var newType = btn.dataset.type;
      var wasType = wizardDraft.garden_type;
      wizardDraft.garden_type = newType;
      // Each type has its own geometry model (radius vs width×length, with or
      // without dim_height) so always reset to that type's defaults on switch.
      if (wasType !== newType) {
        var d = _defaultGridFor(newType);
        wizardDraft.grid_width  = d.w;
        wizardDraft.grid_height = d.h;
        wizardDraft.dim_height  = d.dh;
        if (wizardDraft.name_was_auto) {
          wizardDraft.name = _autoGardenName(newType);
        }
        // A water_plan of 'none' is invalid for sheltered types — drop it on
        // switch so we don't carry an invalid value into review.
        if (gardenTypeIsClimateControlled(newType) && wizardDraft.water_plan === 'none') {
          wizardDraft.water_plan = 'average';
        }
      }
      renderWizardStepPlanter();
      _initIcons();
    };
  });

  var nameEl = document.getElementById('wz-name');
  if (nameEl) {
    nameEl.oninput = function(e) {
      var v = e.target.value;
      wizardDraft.name = v;
      wizardDraft.name_was_auto = (v.trim().length === 0);
    };
  }

  _wizardBindCommon();
  document.getElementById('wizard-next').onclick = function() { _wizardAdvance(); };
  _bindSizeControls();

  if (wizardDraft.garden_type) _rebuildWizardPreview();

  _initIcons();
}

// Markup for the size controls. Layout depends on the planter type's
// geometry (migration 014):
//   • Pots         — Radius (in) + Height (in)
//   • Planter box  — Width × Length × Height (in)
//   • Raised bed   — Width × Length × Height (ft)
//   • Greenhouse   — Width × Length × Height (ft)
//   • Garden bed   — Width × Length (ft) preset chips
function _renderSizeControls() {
  var t = wizardDraft.garden_type;
  var unit = gardenTypeUnitLabel(t);

  // Pots: 2 inputs — radius + height.
  if (t === 'indoor_pot' || t === 'outdoor_pot') {
    return '<div class="wizard-field-row">'
         +   '<label class="wizard-field flex-1">'
         +     '<span class="wizard-field-label">Radius (' + unit + ')</span>'
         +     '<input id="wz-w" type="number" min="2" max="48" class="input input-bordered input-sm" value="' + wizardDraft.grid_width + '" />'
         +   '</label>'
         +   '<label class="wizard-field flex-1">'
         +     '<span class="wizard-field-label">Height (' + unit + ')</span>'
         +     '<input id="wz-h" type="number" min="2" max="60" class="input input-bordered input-sm" value="' + wizardDraft.grid_height + '" />'
         +   '</label>'
         + '</div>';
  }

  // 3D-box types (planter boxes, raised bed, greenhouse): width × length × height.
  if (_gardenTypeHasHeightField(t)) {
    var inchType = gardenTypeUsesInches(t);
    var maxWL = inchType ? 96 : 30;
    var maxH  = inchType ? 60 : 20;
    var dh = wizardDraft.dim_height != null ? wizardDraft.dim_height : (_defaultGridFor(t).dh || 1);
    return '<div class="wizard-field-row">'
         +   '<label class="wizard-field flex-1">'
         +     '<span class="wizard-field-label">Width (' + unit + ')</span>'
         +     '<input id="wz-w" type="number" min="1" max="' + maxWL + '" class="input input-bordered input-sm" value="' + wizardDraft.grid_width + '" />'
         +   '</label>'
         +   '<label class="wizard-field flex-1">'
         +     '<span class="wizard-field-label">Length (' + unit + ')</span>'
         +     '<input id="wz-h" type="number" min="1" max="' + maxWL + '" class="input input-bordered input-sm" value="' + wizardDraft.grid_height + '" />'
         +   '</label>'
         +   '<label class="wizard-field flex-1">'
         +     '<span class="wizard-field-label">Height (' + unit + ')</span>'
         +     '<input id="wz-dh" type="number" min="0.5" max="' + maxH + '" step="' + (inchType ? '1' : '0.5') + '" class="input input-bordered input-sm" value="' + dh + '" />'
         +   '</label>'
         + '</div>';
  }

  // Garden bed (flat) — preset chips + custom width × length in feet.
  var presets = [
    { v: '4x4',    label: '4×4 ft' },
    { v: '4x8',    label: '4×8 ft' },
    { v: '8x8',    label: '8×8 ft' },
    { v: 'custom', label: 'Custom' }
  ];
  var current = wizardDraft.grid_width + 'x' + wizardDraft.grid_height;
  if (current !== '4x4' && current !== '4x8' && current !== '8x8') current = 'custom';
  var html = '<div class="wizard-presets">';
  for (var i = 0; i < presets.length; i++) {
    var active = presets[i].v === current ? ' active' : '';
    html += '<button type="button" class="wizard-preset' + active + '" data-preset="' + presets[i].v + '">' + presets[i].label + '</button>';
  }
  html += '</div>';
  html += '<div id="wz-custom" class="wizard-field-row" style="' + (current === 'custom' ? '' : 'display:none') + '">'
       +   '<label class="wizard-field flex-1">'
       +     '<span class="wizard-field-label">Width (ft)</span>'
       +     '<input id="wz-w" type="number" min="1" max="30" class="input input-bordered input-sm" value="' + wizardDraft.grid_width + '" />'
       +   '</label>'
       +   '<label class="wizard-field flex-1">'
       +     '<span class="wizard-field-label">Length (ft)</span>'
       +     '<input id="wz-h" type="number" min="1" max="30" class="input input-bordered input-sm" value="' + wizardDraft.grid_height + '" />'
       +   '</label>'
       + '</div>';
  return html;
}

function _bindSizeControls() {
  function afterChange() {
    var cap = document.getElementById('wz-preview-cap');
    if (cap) cap.textContent = sizeLabelFor(wizardDraft);
    _rebuildWizardPreview();
  }
  document.querySelectorAll('.wizard-preset').forEach(function(btn) {
    btn.onclick = function() {
      var v = btn.dataset.preset;
      document.querySelectorAll('.wizard-preset').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var customRow = document.getElementById('wz-custom');
      if (v === 'custom') {
        if (customRow) customRow.style.display = '';
      } else {
        if (customRow) customRow.style.display = 'none';
        var p = v.split('x');
        wizardDraft.grid_width  = parseInt(p[0]);
        wizardDraft.grid_height = parseInt(p[1]);
        var w = document.getElementById('wz-w');
        var h = document.getElementById('wz-h');
        if (w) w.value = wizardDraft.grid_width;
        if (h) h.value = wizardDraft.grid_height;
        afterChange();
      }
    };
  });
  var wEl  = document.getElementById('wz-w');
  var hEl  = document.getElementById('wz-h');
  var dhEl = document.getElementById('wz-dh');
  if (wEl) wEl.oninput = function(e) {
    wizardDraft.grid_width  = Math.max(1, parseInt(e.target.value) || 1);
    afterChange();
  };
  if (hEl) hEl.oninput = function(e) {
    wizardDraft.grid_height = Math.max(1, parseInt(e.target.value) || 1);
    afterChange();
  };
  if (dhEl) dhEl.oninput = function(e) {
    var v = parseFloat(e.target.value);
    wizardDraft.dim_height = (Number.isFinite(v) && v > 0) ? v : null;
    afterChange();
  };
}

// ── Step 1: Filters (light + water + zone + season) ────────────────────────

// Aligned with Perenual v2/species-list `sunlight` filter values.
var LIGHT_OPTIONS = [
  { id: 'full_sun',       label: 'Full sun',         icon: '☀️' },
  { id: 'sun-part_shade', label: 'Sun & part shade', icon: '🌤️' },
  { id: 'part_shade',     label: 'Part shade',       icon: '⛅' },
  { id: 'full_shade',     label: 'Full shade',       icon: '☁️' }
];

// Aligned with Perenual v2/species-list `watering` filter values.
var WATER_OPTIONS = [
  { id: 'frequent', label: 'Frequent',  icon: '💧💧💧' },
  { id: 'average',  label: 'Average',   icon: '💧💧' },
  { id: 'minimum',  label: 'Minimum',   icon: '💧' },
  { id: 'none',     label: 'Rain only', icon: '☔' }
];

var PLANTING_SEASON_OPTIONS = [
  { id: 'spring', label: 'Spring', icon: '🌷' },
  { id: 'summer', label: 'Summer', icon: '☀️' },
  { id: 'fall',   label: 'Fall',   icon: '🍂' },
  { id: 'winter', label: 'Winter', icon: '❄️' }
];

// Map the option arrays into the chip-row format helpers.js expects.
function _toChipOptions(arr) {
  return arr.map(function(o) { return { value: o.id, label: o.label, icon: o.icon }; });
}

function renderWizardStepFilters() {
  var d = wizardDraft;
  var html = '<div class="wizard-page">';
  html += _wizardHeader('Plant conditions', 'Tell us about the spot — we\'ll filter the catalog to plants that thrive here.');

  html += '<div class="wizard-filters">';
  html += renderFilterChipRow('Light',  _toChipOptions(LIGHT_OPTIONS),            d.shade_level,     'shade_level');
  html += renderFilterChipRow('Water',  _toChipOptions(WATER_OPTIONS),            d.water_plan,      'water_plan');
  html += renderFilterChipRow('Season', _toChipOptions(PLANTING_SEASON_OPTIONS),  d.planting_season, 'planting_season');

  html += '<div class="filter-group">';
  html +=   '<div class="filter-group-label">Hardiness zone <span class="wizard-field-hint">(optional — skip for indoor / greenhouse)</span></div>';
  html +=   '<div class="filter-row" style="align-items:center; gap:0.5rem;">';
  html +=     '<input type="text" id="wz-filter-zone" class="browser-zone-input" placeholder="e.g. 6b" value="' + escapeHtml(d.usda_zone || '') + '" />';
  html +=     '<button type="button" class="btn btn-ghost btn-xs" id="wz-zone-skip">Skip</button>';
  html +=   '</div>';
  html += '</div>';

  html += '</div>';

  html += _wizardFooter({});
  html += '</div>';
  app.innerHTML = html;

  var root = document.querySelector('.wizard-filters');
  bindFilterChipRow(root, 'shade_level', function(v) {
    wizardDraft.shade_level = v || 'full_sun';
    renderWizardStepFilters();
  });
  bindFilterChipRow(root, 'water_plan', function(v) {
    // Sheltered planters can't pick "Rain only", but we don't yet know the
    // type at this step — accept any selection; submit-time will sanity-check.
    wizardDraft.water_plan = v || 'average';
    renderWizardStepFilters();
  });
  bindFilterChipRow(root, 'planting_season', function(v) {
    wizardDraft.planting_season = v || 'spring';
    renderWizardStepFilters();
  });

  var zoneInput = document.getElementById('wz-filter-zone');
  if (zoneInput) zoneInput.oninput = function(e) {
    var v = e.target.value.trim();
    wizardDraft.usda_zone = v || null;
    wizardDraft.location_label = v ? ('Zone ' + v) : null;
  };
  var zoneSkip = document.getElementById('wz-zone-skip');
  if (zoneSkip) zoneSkip.onclick = function() {
    wizardDraft.usda_zone = null;
    wizardDraft.location_label = null;
    renderWizardStepFilters();
  };

  _wizardBindCommon();
  document.getElementById('wizard-next').onclick = function() { _wizardAdvance(); };
  _initIcons();
}

// Kept for review-row labels even though the dedicated water step is gone.
function _wizardWaterOptions() {
  if (wizardDraft && gardenTypeIsClimateControlled(wizardDraft.garden_type)) {
    return WATER_OPTIONS.filter(function(o) { return o.id !== 'none'; });
  }
  return WATER_OPTIONS;
}

// ── Step 3: Sync-or-cache choice ────────────────────────────────────────────

function renderWizardStepSyncChoice() {
  var d = wizardDraft;
  var sync = d.run_fill_sequence !== false;  // default true

  var html = '<div class="wizard-page">';
  html += _wizardHeader('How should we find plants?', 'Pull fresh species from external APIs, or just search what\'s already in our catalog.');

  html += '<div class="wizard-options">';
  html += ''
    + '<button type="button" class="wizard-option' + (sync ? ' active' : '') + '" data-choice="sync">'
    +   '<span class="wizard-option-icon">🌐</span>'
    +   '<span class="wizard-option-body">'
    +     '<span class="wizard-option-label">Sync from API <span class="wizard-option-pill">recommended</span></span>'
    +     '<span class="wizard-option-desc">Fetch fresh species from Trefle, Perenual, and FloraAPI before browsing. Slower (30–60 s) but most up-to-date.</span>'
    +   '</span>'
    + '</button>';
  html += ''
    + '<button type="button" class="wizard-option' + (!sync ? ' active' : '') + '" data-choice="cache">'
    +   '<span class="wizard-option-icon">⚡</span>'
    +   '<span class="wizard-option-body">'
    +     '<span class="wizard-option-label">Use existing catalog</span>'
    +     '<span class="wizard-option-desc">Faster — searches what\'s already cached. Good if you\'ve recently imported plants.</span>'
    +   '</span>'
    + '</button>';
  html += '</div>';

  html += _wizardFooter({ nextLabel: wizardEditReturnTo ? 'Save & review' : 'Review' });
  html += '</div>';
  app.innerHTML = html;

  document.querySelectorAll('.wizard-option').forEach(function(btn) {
    btn.onclick = function() {
      wizardDraft.run_fill_sequence = (btn.dataset.choice === 'sync');
      renderWizardStepSyncChoice();
    };
  });

  _wizardBindCommon();
  document.getElementById('wizard-next').onclick = function() { _wizardAdvance(); };
  _initIcons();
}


// ── Step 6: Review & confirm ────────────────────────────────────────────────

function renderWizardStepReview() {
  var d = wizardDraft;

  // Edit-step targets in the new layout:
  //   1 = filters (light, water, zone, season)
  //   2 = planter (type, size, name)
  //   3 = sync choice
  var rows = [
    { step: 2, label: 'Planter type', value: plantertypeIcon(d.garden_type) + ' ' + plantertypeLabel(d.garden_type) },
    { step: 2, label: 'Size',         value: sizeLabelFor(d) },
    { step: 2, label: 'Name',         value: (d.name && d.name.trim()) ? d.name : _autoGardenName(d.garden_type) },
    { step: 1, label: 'Light',        value: sunlightIcon(d.shade_level) + ' ' + sunlightLabel(d.shade_level) },
    { step: 1, label: 'Watering',     value: '💧 ' + waterPlanLabel(d.water_plan) },
  ];
  if (d.usda_zone) {
    rows.push({ step: 1, label: 'Hardiness zone', value: '📍 ' + (d.location_label || ('Zone ' + d.usda_zone)) });
  } else {
    rows.push({ step: 1, label: 'Hardiness zone', value: 'Skipped' });
  }
  rows.push({ step: 1, label: 'Planting season', value: _seasonIcon(d.planting_season) + ' ' + _seasonLabel(d.planting_season) });
  rows.push({
    step: 3,
    label: 'Catalog source',
    value: d.run_fill_sequence === false
      ? '⚡ Use existing catalog'
      : '🌐 Sync from API',
  });

  var html = '<div class="wizard-page">';
  html += _wizardHeader('Review your planter', 'Confirm your choices. Nothing is saved until you do.');

  html += '<div class="wizard-review">';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    html += ''
      + '<div class="wizard-review-row">'
      +   '<div class="wizard-review-label">' + escapeHtml(r.label) + '</div>'
      +   '<div class="wizard-review-value">' + escapeHtml(String(r.value)) + '</div>'
      +   '<button type="button" class="wizard-review-edit" data-edit-step="' + r.step + '">Edit</button>'
      + '</div>';
  }
  html += '</div>';

  html += '<div class="wizard-footer">'
       +   '<button type="button" class="btn btn-ghost btn-sm" id="wizard-back-to-prev"><i data-lucide="arrow-left" style="width:1em;height:1em"></i> Back</button>'
       +   '<button type="button" class="btn btn-primary btn-sm gap-1" id="wizard-confirm">Continue to plant selection <i data-lucide="arrow-right" style="width:1em;height:1em"></i></button>'
       + '</div>';
  html += '</div>';
  app.innerHTML = html;

  // Edit links jump back to the relevant step, then return to review on Next.
  document.querySelectorAll('.wizard-review-edit').forEach(function(btn) {
    btn.onclick = function() {
      wizardEditReturnTo = parseInt(btn.dataset.editStep, 10);
      wizardStep = wizardEditReturnTo;
      renderGardenWizard();
      _initIcons();
    };
  });

  document.getElementById('wizard-cancel').onclick = function() {
    if (confirm('Discard this new garden?')) {
      _disposeWizardPreview();
      wizardDraft = null;
      wizardStep = 1;
      wizardEditReturnTo = null;
      showView('gardens');
    }
  };
  document.getElementById('wizard-back-to-prev').onclick = function() {
    wizardStep = 3;
    renderGardenWizard();
    _initIcons();
  };
  document.getElementById('wizard-confirm').onclick = submitGardenWizard;
  _initIcons();
}

async function submitGardenWizard() {
  var d = wizardDraft;
  if (!d) { showView('gardens'); return; }
  var btn = document.getElementById('wizard-confirm');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading loading-spinner loading-xs"></span> Continuing…';
  }
  try {
    // Empty name → fall back to the auto-generated "<Type> #<n>" placeholder.
    var resolvedName = (d.name && d.name.trim()) ? d.name.trim() : _autoGardenName(d.garden_type);
    var body = {
      name: resolvedName,
      grid_width:  d.grid_width  || 4,
      grid_height: d.grid_height || 4,
      garden_type: d.garden_type,
      shade_level: d.shade_level,
      planting_season: d.planting_season || 'spring',
      water_plan: d.water_plan
    };
    if (d.usda_zone)      body.usda_zone      = d.usda_zone;
    if (d.location_label) body.location_label = d.location_label;
    if (d.dim_height != null) body.dim_height = d.dim_height;
    var created = await apiFetch('/gardens', { method: 'POST', body: body });
    _disposeWizardPreview();
      wizardDraft = null;
    wizardStep = 1;
    wizardEditReturnTo = null;
    if (created && created.id) {
      // Newly-created planters land in the shopping step. The user picked
      // sync vs cache on step 3 — honor that here.
      if (typeof openShoppingForGarden === 'function') {
        openShoppingForGarden(created.id, { runFillSequence: d.run_fill_sequence !== false });
      } else {
        openGarden(created.id);
      }
    } else {
      showView('gardens');
    }
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'Continue to plant selection <i data-lucide="arrow-right" style="width:1em;height:1em"></i>';
      _initIcons();
    }
    alert('Could not create garden: ' + (err.message || err));
  }
}

// ── Open / delete (unchanged) ───────────────────────────────────────────────

async function openGarden(id) {
  app.innerHTML = '<div class="flex flex-col items-center justify-center py-12 text-base-content/50 gap-3"><span class="loading loading-spinner loading-md text-primary"></span>Loading garden...</div>';
  try {
    var data = await apiFetch("/gardens/" + id);
    currentGarden = data;
    placements = [];
    if (data.plants) {
      for (var i = 0; i < data.plants.length; i++) {
        var row = data.plants[i];
        var cachePlant = row.plantplanner_plant_cache || null;
        if (!cachePlant) continue;  // post-Phase-2 placements always reference the cache
        var pid = row.id ||
          ((window.crypto && typeof crypto.randomUUID === 'function')
            ? crypto.randomUUID()
            : ('p_' + i + '_' + Date.now()));
        var radius = (row.radius_feet != null)
          ? row.radius_feet
          : (cachePlant.spread_cm ? cachePlant.spread_cm / 30.48 / 2 : 0.5);
        placements.push({
          id: pid,
          plantCacheId: cachePlant.id,
          plant: cachePlant,
          pos_x: row.pos_x,
          pos_y: row.pos_y,
          radius_feet: radius
        });
      }
    }
    showView("builder");
  } catch (err) {
    app.innerHTML = '<div class="error-banner">' + err.message + '</div>';
  }
}

async function deleteGarden(id) {
  if (!confirm("Delete this garden?")) return;
  try {
    await apiFetch("/gardens/" + id, { method: "DELETE" });
    renderGardens();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

function escapeHtml(s) {
  var div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
