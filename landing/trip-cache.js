// trip-cache.js — opt-in offline storage for a single trip's payload.
//
// The trip page loads a whole trip (hero + every stop, including each stop's
// full html_content) in one request. That payload is everything the page needs
// to render, so stashing it is enough to make a trip readable with no
// connection at all.
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
// ── On size ───────────────────────────────────────────────────────────────
// Postcards carry inline scripts, inline CSS and base64 art, so a trip is
// routinely megabytes, and localStorage has a hard ~5MB per-origin ceiling. A
// trip with a recap carries that document too — it is fetched separately but
// stamped onto the payload precisely so it is saved with everything else, and it
// is the same shape of thing, so it lands on the same side of the budget. The
// payload is therefore gzipped before it is stored. That buys roughly 6× (gzip
// manages ~8× on this kind of HTML; base64-ing the bytes back into a string
// gives about a third of it away), which is the difference between a real trip
// fitting and not.
//
// It raises the ceiling; it does not remove it. A trip past ~15MB of raw JSON
// still won't fit, and write() reports how far over it was so the caller can say
// so honestly. Removing the ceiling outright means moving to IndexedDB.
//
// Note the unit throughout: browsers charge localStorage in UTF-16 code units,
// two bytes per character, so every budget here counts STORED CHARACTERS rather
// than bytes. Mixing the two is how the first version of this file ended up with
// a cap of roughly twice the real ceiling, which meant it never fired and the
// browser threw first.
(function () {
  "use strict";

  var FLAG_PREFIX = "person_trip_offline:";
  var DATA_PREFIX = "person_trip_cache:";

  // ~5MB of quota is ~2.5M UTF-16 characters. Leave headroom for the admin key
  // and for another saved trip rather than claiming the whole store.
  var MAX_CHARS = 2 * 1024 * 1024;
  // Same figure, as the total the store is assumed to hold — used to report what
  // is free when a save doesn't fit.
  var BUDGET_CHARS = 2.5 * 1024 * 1024;

  // Stored values are prefixed so the store describes its own format and can be
  // changed later without a migration step. An entry with NO prefix is raw JSON
  // from the first shipped version of this file; read() still understands it and
  // the next refresh rewrites it compressed.
  var GZIP_TAG = "gz1:";
  var RAW_TAG = "raw1:";

  // Private-mode Safari and storage-blocked embeddings throw on access rather
  // than on use, so every entry point below goes through this.
  function store() {
    try { return window.localStorage; } catch (_) { return null; }
  }

  function flagKey(slug) { return FLAG_PREFIX + slug; }
  function dataKey(slug) { return DATA_PREFIX + slug; }

  function canCompress() {
    return typeof window.CompressionStream === "function" &&
           typeof window.DecompressionStream === "function";
  }

  // ── Flag ─────────────────────────────────────────────────────────────────
  // Deliberately synchronous, unlike the payload: the switch reads this to paint
  // its initial state, and an async read there would show "off" for a frame on
  // every trip the viewer has actually saved.
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

  // ── Accounting ───────────────────────────────────────────────────────────
  // What this origin is currently using, in stored characters. Counted from the
  // store itself rather than navigator.storage.estimate(): that reports the
  // origin's overall storage picture, which is usually hundreds of megabytes
  // free and knows nothing about the separate ~5MB localStorage ceiling that is
  // the actual constraint here. It would cheerfully print "40 MB free" next to a
  // failure caused by a 5MB wall.
  function usedChars(exceptSlug) {
    var s = store();
    if (!s) return 0;
    var skip = exceptSlug ? dataKey(exceptSlug) : null;
    var total = 0;
    try {
      for (var i = 0; i < s.length; i++) {
        var k = s.key(i);
        if (!k || k === skip) continue;
        var v = s.getItem(k);
        total += k.length + (v ? v.length : 0);
      }
    } catch (_) {}
    return total;
  }

  // What is actually available for this trip's entry. Bounded by the per-entry
  // cap as well as by what the rest of the store has taken, so the figure quoted
  // in a failure message is the same one the write is judged against — telling
  // someone 5 MB is free and then refusing 4.5 MB would be worse than saying
  // nothing.
  function freeChars(slug) {
    return Math.max(0, Math.min(MAX_CHARS, Math.round(BUDGET_CHARS) - usedChars(slug)));
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

  // ── gzip <-> base64 ──────────────────────────────────────────────────────
  async function deflate(str) {
    var stream = new Blob([str]).stream().pipeThrough(new window.CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function inflate(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new window.DecompressionStream("gzip"));
    return await new Response(stream).text();
  }

  // Chunked on purpose: String.fromCharCode.apply on a multi-megabyte array
  // overruns the argument limit and throws — which is exactly the size this
  // whole file exists to handle.
  function toBase64(bytes) {
    var CHUNK = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return btoa(parts.join(""));
  }

  function fromBase64(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ── Read ─────────────────────────────────────────────────────────────────
  // Resolves to {savedAt, trip} or null. A payload that won't decompress or
  // won't parse is dropped rather than retried — it can only have been truncated
  // or hand-edited.
  async function read(slug) {
    var s = store();
    if (!s || !slug || !isEnabled(slug)) return null;
    var stored;
    try { stored = s.getItem(dataKey(slug)); } catch (_) { return null; }
    if (!stored) return null;

    try {
      var json;
      if (stored.indexOf(GZIP_TAG) === 0) {
        json = await inflate(fromBase64(stored.slice(GZIP_TAG.length)));
      } else if (stored.indexOf(RAW_TAG) === 0) {
        json = stored.slice(RAW_TAG.length);
      } else {
        json = stored; // untagged: raw JSON from the first shipped version
      }
      var parsed = JSON.parse(json);
      if (!parsed || !parsed.trip) { clear(slug); return null; }
      return parsed;
    } catch (_) {
      clear(slug);
      return null;
    }
  }

  // ── Write ────────────────────────────────────────────────────────────────
  // Resolves to a result object:
  //
  //   { ok, rawChars, storedChars, needChars, freeChars, compressed }
  //
  // ok:false means the trip is not saved — too big, no room, or storage
  // unavailable. The rest is everything the caller needs to explain why without
  // guessing: what the trip costs uncompressed, what compression got it down to,
  // what the entry actually needs, and what was available. All of it in stored
  // characters, so the figures are directly comparable.
  //
  // The background write after a refresh ignores the result; the switch, where
  // the viewer explicitly asked to save, reports it and flips itself back.
  function result(ok, fields) {
    var out = { ok: ok, rawChars: 0, storedChars: 0, needChars: 0, freeChars: 0, compressed: false };
    for (var k in fields) if (Object.prototype.hasOwnProperty.call(fields, k)) out[k] = fields[k];
    return out;
  }

  async function write(slug, trip) {
    var s = store();
    if (!s || !slug || !trip || !isEnabled(slug)) return result(false, {});

    var json;
    try { json = JSON.stringify({ savedAt: Date.now(), trip: trip }); }
    catch (_) { return result(false, {}); }

    var value;
    if (canCompress()) {
      try { value = GZIP_TAG + toBase64(await deflate(json)); }
      catch (_) { value = RAW_TAG + json; } // compression itself failed; still try
    } else {
      value = RAW_TAG + json;
    }

    // Everything below is measured in stored characters, the unit the browser
    // charges — see the header.
    var facts = {
      rawChars: json.length,
      storedChars: value.length,
      needChars: dataKey(slug).length + value.length,
      freeChars: freeChars(slug),
      compressed: value.indexOf(GZIP_TAG) === 0,
    };
    if (value.length > MAX_CHARS) { clear(slug); return result(false, facts); }

    try {
      s.setItem(dataKey(slug), value);
      return result(true, facts);
    } catch (_) {
      // Out of room. Evict the other saved trips and try once more; if it still
      // won't fit, leave no half-written entry behind.
      otherDataKeys(slug).forEach(function (k) {
        try { s.removeItem(k); } catch (_) {}
      });
      try {
        s.setItem(dataKey(slug), value);
        return result(true, facts);
      } catch (_) {
        clear(slug);
        facts.freeChars = freeChars(slug);
        return result(false, facts);
      }
    }
  }

  // Stored characters -> a figure a person can act on. Two bytes per UTF-16
  // code unit, so the megabytes quoted are the ones the browser is counting.
  function formatChars(chars) {
    var mb = (chars * 2) / (1024 * 1024);
    if (mb >= 10) return Math.round(mb) + " MB";
    if (mb >= 1) return mb.toFixed(1) + " MB";
    return Math.max(1, Math.round((chars * 2) / 1024)) + " KB";
  }

  window.TripCache = {
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    read: read,
    write: write,
    clear: clear,
    formatChars: formatChars,
  };
})();
