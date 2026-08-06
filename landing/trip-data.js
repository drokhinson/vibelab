// trip-data.js — where the trip page's payload comes from, and the two controls
// that govern it: the refresh button and the "Save offline" switch.
//
// There are two sources for the same payload. The network is the normal one.
// localStorage is the other, and only when this trip's Save-offline switch is on
// — which is per trip and off by default, so nothing is ever written to a
// viewer's device unless they asked for it (TripCache enforces that; this file
// just drives it).
//
// The rule that shapes everything here: a refresh NEVER invalidates what's on
// screen. The stops stay painted for the whole request, and a refresh that fails
// — or one made with no connection at all — leaves the trip exactly as it was.
// The spinning button is the only report. The single exception is a first load
// with nothing painted and nothing cached: there is no content to preserve, so
// the failure has to be shown.
//
//   TripData.init({ slug: fn, trip: fn, onData: fn(payload), onError: fn(msg),
//                   onSettled: fn })
(function () {
  "use strict";

  var PA = window.PersonAdmin;
  var refreshBtn = document.getElementById("trip-refresh-btn");
  var offlineSwitch = document.getElementById("trip-offline");
  var offlineInput = document.getElementById("trip-offline-input");

  var host = null;
  var refreshing = false;
  var errorTimer = null;

  function trip() { return host && host.trip(); }
  function slug() { return (host && host.slug()) || ""; }

  // ── Save offline ─────────────────────────────────────────────────────────
  // Appears once the trip has loaded, alongside the album and download pills it
  // shares the topbar with.
  function syncSwitch() {
    var t = trip();
    if (!t) { offlineSwitch.hidden = true; return; }
    var on = window.TripCache.isEnabled(t.slug);
    offlineSwitch.hidden = false;
    offlineInput.checked = on;
    var label = on
      ? "Saved for offline reading — click to remove"
      : "Save this trip for offline reading";
    offlineSwitch.title = label;
    offlineInput.setAttribute("aria-label", label);
  }

  // Turning it on saves what's already loaded straight away, so the trip is
  // usable without a connection immediately rather than after the next refresh.
  // This is the write the viewer explicitly asked for, so — unlike the
  // background one in refresh() — a failure has to be reported: silently leaving
  // the switch on would promise an offline copy that isn't there.
  offlineInput.addEventListener("change", function () {
    var t = trip();
    if (!t) return;
    if (!offlineInput.checked) {
      window.TripCache.setEnabled(t.slug, false);
      syncSwitch();
      return;
    }
    window.TripCache.setEnabled(t.slug, true);
    if (!window.TripCache.write(t.slug, t)) {
      window.TripCache.setEnabled(t.slug, false);
      syncSwitch();
      window.alert("Couldn't save this trip offline — there isn't enough room in this browser's storage.");
      return;
    }
    syncSwitch();
  });

  // ── Refresh ──────────────────────────────────────────────────────────────
  function spinning(on) {
    refreshBtn.classList.toggle("is-spinning", on);
    if (on) refreshBtn.setAttribute("aria-busy", "true");
    else refreshBtn.removeAttribute("aria-busy");
  }

  async function refresh() {
    if (refreshing) return;
    var s = slug();
    if (!s) return;

    refreshing = true;
    clearTimeout(errorTimer);
    refreshBtn.classList.remove("is-error");
    spinning(true);
    try {
      var data = await PA.publicFetch("/trips/" + encodeURIComponent(s));
      host.onData(data);
      window.TripCache.write(s, data); // a no-op unless this trip is saved
      syncSwitch();
    } catch (err) {
      if (!trip()) {
        host.onError(err.message);
        syncSwitch();
      } else {
        // Content is on screen and stays there. Tint the button and move on.
        refreshBtn.classList.add("is-error");
        errorTimer = setTimeout(function () {
          refreshBtn.classList.remove("is-error");
        }, 2500);
      }
    } finally {
      refreshing = false;
      spinning(false);
      if (host.onSettled) host.onSettled();
    }
  }

  // Deliberately does not clear anything first — see the header.
  refreshBtn.addEventListener("click", function () { refresh(); });

  // A trip saved for offline reading paints in full — hero, stops, and every
  // postcard's HTML — before anything touches the network, so it works with no
  // connection at all. The network pass then runs behind it and quietly replaces
  // it if the trip has moved on.
  function load() {
    if (!slug()) return false;
    var cached = window.TripCache.read(slug());
    if (cached) host.onData(cached.trip);
    syncSwitch();
    refresh();
    return !!cached;
  }

  window.TripData = {
    init: function (opts) { host = opts || null; },
    load: load,
    refresh: refresh,
    syncSwitch: syncSwitch,
  };
})();
