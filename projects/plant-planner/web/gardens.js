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
    case 'occasional': return 'Occasional';
    case 'rain_only':  return 'Rain only';
    case 'regular':
    default:           return 'Regular';
  }
}

function sizeLabelFor(g) {
  // Pots and planter-boxes store inches; greenhouse / beds store feet.
  if (gardenTypeUsesInches(g.garden_type)) {
    return g.grid_width + '" × ' + g.grid_height + '"';
  }
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
    // Name is auto-generated until the user types something custom on review.
    name: _autoGardenName(initialType),
    name_was_auto: true,
    garden_type: initialType,
    grid_width:  prev && !gardenTypeUsesInches(prev.garden_type) ? prev.grid_width  : _defaultGridFor(initialType).w,
    grid_height: prev && !gardenTypeUsesInches(prev.garden_type) ? prev.grid_height : _defaultGridFor(initialType).h,
    shade_level: prev ? (prev.shade_level || 'full_sun') : 'full_sun',
    water_plan:  prev ? (prev.water_plan  || 'regular')  : 'regular',
    planting_season: prev ? (prev.planting_season || 'spring') : 'spring',
    usda_zone:      prev ? (prev.usda_zone || null)      : null,
    location_label: prev ? (prev.location_label || null) : null
  };
  wizardStep = 1;
  wizardEditReturnTo = null;
  showView('wizard');
}

function renderGardenWizard() {
  if (!wizardDraft) { showView('gardens'); return; }
  // Tear down any previous mini-preview when leaving the type+size step.
  if (wizardStep !== 1) _disposeWizardPreview();
  if      (wizardStep === 1) renderWizardStepTypeSize();
  else if (wizardStep === 2) renderWizardStepLight();
  else if (wizardStep === 3) renderWizardStepLocation();
  else if (wizardStep === 4) renderWizardStepWater();
  else if (wizardStep === 5) renderWizardStepPlantingSeason();
  else                       renderWizardStepReview();
}

// Indoor and greenhouse planters skip the Location step (climate-controlled).
function _wizardStepsTotal() {
  return _wizardSkipsLocation() ? 5 : 6;
}
function _wizardSkipsLocation() {
  return wizardDraft && gardenTypeIsClimateControlled(wizardDraft.garden_type);
}

function _wizardStepLabel() {
  // Compute "Step N of M" label, accounting for the skipped Location step.
  var total = _wizardStepsTotal();
  var displayed = wizardStep;
  if (_wizardSkipsLocation() && wizardStep > 3) displayed = wizardStep - 1;
  return 'Step ' + displayed + ' of ' + total;
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
  var total = _wizardStepsTotal();
  var displayed = wizardStep;
  if (_wizardSkipsLocation() && wizardStep > 3) displayed = wizardStep - 1;
  var html = '';
  for (var i = 1; i <= total; i++) {
    var cls = 'wizard-dot' + (i < displayed ? ' done' : (i === displayed ? ' active' : ''));
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
      wizardStep = _wizardSkipsLocation() ? 5 : 6;
    } else {
      wizardStep = Math.max(1, wizardStep - 1);
      // Re-skip Location when stepping back into it.
      if (wizardStep === 3 && _wizardSkipsLocation()) wizardStep = 2;
    }
    renderGardenWizard();
    _initIcons();
  };
}

function _wizardAdvance() {
  if (wizardEditReturnTo) {
    // Returning to review after an edit.
    wizardEditReturnTo = null;
    wizardStep = _wizardSkipsLocation() ? 5 : 6;
  } else {
    wizardStep += 1;
    if (wizardStep === 3 && _wizardSkipsLocation()) wizardStep = 4;
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

// Default grid_width / grid_height when the user picks each type. Inch-unit
// types use realistic small sizes; bed types start at 4 ft × 4 ft.
var _DEFAULT_GRID_BY_TYPE = {
  indoor_pot:          { w: 12, h: 12 },
  indoor_planter_box:  { w: 24, h: 12 },
  greenhouse:          { w: 8,  h: 8  },
  outdoor_pot:         { w: 16, h: 16 },
  outdoor_planter_box: { w: 36, h: 12 },
  garden_bed:          { w: 4,  h: 4  },
  raised_bed:          { w: 4,  h: 4  }
};

function _defaultGridFor(t) {
  return _DEFAULT_GRID_BY_TYPE[t] || { w: 4, h: 4 };
}

// Flat list helper for any code that still needs to iterate every option.
function _allPlanterTypes() {
  return PLANTER_TYPE_COLUMNS.indoor.concat(PLANTER_TYPE_COLUMNS.outdoor);
}

// Mini-preview state: a Three.js handle reused on each rebuild + a debounce id.
var _wizardPreviewHandle = null;
var _wizardPreviewRebuildId = null;

function _disposeWizardPreview() {
  if (_wizardPreviewHandle && typeof dispose2DView === 'function') {
    try { dispose2DView(_wizardPreviewHandle); } catch (_) {}
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
    if (_wizardPreviewHandle && typeof dispose2DView === 'function') {
      try { dispose2DView(_wizardPreviewHandle); } catch (_) {}
      _wizardPreviewHandle = null;
    }
    var fakeGarden = {
      grid_width:  wizardDraft.grid_width  || 4,
      grid_height: wizardDraft.grid_height || 4,
      garden_type: wizardDraft.garden_type
    };
    if (typeof init2DView === 'function') {
      _wizardPreviewHandle = init2DView('wz-preview', fakeGarden, []);
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

function renderWizardStepTypeSize() {
  var html = '<div class="wizard-page">';
  html += _wizardHeader('What kind of planter — and how big?', 'Pick a planter type, then size it. The preview updates live.');

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
  }

  html += _wizardFooter({ nextDisabled: !wizardDraft.garden_type });
  html += '</div>';
  app.innerHTML = html;

  document.querySelectorAll('.wizard-option').forEach(function(btn) {
    btn.onclick = function() {
      var newType = btn.dataset.type;
      var wasType = wizardDraft.garden_type;
      wizardDraft.garden_type = newType;
      // Switching unit family OR planter category resets to a sensible default.
      if (wasType !== newType) {
        var changedUnits = gardenTypeUsesInches(wasType) !== gardenTypeUsesInches(newType);
        if (changedUnits || !wasType) {
          var d = _defaultGridFor(newType);
          wizardDraft.grid_width  = d.w;
          wizardDraft.grid_height = d.h;
        }
        if (wizardDraft.name_was_auto) {
          wizardDraft.name = _autoGardenName(newType);
        }
      }
      renderWizardStepTypeSize();
      _initIcons();
    };
  });

  _wizardBindCommon();
  document.getElementById('wizard-next').onclick = function() { _wizardAdvance(); };
  _bindSizeControls();

  if (wizardDraft.garden_type) _rebuildWizardPreview();

  _initIcons();
}

// Markup for the size controls — same widget as before, minus the name field.
function _renderSizeControls() {
  var usesInches = gardenTypeUsesInches(wizardDraft.garden_type);
  var html = '';
  if (usesInches) {
    // Pots and planter boxes — width × length in inches. Bigger range than
    // the old indoor-only widget so outdoor planter boxes (typically 24-48")
    // still fit. Same `wz-diam` / `wz-depth` IDs to reuse the bind handlers.
    html += '<div class="wizard-field-row">'
         +   '<label class="wizard-field flex-1">'
         +     '<span class="wizard-field-label">Width (in)</span>'
         +     '<input id="wz-diam" type="number" min="4" max="72" class="input input-bordered input-sm" value="' + wizardDraft.grid_width + '" />'
         +   '</label>'
         +   '<label class="wizard-field flex-1">'
         +     '<span class="wizard-field-label">Length (in)</span>'
         +     '<input id="wz-depth" type="number" min="4" max="72" class="input input-bordered input-sm" value="' + wizardDraft.grid_height + '" />'
         +   '</label>'
         + '</div>';
  } else {
    var presets = [
      { v: '4x4',    label: '4×4 ft' },
      { v: '4x8',    label: '4×8 ft' },
      { v: '8x8',    label: '8×8 ft' },
      { v: 'custom', label: 'Custom' }
    ];
    var current = wizardDraft.grid_width + 'x' + wizardDraft.grid_height;
    if (current !== '4x4' && current !== '4x8' && current !== '8x8') current = 'custom';
    html += '<div class="wizard-presets">';
    for (var i = 0; i < presets.length; i++) {
      var active = presets[i].v === current ? ' active' : '';
      html += '<button type="button" class="wizard-preset' + active + '" data-preset="' + presets[i].v + '">' + presets[i].label + '</button>';
    }
    html += '</div>';
    html += '<div id="wz-custom" class="wizard-field-row" style="' + (current === 'custom' ? '' : 'display:none') + '">'
         +   '<label class="wizard-field flex-1">'
         +     '<span class="wizard-field-label">Width (ft)</span>'
         +     '<input id="wz-w" type="number" min="1" max="20" class="input input-bordered input-sm" value="' + wizardDraft.grid_width + '" />'
         +   '</label>'
         +   '<label class="wizard-field flex-1">'
         +     '<span class="wizard-field-label">Depth (ft)</span>'
         +     '<input id="wz-h" type="number" min="1" max="20" class="input input-bordered input-sm" value="' + wizardDraft.grid_height + '" />'
         +   '</label>'
         + '</div>';
  }
  return html;
}

function _bindSizeControls() {
  function afterChange() {
    var cap = document.getElementById('wz-preview-cap');
    if (cap) cap.textContent = sizeLabelFor(wizardDraft);
    _rebuildWizardPreview();
  }
  var diam = document.getElementById('wz-diam');
  if (diam) diam.oninput = function(e) {
    wizardDraft.grid_width = Math.max(1, parseInt(e.target.value) || 12);
    afterChange();
  };
  var depth = document.getElementById('wz-depth');
  if (depth) depth.oninput = function(e) {
    wizardDraft.grid_height = Math.max(1, parseInt(e.target.value) || 10);
    afterChange();
  };
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
        // Sync the custom inputs so toggling back to Custom shows the preset.
        var w = document.getElementById('wz-w');
        var h = document.getElementById('wz-h');
        if (w) w.value = wizardDraft.grid_width;
        if (h) h.value = wizardDraft.grid_height;
        afterChange();
      }
    };
  });
  var w = document.getElementById('wz-w');
  var h = document.getElementById('wz-h');
  if (w) w.oninput = function(e) {
    wizardDraft.grid_width  = Math.max(1, parseInt(e.target.value) || 4);
    afterChange();
  };
  if (h) h.oninput = function(e) {
    wizardDraft.grid_height = Math.max(1, parseInt(e.target.value) || 4);
    afterChange();
  };
}

// ── Step 3: Light ───────────────────────────────────────────────────────────

var LIGHT_OPTIONS = [
  { id: 'full_sun', label: 'Full sun',    icon: '☀️',  desc: '6+ hours of direct sun' },
  { id: 'partial',  label: 'Partial sun', icon: '⛅',  desc: '3–6 hours of direct sun' },
  { id: 'shade',    label: 'Shade',       icon: '☁️',  desc: 'Less than 3 hours of direct sun' }
];

function renderWizardStepLight() {
  var subtitle = gardenTypeIsClimateControlled(wizardDraft.garden_type)
    ? 'How sunny is the spot for this planter?'
    : 'How much direct sun does this planter get?';

  var html = '<div class="wizard-page">';
  html += _wizardHeader('Light conditions', subtitle);
  html += '<div class="wizard-options">';
  for (var i = 0; i < LIGHT_OPTIONS.length; i++) {
    var o = LIGHT_OPTIONS[i];
    var active = wizardDraft.shade_level === o.id ? ' active' : '';
    html += ''
      + '<button type="button" class="wizard-option' + active + '" data-light="' + o.id + '">'
      +   '<span class="wizard-option-icon">' + o.icon + '</span>'
      +   '<span class="wizard-option-body">'
      +     '<span class="wizard-option-label">' + escapeHtml(o.label) + '</span>'
      +     '<span class="wizard-option-desc">' + escapeHtml(o.desc) + '</span>'
      +   '</span>'
      + '</button>';
  }
  html += '</div>';
  html += _wizardFooter({});
  html += '</div>';
  app.innerHTML = html;

  document.querySelectorAll('.wizard-option').forEach(function(btn) {
    btn.onclick = function() {
      wizardDraft.shade_level = btn.dataset.light;
      renderGardenWizard();
      _initIcons();
    };
  });
  _wizardBindCommon();
  document.getElementById('wizard-next').onclick = function() { _wizardAdvance(); };
  _initIcons();
}

// ── Step 4: Location ────────────────────────────────────────────────────────

function renderWizardStepLocation() {
  var html = '<div class="wizard-page">';
  html += _wizardHeader('Where is this planter?', 'We use this to determine your USDA hardiness zone and which plants are native to your area.');

  html += '<div class="wizard-form">';
  if (wizardDraft.usda_zone) {
    html += '<div class="wizard-location-set">'
         +   '<div class="wizard-location-set-label"><i data-lucide="check-circle-2" style="width:1.1em;height:1.1em;color:#3a8a3e"></i> Location set</div>'
         +   '<div class="wizard-location-set-value">' + escapeHtml(wizardDraft.location_label || ('Zone ' + wizardDraft.usda_zone)) + '</div>'
         +   '<button type="button" class="btn btn-ghost btn-sm gap-1" id="wz-loc-change"><i data-lucide="edit-2" style="width:0.9em;height:0.9em"></i> Change</button>'
         + '</div>';
  } else {
    html += '<div class="wizard-location-empty">'
         +   '<i data-lucide="map-pin" style="width:2em;height:2em;color:rgba(0,0,0,0.3)"></i>'
         +   '<p class="text-sm opacity-70" style="margin:0.5rem 0">No location set yet.</p>'
         +   '<button type="button" class="btn btn-primary btn-sm gap-1" id="wz-loc-set"><i data-lucide="locate" style="width:0.9em;height:0.9em"></i> Set location</button>'
         + '</div>';
  }
  html += '</div>';

  html += _wizardFooter({ nextDisabled: !wizardDraft.usda_zone });
  html += '</div>';
  app.innerHTML = html;

  function openPicker() {
    openLocationPicker({
      onResolve: function(loc) {
        wizardDraft.usda_zone = loc.zone;
        wizardDraft.location_label = loc.label;
        renderGardenWizard();
        _initIcons();
      }
    });
  }
  var setBtn = document.getElementById('wz-loc-set');
  if (setBtn) setBtn.onclick = openPicker;
  var changeBtn = document.getElementById('wz-loc-change');
  if (changeBtn) changeBtn.onclick = openPicker;

  _wizardBindCommon();
  document.getElementById('wizard-next').onclick = function() { _wizardAdvance(); };
  _initIcons();
}

// ── Step 5: Water plan ──────────────────────────────────────────────────────

var WATER_OPTIONS = [
  { id: 'regular',    label: 'Regular irrigation', icon: '💧💧💧', desc: 'Watered on a schedule (drip, hose, sprinkler).' },
  { id: 'occasional', label: 'Occasional watering', icon: '💧💧',  desc: 'Watered when I remember; drought-tolerant plants thrive.' },
  { id: 'rain_only',  label: 'Rain only',          icon: '☔',     desc: 'No supplemental watering; only low-water plants survive.' }
];

// Climate-controlled planters are sheltered — rain isn't a real option.
function _wizardWaterOptions() {
  if (wizardDraft && gardenTypeIsClimateControlled(wizardDraft.garden_type)) {
    return WATER_OPTIONS.filter(function(o) { return o.id !== 'rain_only'; });
  }
  return WATER_OPTIONS;
}

function renderWizardStepWater() {
  // If the user came back here after switching to a sheltered type, a
  // previously-selected 'rain_only' is no longer valid — reset.
  var isSheltered = gardenTypeIsClimateControlled(wizardDraft.garden_type);
  if (isSheltered && wizardDraft.water_plan === 'rain_only') {
    wizardDraft.water_plan = 'regular';
  }
  var visibleOptions = _wizardWaterOptions();

  var html = '<div class="wizard-page">';
  html += _wizardHeader('How will you water it?', 'Plants are filtered to ones that thrive at this watering level.');
  html += '<div class="wizard-options">';
  for (var i = 0; i < visibleOptions.length; i++) {
    var o = visibleOptions[i];
    var active = wizardDraft.water_plan === o.id ? ' active' : '';
    html += ''
      + '<button type="button" class="wizard-option' + active + '" data-water="' + o.id + '">'
      +   '<span class="wizard-option-icon">' + o.icon + '</span>'
      +   '<span class="wizard-option-body">'
      +     '<span class="wizard-option-label">' + escapeHtml(o.label) + '</span>'
      +     '<span class="wizard-option-desc">' + escapeHtml(o.desc) + '</span>'
      +   '</span>'
      + '</button>';
  }
  html += '</div>';
  if (isSheltered) {
    html += '<p class="wizard-note">Rain isn\'t an option — sheltered planters depend on you to water them.</p>';
  }
  html += _wizardFooter({ nextLabel: wizardEditReturnTo ? 'Save & review' : 'Review' });
  html += '</div>';
  app.innerHTML = html;

  document.querySelectorAll('.wizard-option').forEach(function(btn) {
    btn.onclick = function() {
      wizardDraft.water_plan = btn.dataset.water;
      renderGardenWizard();
      _initIcons();
    };
  });
  _wizardBindCommon();
  document.getElementById('wizard-next').onclick = function() { _wizardAdvance(); };
  _initIcons();
}

// ── Step 5 (Planting season) ────────────────────────────────────────────────

var PLANTING_SEASON_OPTIONS = [
  { id: 'spring', label: 'Spring',  icon: '🌷', desc: 'Most annuals + warm-season crops start here.' },
  { id: 'summer', label: 'Summer',  icon: '☀️', desc: 'Quick-growing annuals; succession plantings.' },
  { id: 'fall',   label: 'Fall',    icon: '🍂', desc: 'Cool-season crops, perennials, bulbs.' },
  { id: 'winter', label: 'Winter',  icon: '❄️', desc: 'Indoor / greenhouse only in most zones.' }
];

function renderWizardStepPlantingSeason() {
  var html = '<div class="wizard-page">';
  html += _wizardHeader('When are you planting?', 'We\'ll show plants that suit this season for your conditions.');
  html += '<div class="wizard-options">';
  for (var i = 0; i < PLANTING_SEASON_OPTIONS.length; i++) {
    var o = PLANTING_SEASON_OPTIONS[i];
    var active = wizardDraft.planting_season === o.id ? ' active' : '';
    html += ''
      + '<button type="button" class="wizard-option' + active + '" data-season="' + o.id + '">'
      +   '<span class="wizard-option-icon">' + o.icon + '</span>'
      +   '<span class="wizard-option-body">'
      +     '<span class="wizard-option-label">' + escapeHtml(o.label) + '</span>'
      +     '<span class="wizard-option-desc">' + escapeHtml(o.desc) + '</span>'
      +   '</span>'
      + '</button>';
  }
  html += '</div>';
  html += _wizardFooter({ nextLabel: wizardEditReturnTo ? 'Save & review' : 'Review' });
  html += '</div>';
  app.innerHTML = html;

  document.querySelectorAll('.wizard-option').forEach(function(btn) {
    btn.onclick = function() {
      wizardDraft.planting_season = btn.dataset.season;
      renderGardenWizard();
      _initIcons();
    };
  });
  _wizardBindCommon();
  document.getElementById('wizard-next').onclick = function() { _wizardAdvance(); };
  _initIcons();
}


// ── Step 6: Review & confirm ────────────────────────────────────────────────

function _wizardSearchParams(draft) {
  // Build the same query the shopping step will use, so the review count is
  // honest. Includes the new planter_size + planting_season filters.
  var p = {};
  if (draft.shade_level)  p.shade_level   = draft.shade_level;
  if (draft.water_plan)   p.water_plan    = draft.water_plan;
  if (draft.usda_zone)    p.usda_zone     = draft.usda_zone;
  if (draft.planting_season) p.planting_season = draft.planting_season;
  if (draft.garden_type)  p.garden_type   = draft.garden_type;
  if (draft.grid_width)   p.grid_width    = draft.grid_width;
  if (draft.grid_height)  p.grid_height   = draft.grid_height;
  return p;
}

async function _refreshWizardMatchCount() {
  // Live count from /catalog/search. Updates the .wizard-match-pill in place
  // once results come back; failure is non-fatal and just hides the pill.
  var pill = document.getElementById('wizard-match-pill');
  if (!pill || !wizardDraft) return;
  try {
    var params = _wizardSearchParams(wizardDraft);
    params.limit = 50;
    var qs = Object.keys(params).map(function(k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    var data = await apiFetch('/catalog/search' + (qs ? '?' + qs : ''));
    var n = (data && data.plants) ? data.plants.length : 0;
    if (n === 0 && data && data.fill_triggered) {
      pill.innerHTML = '<span class="loading loading-spinner loading-xs"></span> Looking up plants for these conditions…';
    } else {
      pill.innerHTML = '<strong>' + n + '</strong> plants match these conditions in your catalog so far.';
    }
  } catch (err) {
    pill.style.display = 'none';
  }
}

function renderWizardStepReview() {
  var d = wizardDraft;
  // Empty pill renders immediately; _refreshWizardMatchCount fills it async.
  var matchHtml = '<div id="wizard-match-pill" class="wizard-match-pill"><span class="loading loading-spinner loading-xs"></span> Counting matches…</div>';

  // Edit jumps target the new step numbers: type+size = 1, light = 2,
  // location = 3, water = 4, season = 5. Name lives on the review page itself.
  var rows = [
    { step: 1, label: 'Planter type', value: plantertypeIcon(d.garden_type) + ' ' + plantertypeLabel(d.garden_type) },
    { step: 1, label: 'Size',         value: sizeLabelFor(d) },
    { step: 2, label: 'Light',        value: sunlightIcon(d.shade_level) + ' ' + sunlightLabel(d.shade_level) }
  ];
  if (!_wizardSkipsLocation()) {
    rows.push({ step: 3, label: 'Location', value: '📍 ' + (d.location_label || ('Zone ' + d.usda_zone)) });
  } else {
    rows.push({ step: 3, label: 'Location', value: 'Not needed (climate-controlled)', noEdit: true });
  }
  rows.push({ step: 4, label: 'Watering', value: '💧 ' + waterPlanLabel(d.water_plan) });
  rows.push({ step: 5, label: 'Planting season', value: _seasonIcon(d.planting_season) + ' ' + _seasonLabel(d.planting_season) });

  var html = '<div class="wizard-page">';
  html += _wizardHeader('Review your planter', 'Name your garden, then confirm. Nothing is saved until you do.');
  html += matchHtml;

  // Editable name field — prefilled with "<Type> #<n>"; manual edits persist.
  html += '<div class="wizard-review-name">'
       +   '<label class="wizard-field">'
       +     '<span class="wizard-field-label">Garden name</span>'
       +     '<input id="wz-name" type="text" class="input input-bordered input-sm" '
       +       'value="' + escapeHtml(d.name) + '" placeholder="' + escapeHtml(_autoGardenName(d.garden_type)) + '" />'
       +   '</label>'
       + '</div>';

  html += '<div class="wizard-review">';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    html += ''
      + '<div class="wizard-review-row">'
      +   '<div class="wizard-review-label">' + escapeHtml(r.label) + '</div>'
      +   '<div class="wizard-review-value">' + escapeHtml(String(r.value)) + '</div>'
      +   (r.noEdit ? '' : '<button type="button" class="wizard-review-edit" data-edit-step="' + r.step + '">Edit</button>')
      + '</div>';
  }
  html += '</div>';

  html += '<div class="wizard-footer">'
       +   '<button type="button" class="btn btn-ghost btn-sm" id="wizard-back-to-water"><i data-lucide="arrow-left" style="width:1em;height:1em"></i> Back</button>'
       +   '<button type="button" class="btn btn-primary btn-sm gap-1" id="wizard-confirm"><i data-lucide="check" style="width:1em;height:1em"></i> Create garden</button>'
       + '</div>';
  html += '</div>';
  app.innerHTML = html;

  // Name field — once the user types, stop auto-updating from the type.
  var nameEl = document.getElementById('wz-name');
  if (nameEl) {
    nameEl.oninput = function(e) {
      var v = e.target.value;
      wizardDraft.name = v;
      // Treat an empty field as "still auto" so it re-syncs if they later
      // change planter type, and so submit falls back to the placeholder.
      wizardDraft.name_was_auto = (v.trim().length === 0);
    };
  }

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
  document.getElementById('wizard-back-to-water').onclick = function() {
    wizardStep = 5;
    renderGardenWizard();
    _initIcons();
  };
  document.getElementById('wizard-confirm').onclick = submitGardenWizard;
  // Async live count from /catalog/search.
  _refreshWizardMatchCount();
  _initIcons();
}

async function submitGardenWizard() {
  var d = wizardDraft;
  if (!d) { showView('gardens'); return; }
  var btn = document.getElementById('wizard-confirm');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading loading-spinner loading-xs"></span> Creating…';
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
    var created = await apiFetch('/gardens', { method: 'POST', body: body });
    _disposeWizardPreview();
      wizardDraft = null;
    wizardStep = 1;
    wizardEditReturnTo = null;
    if (created && created.id) {
      // Newly-created planters drop into the shopping step before placement.
      if (typeof openShoppingForGarden === 'function') {
        openShoppingForGarden(created.id);
      } else {
        openGarden(created.id);
      }
    } else {
      showView('gardens');
    }
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="check" style="width:1em;height:1em"></i> Create garden';
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
