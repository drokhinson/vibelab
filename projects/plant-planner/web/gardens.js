// gardens.js — My Gardens list view + 6-step New-Garden wizard.
//
// Wizard flow:
//   1. Planter type    — indoor | outdoor | garden_bed | raised_bed | greenhouse
//   2. Size + name     — width × height (ft) for outdoor; pot inches for indoor
//   3. Light           — full_sun | partial | shade
//   4. Location → zone — geolocation + ZIP fallback (skipped for indoor/greenhouse)
//   5. Water plan      — regular | occasional | rain_only
//   6. Review          — read-only summary, live match-count, Edit links, Confirm
//
// Nothing is written to the DB until step 6's Confirm. wizardDraft holds the
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
    case 'indoor':     return 'Indoor planter';
    case 'outdoor':    return 'Outdoor planter';
    case 'raised_bed': return 'Raised bed';
    case 'greenhouse': return 'Greenhouse';
    case 'garden_bed':
    default:           return 'Garden bed';
  }
}

function plantertypeIcon(t) {
  switch (t) {
    case 'indoor':     return '🪴';
    case 'outdoor':    return '🌿';
    case 'raised_bed': return '🟫';
    case 'greenhouse': return '🏠';
    case 'garden_bed':
    default:           return '🌱';
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
  if (g.garden_type === 'indoor') {
    // Indoor planters store inches in grid_width (diameter) and grid_height (depth).
    return g.grid_width + '" × ' + g.grid_height + '" pot';
  }
  return g.grid_width + '×' + g.grid_height + ' ft';
}

// ── Wizard entry / dispatch ─────────────────────────────────────────────────

function startGardenWizard() {
  // Defaults — pulled from the user's most recent garden where reasonable.
  var prev = (gardens && gardens[0]) || null;
  wizardDraft = {
    name: 'My Garden',
    garden_type: prev ? prev.garden_type : 'garden_bed',
    grid_width:  prev && prev.garden_type !== 'indoor' ? prev.grid_width  : 4,
    grid_height: prev && prev.garden_type !== 'indoor' ? prev.grid_height : 4,
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
  if      (wizardStep === 1) renderWizardStepType();
  else if (wizardStep === 2) renderWizardStepSize();
  else if (wizardStep === 3) renderWizardStepLight();
  else if (wizardStep === 4) renderWizardStepLocation();
  else if (wizardStep === 5) renderWizardStepWater();
  else                       renderWizardStepReview();
}

// Indoor and greenhouse planters skip the Location step (climate-controlled).
function _wizardStepsTotal() {
  return _wizardSkipsLocation() ? 5 : 6;
}
function _wizardSkipsLocation() {
  return wizardDraft && (wizardDraft.garden_type === 'indoor' || wizardDraft.garden_type === 'greenhouse');
}

function _wizardStepLabel() {
  // Compute "Step N of M" label, accounting for the skipped Location step.
  var total = _wizardStepsTotal();
  var displayed = wizardStep;
  if (_wizardSkipsLocation() && wizardStep > 4) displayed = wizardStep - 1;
  return 'Step ' + displayed + ' of ' + total;
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
  if (_wizardSkipsLocation() && wizardStep > 4) displayed = wizardStep - 1;
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
      if (wizardStep === 4 && _wizardSkipsLocation()) wizardStep = 3;
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
    if (wizardStep === 4 && _wizardSkipsLocation()) wizardStep = 5;
  }
  renderGardenWizard();
  _initIcons();
}

// ── Step 1: Planter type ────────────────────────────────────────────────────

var PLANTER_TYPE_OPTIONS = [
  { id: 'garden_bed', label: 'Garden bed',     icon: '🌱', desc: 'In-ground bed; outdoor; uses your local hardiness zone.' },
  { id: 'raised_bed', label: 'Raised bed',     icon: '🟫', desc: 'Elevated bed with controlled soil; outdoor.' },
  { id: 'outdoor',    label: 'Outdoor planter', icon: '🌿', desc: 'Container outside (deck, balcony, patio).' },
  { id: 'indoor',     label: 'Indoor planter', icon: '🪴', desc: 'Container indoors. Climate-controlled; no zone needed.' },
  { id: 'greenhouse', label: 'Greenhouse',     icon: '🏠', desc: 'Climate-controlled; no zone needed.' }
];

function renderWizardStepType() {
  var html = '<div class="wizard-page">';
  html += _wizardHeader('What kind of planter?', 'This shapes the rest of the questions.');
  html += '<div class="wizard-options">';
  for (var i = 0; i < PLANTER_TYPE_OPTIONS.length; i++) {
    var o = PLANTER_TYPE_OPTIONS[i];
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
  html += _wizardFooter({ nextDisabled: !wizardDraft.garden_type });
  html += '</div>';
  app.innerHTML = html;

  document.querySelectorAll('.wizard-option').forEach(function(btn) {
    btn.onclick = function() {
      var prevType = wizardDraft.garden_type;
      var newType = btn.dataset.type;
      wizardDraft.garden_type = newType;
      // Switching to/from indoor changes the size unit; reset to a sensible default.
      if (prevType !== newType) {
        if (newType === 'indoor') {
          wizardDraft.grid_width  = 12;  // 12-inch pot diameter
          wizardDraft.grid_height = 10;  // 10-inch depth
        } else if (prevType === 'indoor') {
          wizardDraft.grid_width  = 4;
          wizardDraft.grid_height = 4;
        }
      }
      renderGardenWizard();
      _initIcons();
    };
  });
  _wizardBindCommon();
  document.getElementById('wizard-next').onclick = function() { _wizardAdvance(); };
  _initIcons();
}

// ── Step 2: Size + name ─────────────────────────────────────────────────────

function renderWizardStepSize() {
  var isIndoor = wizardDraft.garden_type === 'indoor';
  var subtitle = isIndoor
    ? 'Tell us the pot size in inches.'
    : 'Pick a preset or enter custom dimensions in feet.';

  var html = '<div class="wizard-page">';
  html += _wizardHeader('Size & name', subtitle);

  html += '<div class="wizard-form">';
  // Name
  html += '<label class="wizard-field">'
       +   '<span class="wizard-field-label">Name</span>'
       +   '<input id="wz-name" type="text" class="input input-bordered input-sm" value="' + escapeHtml(wizardDraft.name) + '" />'
       + '</label>';

  if (isIndoor) {
    html += '<div class="wizard-field-row">'
         +   '<label class="wizard-field flex-1">'
         +     '<span class="wizard-field-label">Diameter (in)</span>'
         +     '<input id="wz-diam" type="number" min="4" max="48" class="input input-bordered input-sm" value="' + wizardDraft.grid_width + '" />'
         +   '</label>'
         +   '<label class="wizard-field flex-1">'
         +     '<span class="wizard-field-label">Depth (in)</span>'
         +     '<input id="wz-depth" type="number" min="4" max="36" class="input input-bordered input-sm" value="' + wizardDraft.grid_height + '" />'
         +   '</label>'
         + '</div>';
  } else {
    var presets = [
      { v: '4x4',   label: '4×4 ft' },
      { v: '4x8',   label: '4×8 ft' },
      { v: '8x8',   label: '8×8 ft' },
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
  html += '</div>';

  html += _wizardFooter({});
  html += '</div>';
  app.innerHTML = html;

  // Wire inputs into the draft on change.
  document.getElementById('wz-name').oninput = function(e) {
    wizardDraft.name = e.target.value;
  };

  if (isIndoor) {
    document.getElementById('wz-diam').oninput = function(e) {
      wizardDraft.grid_width = Math.max(1, parseInt(e.target.value) || 12);
    };
    document.getElementById('wz-depth').oninput = function(e) {
      wizardDraft.grid_height = Math.max(1, parseInt(e.target.value) || 10);
    };
  } else {
    document.querySelectorAll('.wizard-preset').forEach(function(btn) {
      btn.onclick = function() {
        var v = btn.dataset.preset;
        document.querySelectorAll('.wizard-preset').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        if (v === 'custom') {
          document.getElementById('wz-custom').style.display = '';
        } else {
          document.getElementById('wz-custom').style.display = 'none';
          var p = v.split('x');
          wizardDraft.grid_width  = parseInt(p[0]);
          wizardDraft.grid_height = parseInt(p[1]);
        }
      };
    });
    var w = document.getElementById('wz-w');
    var h = document.getElementById('wz-h');
    if (w) w.oninput = function(e) { wizardDraft.grid_width  = Math.max(1, parseInt(e.target.value) || 4); };
    if (h) h.oninput = function(e) { wizardDraft.grid_height = Math.max(1, parseInt(e.target.value) || 4); };
  }

  _wizardBindCommon();
  document.getElementById('wizard-next').onclick = function() { _wizardAdvance(); };
  _initIcons();
}

// ── Step 3: Light ───────────────────────────────────────────────────────────

var LIGHT_OPTIONS = [
  { id: 'full_sun', label: 'Full sun',    icon: '☀️',  desc: '6+ hours of direct sun' },
  { id: 'partial',  label: 'Partial sun', icon: '⛅',  desc: '3–6 hours of direct sun' },
  { id: 'shade',    label: 'Shade',       icon: '☁️',  desc: 'Less than 3 hours of direct sun' }
];

function renderWizardStepLight() {
  var subtitle = wizardDraft.garden_type === 'indoor'
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

// Indoor planters and greenhouses are sheltered — rain isn't a real option.
function _wizardWaterOptions() {
  if (wizardDraft && (wizardDraft.garden_type === 'indoor' || wizardDraft.garden_type === 'greenhouse')) {
    return WATER_OPTIONS.filter(function(o) { return o.id !== 'rain_only'; });
  }
  return WATER_OPTIONS;
}

function renderWizardStepWater() {
  // If the user came back to this step after switching to indoor/greenhouse,
  // a previously-selected 'rain_only' is no longer valid — reset.
  var isSheltered = wizardDraft.garden_type === 'indoor' || wizardDraft.garden_type === 'greenhouse';
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

// ── Step 6: Review & confirm ────────────────────────────────────────────────

function _matchCount(draft) {
  // How many plants in the catalog match this planter? Used as a sanity preview.
  if (!Array.isArray(plants) || plants.length === 0) return null;
  var prevFilters = catalogFilters;
  catalogFilters = { matchGarden: true, seasons: {}, types: {}, native: false, pollinators: false };
  try {
    var match = 0;
    for (var i = 0; i < plants.length; i++) {
      if (plantMatchesFilters(plants[i], draft)) match++;
    }
    return { match: match, total: plants.length };
  } finally {
    catalogFilters = prevFilters;
  }
}

function renderWizardStepReview() {
  var d = wizardDraft;
  var counts = _matchCount(d);
  var matchHtml = counts
    ? '<div class="wizard-match-pill"><strong>' + counts.match + '</strong> of ' + counts.total + ' plants are a great fit for this planter.</div>'
    : '';

  var rows = [
    { step: 1, label: 'Planter type', value: plantertypeIcon(d.garden_type) + ' ' + plantertypeLabel(d.garden_type) },
    { step: 2, label: 'Name',         value: d.name },
    { step: 2, label: 'Size',         value: sizeLabelFor(d) },
    { step: 3, label: 'Light',        value: sunlightIcon(d.shade_level) + ' ' + sunlightLabel(d.shade_level) },
  ];
  if (!_wizardSkipsLocation()) {
    rows.push({ step: 4, label: 'Location', value: '📍 ' + (d.location_label || ('Zone ' + d.usda_zone)) });
  } else {
    rows.push({ step: 4, label: 'Location', value: 'Not needed (climate-controlled)', noEdit: true });
  }
  rows.push({ step: 5, label: 'Watering', value: '💧 ' + waterPlanLabel(d.water_plan) });

  var html = '<div class="wizard-page">';
  html += _wizardHeader('Review your planter', 'Double-check the details. Nothing is saved until you confirm.');
  html += matchHtml;
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
    var body = {
      name: d.name || 'My Garden',
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
    wizardDraft = null;
    wizardStep = 1;
    wizardEditReturnTo = null;
    if (created && created.id) {
      // Open the new garden directly into the builder.
      openGarden(created.id);
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
    dismissedCompanionWarnings = new Set(
      (currentGarden && currentGarden.settings_json && Array.isArray(currentGarden.settings_json.dismissed_companion_warnings))
        ? currentGarden.settings_json.dismissed_companion_warnings
        : []
    );
    companionPopoverCellKey = null;
    placements = [];
    if (data.plants) {
      for (var i = 0; i < data.plants.length; i++) {
        var row = data.plants[i];
        var plantObj = row.plantplanner_plants || row;
        var pid = row.id ||
          ((window.crypto && typeof crypto.randomUUID === 'function')
            ? crypto.randomUUID()
            : ('p_' + i + '_' + Date.now()));
        placements.push({
          id: pid,
          plantId: plantObj.id || row.plant_id,
          plant: plantObj,
          pos_x: row.pos_x,
          pos_y: row.pos_y,
          radius_feet: (row.radius_feet != null) ? row.radius_feet : ((plantObj.spread_inches || 12) / 24)
        });
      }
    }
    viewMode = "top";
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
