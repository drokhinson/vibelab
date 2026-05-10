// location.js — USDA hardiness-zone picker.
//
// Direct zone selection only — no geolocation, no ZIP lookup. The user picks
// a US state tile (which maps to a representative zone) or, for international
// users, picks a zone directly from the disclosure list.
//
// Used in two places:
//   • Wizard step 4 (gardens.js → renderWizardStepLocation) — rendered
//     INLINE via `renderInlineZonePicker(containerId, opts)`.
//   • Builder kebab "Change zone" (garden.js → openZoneEditor) — shown in
//     a modal via `openLocationPicker(opts)`.
//
// Both paths resolve to `{ zone, zone_number, label, source }`. Caller
// decides what to do with the result.

(function() {
  // ── USDA hardiness zone metadata ─────────────────────────────────────────
  // Aligned with Perenual's hardiness filter: integer zones 1–13. The
  // half-zone (a/b) suffix is dropped since Perenual takes a "min-max"
  // integer range. Colors approximate the official USDA 2023 hardiness map.
  var ZONE_META = {
    '1':  { color: '#3F2C7E', tempRange: 'Below -50 °F',  label: 'Extreme arctic' },
    '2':  { color: '#6342A0', tempRange: '-50 to -40 °F', label: 'Far north, very short growing season' },
    '3':  { color: '#3E7BCB', tempRange: '-40 to -30 °F', label: 'Cold continental' },
    '4':  { color: '#33B0A8', tempRange: '-30 to -20 °F', label: 'Cold winter, short summer' },
    '5':  { color: '#6BCB5F', tempRange: '-20 to -10 °F', label: 'Cold winter, mild summer' },
    '6':  { color: '#D6DD33', tempRange: '-10 to 0 °F',   label: 'Cool winter, warm summer' },
    '7':  { color: '#F4AE2C', tempRange: '0 to 10 °F',    label: 'Mild winter, warm summer' },
    '8':  { color: '#EA572D', tempRange: '10 to 20 °F',   label: 'Mild winter, hot summer' },
    '9':  { color: '#B7234C', tempRange: '20 to 30 °F',   label: 'Subtropical, light frost' },
    '10': { color: '#7D1A88', tempRange: '30 to 40 °F',   label: 'Subtropical, mostly frost-free' },
    '11': { color: '#361D77', tempRange: '40 to 50 °F',   label: 'Tropical, frost-free' },
    '12': { color: '#1D2767', tempRange: '50 to 60 °F',   label: 'Tropical' },
    '13': { color: '#0E1D60', tempRange: '60 to 70 °F',   label: 'Tropical' }
  };

  // Each US state's typical USDA zone + a tile-grid position so the buttons
  // form a rough silhouette of the country (NPR-style state-grid layout).
  // Zones are integer 1–13 (we collapse the dominant half-zone for display).
  var US_STATES = [
    { code: 'AK', name: 'Alaska',          zone: '4',  row: 7, col: 1 },
    { code: 'WA', name: 'Washington',      zone: '8',  row: 1, col: 2 },
    { code: 'OR', name: 'Oregon',          zone: '8',  row: 2, col: 2 },
    { code: 'CA', name: 'California',      zone: '9',  row: 3, col: 2 },
    { code: 'NV', name: 'Nevada',          zone: '7',  row: 3, col: 3 },
    { code: 'ID', name: 'Idaho',           zone: '6',  row: 2, col: 3 },
    { code: 'MT', name: 'Montana',         zone: '5',  row: 1, col: 3 },
    { code: 'WY', name: 'Wyoming',         zone: '5',  row: 2, col: 4 },
    { code: 'UT', name: 'Utah',            zone: '7',  row: 3, col: 4 },
    { code: 'AZ', name: 'Arizona',         zone: '9',  row: 4, col: 3 },
    { code: 'NM', name: 'New Mexico',      zone: '7',  row: 4, col: 4 },
    { code: 'CO', name: 'Colorado',        zone: '5',  row: 3, col: 5 },
    { code: 'ND', name: 'North Dakota',    zone: '4',  row: 1, col: 5 },
    { code: 'SD', name: 'South Dakota',    zone: '4',  row: 2, col: 5 },
    { code: 'NE', name: 'Nebraska',        zone: '5',  row: 3, col: 6 },
    { code: 'KS', name: 'Kansas',          zone: '6',  row: 4, col: 5 },
    { code: 'OK', name: 'Oklahoma',        zone: '7',  row: 5, col: 5 },
    { code: 'TX', name: 'Texas',           zone: '8',  row: 6, col: 5 },
    { code: 'MN', name: 'Minnesota',       zone: '4',  row: 1, col: 6 },
    { code: 'IA', name: 'Iowa',            zone: '5',  row: 2, col: 6 },
    { code: 'MO', name: 'Missouri',        zone: '6',  row: 4, col: 6 },
    { code: 'AR', name: 'Arkansas',        zone: '8',  row: 5, col: 6 },
    { code: 'LA', name: 'Louisiana',       zone: '9',  row: 6, col: 6 },
    { code: 'WI', name: 'Wisconsin',       zone: '5',  row: 1, col: 7 },
    { code: 'IL', name: 'Illinois',        zone: '6',  row: 3, col: 7 },
    { code: 'MS', name: 'Mississippi',     zone: '8',  row: 5, col: 7 },
    { code: 'AL', name: 'Alabama',         zone: '8',  row: 6, col: 7 },
    { code: 'MI', name: 'Michigan',        zone: '6',  row: 1, col: 8 },
    { code: 'IN', name: 'Indiana',         zone: '6',  row: 3, col: 8 },
    { code: 'KY', name: 'Kentucky',        zone: '6',  row: 4, col: 7 },
    { code: 'TN', name: 'Tennessee',       zone: '7',  row: 5, col: 8 },
    { code: 'GA', name: 'Georgia',         zone: '8',  row: 6, col: 8 },
    { code: 'FL', name: 'Florida',         zone: '10', row: 7, col: 8 },
    { code: 'OH', name: 'Ohio',            zone: '6',  row: 3, col: 9 },
    { code: 'WV', name: 'West Virginia',   zone: '6',  row: 4, col: 8 },
    { code: 'VA', name: 'Virginia',        zone: '7',  row: 4, col: 9 },
    { code: 'NC', name: 'North Carolina',  zone: '7',  row: 5, col: 9 },
    { code: 'SC', name: 'South Carolina',  zone: '8',  row: 6, col: 9 },
    { code: 'PA', name: 'Pennsylvania',    zone: '6',  row: 3, col: 10 },
    { code: 'MD', name: 'Maryland',        zone: '7',  row: 4, col: 10 },
    { code: 'DE', name: 'Delaware',        zone: '7',  row: 4, col: 11 },
    { code: 'NJ', name: 'New Jersey',      zone: '7',  row: 3, col: 11 },
    { code: 'NY', name: 'New York',        zone: '6',  row: 2, col: 10 },
    { code: 'CT', name: 'Connecticut',     zone: '6',  row: 2, col: 11 },
    { code: 'RI', name: 'Rhode Island',    zone: '7',  row: 2, col: 12 },
    { code: 'MA', name: 'Massachusetts',   zone: '6',  row: 1, col: 12 },
    { code: 'VT', name: 'Vermont',         zone: '5',  row: 1, col: 11 },
    { code: 'NH', name: 'New Hampshire',   zone: '5',  row: 1, col: 13 },
    { code: 'ME', name: 'Maine',           zone: '5',  row: 1, col: 14 },
    { code: 'HI', name: 'Hawaii',          zone: '12', row: 7, col: 2 },
    { code: 'DC', name: 'D.C.',            zone: '7',  row: 5, col: 10 }
  ];

  // Build the picker HTML and wire selection events into `container`.
  // `opts.selectedZone` highlights an existing pick; `opts.onPick` is called
  // with `{ zone, zone_number, label, source: 'manual' }` when the user
  // confirms the state pick or taps a zone row directly.
  function _buildPicker(container, opts) {
    opts = opts || {};
    var onPick = typeof opts.onPick === 'function' ? opts.onPick : function() {};

    // Selection state — local to this picker instance.
    // Coerce a pre-migration "6b"-style value to integer "6" so the picker
    // can still highlight a previously-saved zone after the realignment.
    var selectedZone = opts.selectedZone
      ? String(opts.selectedZone).replace(/[ab]$/i, '')
      : null;
    var selection = null;
    if (selectedZone) {
      var preState = US_STATES.find(function(s) { return s.zone === selectedZone; });
      if (preState) selection = { code: preState.code, name: preState.name, zone: preState.zone };
    }

    function render() {
      var html = '<p class="zone-picker-intro">Tap your state on the map below, or pick a zone directly. Zones go from coldest (cool blues) to hottest (deep purples).</p>';

      // Selected-state callout pill (filled in after each click).
      html += '<div id="pp-zone-callout" class="pp-zone-callout" aria-live="polite"></div>';

      // US tile-grid map.
      html += '<div class="pp-us-map" role="group" aria-label="US states">';
      for (var i = 0; i < US_STATES.length; i++) {
        var s = US_STATES[i];
        var meta = ZONE_META[s.zone] || { color: '#888' };
        var sel = (selection && selection.code === s.code) ? ' selected' : '';
        html += '<button type="button" class="pp-state' + sel + '" '
              + 'style="grid-row:' + s.row + ';grid-column:' + s.col + ';background:' + meta.color + ';" '
              + 'data-state="' + s.code + '" '
              + 'title="' + escapeHtml(s.name) + ' · Zone ' + s.zone + '">'
              + s.code
              + '</button>';
      }
      html += '</div>';

      // Confirm button — enabled only after a state is picked.
      html += '<div class="pp-zone-confirm-row">'
           +   '<button type="button" id="pp-zone-confirm" class="btn btn-sm btn-primary"'
           +     (selection ? '' : ' disabled') + '>Confirm zone</button>'
           + '</div>';

      // Toggle-disclosure to reveal the descriptive zone list (works for
      // users outside the US or who already know their zone).
      html += '<details class="pp-zone-list-details">';
      html += '<summary class="pp-zone-list-summary">Or pick a zone directly (international / I know my zone)</summary>';
      html += '<div class="pp-zone-list">';
      var allZones = Object.keys(ZONE_META);
      for (var z = 0; z < allZones.length; z++) {
        var key = allZones[z];
        var m = ZONE_META[key];
        html += '<button type="button" class="pp-zone-row" data-zone="' + key + '" '
             +    'aria-label="Zone ' + key + ' (' + escapeHtml(m.tempRange) + ', ' + escapeHtml(m.label) + ')">'
             +   '<span class="pp-zone-swatch" style="background:' + m.color + '"></span>'
             +   '<span class="pp-zone-row-code">Zone ' + key + '</span>'
             +   '<span class="pp-zone-row-temp">' + escapeHtml(m.tempRange) + '</span>'
             +   '<span class="pp-zone-row-label">' + escapeHtml(m.label) + '</span>'
             + '</button>';
      }
      html += '</div></details>';

      container.innerHTML = html;
      if (typeof _initIcons === 'function') _initIcons();
      bind();
      _renderCallout();
    }

    function _renderCallout() {
      var callout = container.querySelector('#pp-zone-callout');
      var confirmBtn = container.querySelector('#pp-zone-confirm');
      if (!callout) return;
      if (!selection) {
        callout.textContent = '';
        callout.classList.remove('show');
        if (confirmBtn) confirmBtn.disabled = true;
        return;
      }
      var meta = ZONE_META[selection.zone] || {};
      callout.innerHTML = '<span class="pp-zone-swatch" style="background:' + (meta.color || '#888') + '"></span>'
        + '<strong>' + escapeHtml(selection.name) + '</strong> · Zone ' + escapeHtml(selection.zone)
        + ' <span class="opacity-70">· ' + escapeHtml(meta.tempRange || '') + ' · ' + escapeHtml(meta.label || '') + '</span>';
      callout.classList.add('show');
      if (confirmBtn) confirmBtn.disabled = false;
    }

    function bind() {
      // State-tile picks set the selection without resolving.
      container.querySelectorAll('.pp-state').forEach(function(btn) {
        btn.onclick = function() {
          var code = btn.dataset.state;
          var stateRec = US_STATES.find(function(s) { return s.code === code; });
          if (!stateRec) return;
          selection = { code: stateRec.code, name: stateRec.name, zone: stateRec.zone };
          container.querySelectorAll('.pp-state.selected').forEach(function(el) { el.classList.remove('selected'); });
          btn.classList.add('selected');
          _renderCallout();
        };
      });

      // Confirm fires onPick with the selected state's zone.
      var confirmBtn = container.querySelector('#pp-zone-confirm');
      if (confirmBtn) confirmBtn.onclick = function() {
        if (!selection) return;
        var z = selection.zone;
        onPick({
          zone: z,
          zone_number: parseInt(z, 10),
          label: selection.name + ' · Zone ' + z,
          source: 'manual'
        });
      };

      // Direct zone-row picks bypass the state map (international / known zone).
      container.querySelectorAll('.pp-zone-row').forEach(function(btn) {
        btn.onclick = function() {
          var z = btn.dataset.zone;
          onPick({
            zone: z,
            zone_number: parseInt(z, 10),
            label: 'Zone ' + z,
            source: 'manual'
          });
        };
      });
    }

    render();
  }


  // Public — render the picker INLINE inside an existing element (no modal).
  window.renderInlineZonePicker = function renderInlineZonePicker(containerOrId, opts) {
    var container = (typeof containerOrId === 'string')
      ? document.getElementById(containerOrId)
      : containerOrId;
    if (!container) return;
    _buildPicker(container, opts);
  };

  // Public — open the picker in a modal dialog. Used by the builder's
  // kebab "Change zone" item.
  window.openLocationPicker = function openLocationPicker(opts) {
    opts = opts || {};
    var onResolve = typeof opts.onResolve === 'function' ? opts.onResolve : function() {};
    var onCancel  = typeof opts.onCancel  === 'function' ? opts.onCancel  : function() {};

    var dialog = document.createElement('dialog');
    dialog.className = 'pp-zone-dialog';
    dialog.innerHTML =
      '<div class="dialog-body">' +
        '<div class="dialog-header"><i data-lucide="map" style="width:1.1em;height:1.1em"></i> Pick your hardiness zone</div>' +
        '<div id="pp-zone-modal-body"></div>' +
        '<div style="display:flex;justify-content:flex-end;margin-top:1rem">' +
          '<button type="button" id="pp-zone-cancel" class="btn btn-ghost btn-sm">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dialog);
    if (typeof _initIcons === 'function') _initIcons();

    function close() { try { dialog.close(); } catch (_) {} dialog.remove(); }

    dialog.querySelector('#pp-zone-cancel').onclick = function() { close(); onCancel(); };
    dialog.addEventListener('close', function() { dialog.remove(); });

    _buildPicker(dialog.querySelector('#pp-zone-modal-body'), {
      selectedZone: opts.selectedZone,
      onPick: function(loc) { close(); onResolve(loc); }
    });

    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
  };
})();
