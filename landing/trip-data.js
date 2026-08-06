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
  // Set once a network payload has been applied, so a slower cache read can't
  // paint stale content over it. See load().
  var networkLanded = false;

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
  offlineInput.addEventListener("change", async function () {
    var t = trip();
    if (!t) return;
    if (!offlineInput.checked) {
      window.TripCache.setEnabled(t.slug, false);
      syncSwitch();
      return;
    }
    window.TripCache.setEnabled(t.slug, true);
    var res = await window.TripCache.write(t.slug, t);
    if (!res.ok) {
      window.TripCache.setEnabled(t.slug, false);
      syncSwitch();
      window.alert(tooBigMessage(res));
      return;
    }
    syncSwitch();
  });

  // Compressing the payload buys a trip roughly six times the room, but the
  // ~5MB localStorage ceiling is still a ceiling. When a trip is past it, say by
  // how much and point at the thing that does work — the Download button is
  // right there in the same row, and it has no size limit at all.
  function tooBigMessage(res) {
    var fmt = window.TripCache.formatChars;
    if (!res.needChars) return "Couldn't save this trip offline — this browser's storage isn't available.";
    return "Couldn't save this trip offline — it needs about " + fmt(res.needChars) +
      " and only " + fmt(res.freeChars) + " is free in this browser's storage.\n\n" +
      "Use Download instead to keep a copy of the whole trip as a file.";
  }

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
      networkLanded = true;
      host.onData(data);
      // Fire and forget, and a no-op unless this trip is saved. A background
      // write that fails stays silent — only the switch reports.
      window.TripCache.write(s, data).catch(function () {});
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
  //
  // Reading the cache now means decompressing it, so it is asynchronous — but it
  // is still awaited BEFORE the network pass starts rather than raced against
  // it. Starting both together would, on a failed fetch, paint "Trip not found"
  // and then replace it with the cached trip a moment later — a flash of the
  // error in precisely the case this feature exists for. Decompressing costs a
  // few milliseconds; a wrong first paint costs more.
  //
  // `networkLanded` still guards the paint, because refresh() can also be fired
  // by the button while this is in flight.
  async function load() {
    if (!slug()) return false;
    var cached = null;
    try { cached = await window.TripCache.read(slug()); } catch (_) {}
    if (cached && !networkLanded) {
      host.onData(cached.trip);
      // Sync the switch here, not only in refresh(): loading offline from cache
      // means refresh() takes its failure path, which deliberately leaves the
      // painted page alone — so this is the only chance the switch gets to show
      // that this trip is saved.
      syncSwitch();
    }
    await refresh();
    return !!cached;
  }

  window.TripData = {
    init: function (opts) { host = opts || null; },
    load: load,
    refresh: refresh,
    syncSwitch: syncSwitch,
  };
})();
