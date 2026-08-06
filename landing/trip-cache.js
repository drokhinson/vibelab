// trip-cache.js — opt-in offline storage for a single trip's payload.
//
// The trip page loads a whole trip (hero + every stop, including each stop's
// full html_content) in one request. That payload is everything the page needs
// to render, so stashing it in localStorage is enough to make a trip readable
// with no connection at all.
//
// Storing it is OPT-IN, PER TRIP, and OFF by default: the viewer flips the
// "Save offline" switch in the trip topbar. Two keys per trip:
//
//   person_trip_offline:<slug>  the flag. Absent means off — the default.
//   person_trip_cache:<slug>    the payload, {savedAt, trip}.
//
// write() is a no-op while the flag is off, so nothing is ever written to a
// viewer's device unless they asked for it. read() is gated on the flag too, so
// an entry left behind by a failed clear can never paint.
//
// Postcards carry inline maps, scripts and base64 art, so a trip can be megabytes.
// Every write is size-capped and quota-guarded, and returns a boolean: the
// background write after a refresh ignores it, while the switch — where the
// viewer explicitly asked to save — reports the failure and flips itself back.
(function () {
  "use strict";

  var FLAG_PREFIX = "person_trip_offline:";
  var DATA_PREFIX = "person_trip_cache:";
  // localStorage is typically ~5MB per origin and holds the admin key alongside
  // this. Refusing at 4MB leaves room rather than discovering the ceiling by
  // throwing partway through a write.
  var MAX_BYTES = 4 * 1024 * 1024;

  // Private-mode Safari and storage-blocked embeddings throw on access rather
  // than on use, so every entry point below goes through this.
  function store() {
    try { return window.localStorage; } catch (_) { return null; }
  }

  function flagKey(slug) { return FLAG_PREFIX + slug; }
  function dataKey(slug) { return DATA_PREFIX + slug; }

  function isEnabled(slug) {
    var s = store();
    if (!s || !slug) return false;
    try { return s.getItem(flagKey(slug)) === "1"; } catch (_) { return false; }
  }

  // Turning a trip off drops that trip's payload and nothing else — the other
  // saved trips are none of this one's business.
  function setEnabled(slug, on) {
    var s = store();
    if (!s || !slug) return;
    try {
      if (on) s.setItem(flagKey(slug), "1");
      else { s.removeItem(flagKey(slug)); s.removeItem(dataKey(slug)); }
    } catch (_) {}
  }

  function clear(slug) {
    var s = store();
    if (!s || !slug) return;
    try { s.removeItem(dataKey(slug)); } catch (_) {}
  }

  // Returns {savedAt, trip} or null. A payload that won't parse is dropped
  // rather than retried — it can only have been truncated or hand-edited.
  function read(slug) {
    var s = store();
    if (!s || !slug || !isEnabled(slug)) return null;
    var raw;
    try { raw = s.getItem(dataKey(slug)); } catch (_) { return null; }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.trip) { clear(slug); return null; }
      return parsed;
    } catch (_) {
      clear(slug);
      return null;
    }
  }

  // Every other trip's payload, so a quota failure can make room without
  // touching the flags (a trip the viewer switched on stays switched on — it
  // just refills its cache the next time it's opened).
  function otherDataKeys(slug) {
    var s = store();
    var keep = dataKey(slug);
    var out = [];
    try {
      for (var i = 0; i < s.length; i++) {
        var k = s.key(i);
        if (k && k.indexOf(DATA_PREFIX) === 0 && k !== keep) out.push(k);
      }
    } catch (_) {}
    return out;
  }

  // true if the trip is now saved. false means it isn't — too big, no room, or
  // storage unavailable. Callers that asked for this on the viewer's behalf
  // should say so; the background refresh just ignores it.
  function write(slug, trip) {
    var s = store();
    if (!s || !slug || !trip || !isEnabled(slug)) return false;

    var raw;
    try { raw = JSON.stringify({ savedAt: Date.now(), trip: trip }); } catch (_) { return false; }
    if (raw.length > MAX_BYTES) { clear(slug); return false; }

    try {
      s.setItem(dataKey(slug), raw);
      return true;
    } catch (_) {
      // Out of room. Evict the other trips and try once more; if it still
      // won't fit, leave no half-written entry behind.
      otherDataKeys(slug).forEach(function (k) {
        try { s.removeItem(k); } catch (_) {}
      });
      try {
        s.setItem(dataKey(slug), raw);
        return true;
      } catch (_) {
        clear(slug);
        return false;
      }
    }
  }

  window.TripCache = {
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    read: read,
    write: write,
    clear: clear,
  };
})();
