// location.js — USDA hardiness-zone lookup from geolocation or ZIP.
//
// Used in two places:
//   • Step 4 of the New-Garden wizard (gardens.js → renderGardenWizardStep4)
//   • The Native filter toggle in the catalog (catalog.js) when no garden
//     location is set yet — opens the picker inline.
//
// Resolves to { zone, zoneNumber, label, source } via POST /location/lookup.
// Caller decides what to do with the result (write into wizard draft,
// update currentGarden, etc.).

(function() {
  // Wire the modal's three input modes. `onResolve(loc)` is called with
  // { zone, zone_number, label, source } when the user picks one.
  // `onCancel()` fires if the user closes without choosing.
  window.openLocationPicker = function openLocationPicker(opts) {
    opts = opts || {};
    var onResolve = typeof opts.onResolve === 'function' ? opts.onResolve : function() {};
    var onCancel  = typeof opts.onCancel  === 'function' ? opts.onCancel  : function() {};

    // Build modal
    var dialog = document.createElement('dialog');
    dialog.id = 'pp-location-dialog';
    dialog.className = 'pp-location-dialog';
    dialog.innerHTML = ''
      + '<div class="dialog-body" style="min-width:300px;max-width:380px">'
      +   '<div class="dialog-header"><i data-lucide="map-pin"></i> Set planter location</div>'
      +   '<p class="text-sm opacity-70" style="margin-top:0.25rem">Used to determine your USDA hardiness zone and which plants are native to your area.</p>'
      +   '<div id="pp-loc-error" class="error-banner" style="display:none;margin-top:0.5rem"></div>'
      +   '<div style="display:flex;flex-direction:column;gap:0.6rem;margin-top:1rem">'
      +     '<button type="button" id="pp-loc-gps" class="btn btn-primary btn-sm gap-1">'
      +       '<i data-lucide="locate" style="width:0.9em;height:0.9em"></i> Use my current location'
      +     '</button>'
      +     '<div class="auth-divider" style="margin:0.4rem 0"><span>or</span></div>'
      +     '<form id="pp-loc-zip-form" style="display:flex;gap:0.4rem">'
      +       '<input id="pp-loc-zip" class="input input-bordered input-sm" type="text" inputmode="numeric" maxlength="5" placeholder="ZIP code" style="flex:1" />'
      +       '<button type="submit" class="btn btn-sm btn-outline">Look up</button>'
      +     '</form>'
      +     '<button type="button" id="pp-loc-manual" class="btn btn-ghost btn-sm" style="margin-top:0.4rem">'
      +       '<i data-lucide="list" style="width:0.9em;height:0.9em"></i> Pick a zone manually'
      +     '</button>'
      +   '</div>'
      +   '<div style="display:flex;justify-content:flex-end;margin-top:1rem">'
      +     '<button type="button" id="pp-loc-cancel" class="btn btn-ghost btn-sm">Cancel</button>'
      +   '</div>'
      + '</div>';

    document.body.appendChild(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    if (typeof _initIcons === 'function') _initIcons();

    var errorEl = dialog.querySelector('#pp-loc-error');
    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    }
    function clearError() {
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    }
    function close() {
      try { dialog.close(); } catch (_) {}
      dialog.remove();
    }
    function resolve(loc) { close(); onResolve(loc); }
    function cancel()     { close(); onCancel(); }

    // GPS button
    dialog.querySelector('#pp-loc-gps').onclick = function() {
      clearError();
      if (!navigator.geolocation) {
        showError("This browser doesn't support geolocation. Use a ZIP code instead.");
        return;
      }
      var btn = dialog.querySelector('#pp-loc-gps');
      btn.disabled = true;
      btn.innerHTML = '<span class="loading loading-spinner loading-xs"></span> Getting location…';
      navigator.geolocation.getCurrentPosition(
        function(pos) {
          lookupCoords(pos.coords.latitude, pos.coords.longitude)
            .then(resolve)
            .catch(function(err) {
              btn.disabled = false;
              btn.innerHTML = '<i data-lucide="locate" style="width:0.9em;height:0.9em"></i> Use my current location';
              if (typeof _initIcons === 'function') _initIcons();
              showError(err.message || 'Lookup failed.');
            });
        },
        function(err) {
          btn.disabled = false;
          btn.innerHTML = '<i data-lucide="locate" style="width:0.9em;height:0.9em"></i> Use my current location';
          if (typeof _initIcons === 'function') _initIcons();
          if (err && err.code === err.PERMISSION_DENIED) {
            showError("Location permission denied. Try a ZIP code below.");
          } else {
            showError("Couldn't get your location. Try a ZIP code below.");
          }
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
      );
    };

    // ZIP form
    dialog.querySelector('#pp-loc-zip-form').onsubmit = function(e) {
      e.preventDefault();
      clearError();
      var zip = (dialog.querySelector('#pp-loc-zip').value || '').trim();
      if (!/^\d{3,5}$/.test(zip)) {
        showError("Enter a 3-5 digit ZIP code.");
        return;
      }
      lookupZip(zip)
        .then(resolve)
        .catch(function(err) { showError(err.message || 'Lookup failed.'); });
    };

    // Manual zone picker fallback — renders zones 2a..11b inline.
    dialog.querySelector('#pp-loc-manual').onclick = function() {
      clearError();
      _renderManualZones(dialog, function(loc) { resolve(loc); });
    };

    dialog.querySelector('#pp-loc-cancel').onclick = cancel;
    dialog.addEventListener('cancel', function(e) { e.preventDefault(); cancel(); });
  };

  function _renderManualZones(dialog, onPick) {
    var body = dialog.querySelector('.dialog-body');
    var zones = [];
    for (var n = 2; n <= 11; n++) {
      zones.push(n + 'a');
      zones.push(n + 'b');
    }
    var html = '<div class="dialog-header"><i data-lucide="list"></i> Pick your USDA zone</div>';
    html += '<p class="text-sm opacity-70" style="margin-top:0.25rem">If you already know your hardiness zone, choose it here. The Native filter will use it.</p>';
    html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0.35rem;margin-top:0.75rem">';
    for (var i = 0; i < zones.length; i++) {
      html += '<button type="button" class="btn btn-sm btn-outline pp-zone-btn" data-zone="' + zones[i] + '">' + zones[i] + '</button>';
    }
    html += '</div>';
    html += '<div style="display:flex;justify-content:flex-end;margin-top:1rem">';
    html += '<button type="button" id="pp-loc-cancel-2" class="btn btn-ghost btn-sm">Cancel</button>';
    html += '</div>';
    body.innerHTML = html;
    if (typeof _initIcons === 'function') _initIcons();

    body.querySelectorAll('.pp-zone-btn').forEach(function(btn) {
      btn.onclick = function() {
        var z = btn.dataset.zone;
        var num = parseInt(z, 10);
        onPick({
          zone: z,
          zone_number: num,
          label: 'Zone ' + z,
          source: 'manual'
        });
      };
    });
    body.querySelector('#pp-loc-cancel-2').onclick = function() {
      try { dialog.close(); } catch (_) {}
      dialog.remove();
    };
  }

  function lookupZip(zip) {
    return apiFetch('/location/lookup', { method: 'POST', body: { zip: zip } });
  }

  function lookupCoords(lat, lng) {
    return apiFetch('/location/lookup', { method: 'POST', body: { lat: lat, lng: lng } });
  }
})();
