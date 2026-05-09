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
  // Colors approximate the official USDA 2023 hardiness map; descriptions
  // are short user-friendly summaries to replace the bare zone codes.
  var ZONE_META = {
    '2a':  { color: '#5C4099', tempRange: '-50 to -45 °F', label: 'Far north, very short growing season' },
    '2b':  { color: '#6B4DAE', tempRange: '-45 to -40 °F', label: 'Far north, very short growing season' },
    '3a':  { color: '#4F6FCC', tempRange: '-40 to -35 °F', label: 'Cold continental' },
    '3b':  { color: '#2C8DD0', tempRange: '-35 to -30 °F', label: 'Cold continental' },
    '4a':  { color: '#2DA8B5', tempRange: '-30 to -25 °F', label: 'Cold winter, short summer' },
    '4b':  { color: '#38B698', tempRange: '-25 to -20 °F', label: 'Cold winter, short summer' },
    '5a':  { color: '#58C26F', tempRange: '-20 to -15 °F', label: 'Cold winter, mild summer' },
    '5b':  { color: '#98D44E', tempRange: '-15 to -10 °F', label: 'Cold winter, mild summer' },
    '6a':  { color: '#C5DD3B', tempRange: '-10 to -5 °F',  label: 'Cool winter, warm summer' },
    '6b':  { color: '#E7E12C', tempRange: '-5 to 0 °F',    label: 'Cool winter, warm summer' },
    '7a':  { color: '#F5C32F', tempRange: '0 to 5 °F',     label: 'Mild winter, warm summer' },
    '7b':  { color: '#F39C2A', tempRange: '5 to 10 °F',    label: 'Mild winter, warm summer' },
    '8a':  { color: '#EF6F2D', tempRange: '10 to 15 °F',   label: 'Mild winter, hot summer' },
    '8b':  { color: '#E04734', tempRange: '15 to 20 °F',   label: 'Mild winter, hot summer' },
    '9a':  { color: '#C72727', tempRange: '20 to 25 °F',   label: 'Subtropical, light frost' },
    '9b':  { color: '#A21E5A', tempRange: '25 to 30 °F',   label: 'Subtropical, light frost' },
    '10a': { color: '#8B1B7E', tempRange: '30 to 35 °F',   label: 'Subtropical, mostly frost-free' },
    '10b': { color: '#6F1A8E', tempRange: '35 to 40 °F',   label: 'Subtropical, mostly frost-free' },
    '11a': { color: '#481E80', tempRange: '40 to 45 °F',   label: 'Tropical, frost-free' },
    '11b': { color: '#2B216F', tempRange: '45 to 50 °F',   label: 'Tropical, frost-free' },
    '12a': { color: '#1F2D6B', tempRange: '50 to 55 °F',   label: 'Tropical' },
    '12b': { color: '#182665', tempRange: '55 to 60 °F',   label: 'Tropical' },
    '13a': { color: '#11215F', tempRange: '60 to 65 °F',   label: 'Tropical' },
    '13b': { color: '#0B1B59', tempRange: '65 to 70 °F',   label: 'Tropical' }
  };

  // Each US state's typical USDA zone + a tile-grid position so the buttons
  // form a rough silhouette of the country (NPR-style state-grid layout).
  var US_STATES = [
    { code: 'AK', name: 'Alaska',          zone: '4b',  row: 7, col: 1 },
    { code: 'WA', name: 'Washington',      zone: '8b',  row: 1, col: 2 },
    { code: 'OR', name: 'Oregon',          zone: '8b',  row: 2, col: 2 },
    { code: 'CA', name: 'California',      zone: '9b',  row: 3, col: 2 },
    { code: 'NV', name: 'Nevada',          zone: '7a',  row: 3, col: 3 },
    { code: 'ID', name: 'Idaho',           zone: '6a',  row: 2, col: 3 },
    { code: 'MT', name: 'Montana',         zone: '5a',  row: 1, col: 3 },
    { code: 'WY', name: 'Wyoming',         zone: '5a',  row: 2, col: 4 },
    { code: 'UT', name: 'Utah',            zone: '7a',  row: 3, col: 4 },
    { code: 'AZ', name: 'Arizona',         zone: '9b',  row: 4, col: 3 },
    { code: 'NM', name: 'New Mexico',      zone: '7b',  row: 4, col: 4 },
    { code: 'CO', name: 'Colorado',        zone: '5b',  row: 3, col: 5 },
    { code: 'ND', name: 'North Dakota',    zone: '4a',  row: 1, col: 5 },
    { code: 'SD', name: 'South Dakota',    zone: '4b',  row: 2, col: 5 },
    { code: 'NE', name: 'Nebraska',        zone: '5b',  row: 3, col: 6 },
    { code: 'KS', name: 'Kansas',          zone: '6b',  row: 4, col: 5 },
    { code: 'OK', name: 'Oklahoma',        zone: '7a',  row: 5, col: 5 },
    { code: 'TX', name: 'Texas',           zone: '8b',  row: 6, col: 5 },
    { code: 'MN', name: 'Minnesota',       zone: '4b',  row: 1, col: 6 },
    { code: 'IA', name: 'Iowa',            zone: '5b',  row: 2, col: 6 },
    { code: 'MO', name: 'Missouri',        zone: '6b',  row: 4, col: 6 },
    { code: 'AR', name: 'Arkansas',        zone: '8a',  row: 5, col: 6 },
    { code: 'LA', name: 'Louisiana',       zone: '9a',  row: 6, col: 6 },
    { code: 'WI', name: 'Wisconsin',       zone: '5a',  row: 1, col: 7 },
    { code: 'IL', name: 'Illinois',        zone: '6a',  row: 3, col: 7 },
    { code: 'MS', name: 'Mississippi',     zone: '8a',  row: 5, col: 7 },
    { code: 'AL', name: 'Alabama',         zone: '8a',  row: 6, col: 7 },
    { code: 'MI', name: 'Michigan',        zone: '6a',  row: 1, col: 8 },
    { code: 'IN', name: 'Indiana',         zone: '6a',  row: 3, col: 8 },
    { code: 'KY', name: 'Kentucky',        zone: '6b',  row: 4, col: 7 },
    { code: 'TN', name: 'Tennessee',       zone: '7a',  row: 5, col: 8 },
    { code: 'GA', name: 'Georgia',         zone: '8b',  row: 6, col: 8 },
    { code: 'FL', name: 'Florida',         zone: '10a', row: 7, col: 8 },
    { code: 'OH', name: 'Ohio',            zone: '6a',  row: 3, col: 9 },
    { code: 'WV', name: 'West Virginia',   zone: '6b',  row: 4, col: 8 },
    { code: 'VA', name: 'Virginia',        zone: '7b',  row: 4, col: 9 },
    { code: 'NC', name: 'North Carolina',  zone: '7b',  row: 5, col: 9 },
    { code: 'SC', name: 'South Carolina',  zone: '8a',  row: 6, col: 9 },
    { code: 'PA', name: 'Pennsylvania',    zone: '6b',  row: 3, col: 10 },
    { code: 'MD', name: 'Maryland',        zone: '7b',  row: 4, col: 10 },
    { code: 'DE', name: 'Delaware',        zone: '7b',  row: 4, col: 11 },
    { code: 'NJ', name: 'New Jersey',      zone: '7a',  row: 3, col: 11 },
    { code: 'NY', name: 'New York',        zone: '6a',  row: 2, col: 10 },
    { code: 'CT', name: 'Connecticut',     zone: '6b',  row: 2, col: 11 },
    { code: 'RI', name: 'Rhode Island',    zone: '7a',  row: 2, col: 12 },
    { code: 'MA', name: 'Massachusetts',   zone: '6b',  row: 1, col: 12 },
    { code: 'VT', name: 'Vermont',         zone: '5a',  row: 1, col: 11 },
    { code: 'NH', name: 'New Hampshire',   zone: '5b',  row: 1, col: 13 },
    { code: 'ME', name: 'Maine',           zone: '5a',  row: 1, col: 14 },
    { code: 'HI', name: 'Hawaii',          zone: '12a', row: 7, col: 2 },
    { code: 'DC', name: 'D.C.',            zone: '7b',  row: 5, col: 10 }
  ];

  // Build the picker HTML and wire selection events into `container`.
  // `opts.selectedZone` highlights an existing pick; `opts.onPick` is called
  // with `{ zone, zone_number, label, source: 'manual' }` when the user
  // confirms the state pick or taps a zone row directly.
  function _buildPicker(container, opts) {
    opts = opts || {};
    var onPick = typeof opts.onPick === 'function' ? opts.onPick : function() {};

    // Selection state — local to this picker instance.
    var selection = null;
    if (opts.selectedZone) {
      var preState = US_STATES.find(function(s) { return s.zone === opts.selectedZone; });
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
