// trip.js — the trip page at /travel/:slug. Reads the slug from the path, paints
// the hero, and owns the routing between the two screens that live on this one
// page: the stop list (TripStops) and the full-screen postcard (StopView).
//
// The trip loads with every stop's html_content in a single request, so opening
// a stop is a pushState and a frame swap — no reload, no second fetch — and Back
// returns to the list with its scroll position and order toggle intact. This
// module is the only place that writes history; StopView asks it to move and
// never touches the URL.
//
// It is also the only place that assigns `trip` / `stops`. TripData fetches the
// payload (from the network, or from the offline cache when this trip is saved)
// and hands it here; TripStops and TripAdmin read it back through the accessors
// passed to their init().
(function () {
  "use strict";

  var PA = window.PersonAdmin;
  var tripScreen = document.getElementById("trip-screen");
  var eyebrowEl = document.getElementById("trip-eyebrow");
  var statusEl = document.getElementById("trip-status");
  var headlineEl = document.getElementById("trip-headline");
  var albumEl = document.getElementById("trip-album");
  var adminBar = document.getElementById("travel-admin-bar");
  var loginBtn = document.getElementById("admin-login-btn");
  var exportBtn = document.getElementById("trip-export-btn");
  var exportLabel = document.getElementById("trip-export-label");

  var trip = null;
  var stops = [];

  // ── Routing ───────────────────────────────────────────────────────────────
  // /travel/<trip-slug>            → the stop list
  // /travel/<trip-slug>/<stop-no>  → that stop's postcard, full screen
  // /travel/<trip-slug>/summary    → the whole-trip recap, full screen
  //
  // The stop number is 1-based over the *canonical* stops array — the same
  // number the card badge carries and StopView shows in its counter. Canonical,
  // not displayed, so the URL doesn't change meaning when the viewer flips the
  // list to oldest-first.
  //
  // The two second segments cannot collide: a stop's is always a number, so
  // "summary" is the only word that means anything there. Anything else is a
  // stale URL and gets rewritten back to the trip, which is also what a
  // /summary on a trip with no recap does.
  var TRAVEL_PATH = /^\/travel\/([^/]+)(?:\/([^/]+))?\/?$/;
  var SUMMARY_SEG = "summary";

  function parseRoute() {
    var m = TRAVEL_PATH.exec(window.location.pathname);
    if (!m) {
      // Not the deployed path shape (a local static server, a preview host that
      // serves trip.html directly). Fall back to the last segment as the slug.
      var parts = window.location.pathname.split("/").filter(Boolean);
      return {
        slug: parts.length ? decodeURIComponent(parts[parts.length - 1]) : "",
        stopNo: null, isSummary: false, hasStop: false,
      };
    }
    // parseInt so a zero-padded segment ("/05", matching the card badge) resolves;
    // resolveRoute rewrites it to the canonical unpadded form. `hasStop` is
    // tracked separately from `stopNo` so a segment that's present but unusable
    // ("/0", "/abc") is still recognised as a stale URL worth rewriting.
    var seg = m[2] == null ? null : decodeURIComponent(m[2]);
    var n = seg == null ? NaN : parseInt(seg, 10);
    return {
      slug: decodeURIComponent(m[1]),
      stopNo: isFinite(n) && n > 0 ? n : null,
      // Lowercased so "/Summary" resolves and is then normalised by
      // replaceState, the same courtesy "/05" already gets.
      isSummary: seg != null && seg.toLowerCase() === SUMMARY_SEG,
      hasStop: m[2] != null,
    };
  }

  // `seg` is a 1-based stop number, the string "summary", or null for the list.
  function pathFor(seg) {
    var base = "/travel/" + encodeURIComponent(trip && trip.slug ? trip.slug : parseRoute().slug);
    return seg ? base + "/" + seg : base;
  }

  // True once a card tap has pushed a stop entry, so ✕ / Escape can unwind it
  // with history.back() — that returns to the list at its previous scroll
  // position instead of stacking another entry. A deep link starts false.
  var pushedFromList = false;

  // Which of the three screens is up. The reader is shared between stops and the
  // recap, and StopView can't tell them apart — it only ever sees a list and an
  // index — so this is what a background refresh reads before deciding whether
  // it has any business repainting what's on screen. See applyTrip().
  var openView = null; // null | "stop" | "summary"

  function showList() {
    window.StopView.close();
    tripScreen.hidden = false;
    pushedFromList = false;
    openView = null;
    document.title = (trip ? (trip.title || trip.headline || "Trip") : "Trip") + " — David Rokhinson";
  }

  // Renders the stop screen for a canonical index. Does not touch history — the
  // callers below own that.
  function showStop(index) {
    var stop = stops[index];
    if (!stop) return;
    tripScreen.hidden = true;
    openView = "stop";
    document.title = (stop.title || "Postcard") + " — " + (trip ? (trip.title || "Trip") : "Trip");
    window.StopView.show(stops, index, { onNavigate: goToStop, onExit: exitStop });
  }

  // The recap, in the same reader. Unlike a stop it is not in the payload, so
  // this is the one screen on the page that can be waiting on the network; the
  // banner carries that state while it lands, and a failure leaves the list up
  // and says why rather than opening an empty reader.
  //
  // Resolves to true once the reader is up, so the callers know whether their
  // history entry actually landed on something.
  function showSummary() {
    var SM = window.TripSummary;
    if (!SM.has()) return Promise.resolve(false);
    SM.setLoading(true);
    return SM.load().then(function () {
      SM.setLoading(false);
      if (!SM.show(exitStop)) return false;
      tripScreen.hidden = true;
      openView = "summary";
      document.title = SM.title() + " — " + (trip ? (trip.title || "Trip") : "Trip");
      return true;
    }).catch(function (err) {
      SM.setLoading(false);
      window.alert("Could not open the recap: " + err.message);
      return false;
    });
  }

  // A card tap: push, so Back closes the postcard.
  function openStop(index) {
    if (!stops[index]) return;
    history.pushState({ stopNo: index + 1 }, "", pathFor(index + 1));
    pushedFromList = true;
    showStop(index);
  }

  // Previous / Next: replace, not push. The URL keeps tracking the stop on
  // screen, but paging through eighteen postcards doesn't bury the trip list
  // eighteen entries deep in the back stack.
  function goToStop(index) {
    if (!stops[index]) return;
    history.replaceState({ stopNo: index + 1 }, "", pathFor(index + 1));
    showStop(index);
  }

  // The recap's entry point: push, so Back closes it, exactly like a stop card.
  // The history entry goes down first so that Back is already wired if the
  // reader closes it mid-fetch; a failed open unwinds it again.
  function openSummary() {
    if (!window.TripSummary.has()) return;
    history.pushState({ view: "summary" }, "", pathFor(SUMMARY_SEG));
    pushedFromList = true;
    showSummary().then(function (opened) {
      if (!opened) { pushedFromList = false; history.replaceState({ stopNo: null }, "", pathFor(null)); }
    });
  }

  // Unwinds whichever reader is up — this is about history, not about what is on
  // screen, so the recap and the stops share it.
  function exitStop() {
    if (pushedFromList) { history.back(); return; } // popstate paints the list
    history.pushState({ stopNo: null }, "", pathFor(null));
    showList();
  }

  // Back/forward: replay whatever the URL now says, without writing history.
  window.addEventListener("popstate", function () {
    if (!trip) return;
    var route = parseRoute();
    if (route.isSummary && window.TripSummary.has()) {
      showSummary().then(function (opened) { if (!opened) showList(); });
      return;
    }
    var index = route.stopNo ? route.stopNo - 1 : -1;
    if (index >= 0 && stops[index]) showStop(index);
    else showList();
  });

  // The deep-link resolution, run once for the life of the page. A background
  // refresh must not re-run it — that would yank the reader back into a stop
  // they had already closed, or rewrite the URL under them.
  var routeResolved = false;

  function resolveRoute() {
    if (routeResolved) return;
    routeResolved = true;
    // The list is already painted underneath, so ✕ has somewhere to land. A stop
    // number that no longer exists (a deleted or reordered stop, a hand-typed
    // URL) quietly falls back to the trip rather than showing an error; a valid
    // but non-canonical one ("/05", "/Summary") is normalised. Either way
    // replaceState, so Back still leaves the site.
    //
    // A /summary on a trip that has no recap needs no branch of its own: it
    // isn't a stop number either, so it lands in the same rewrite below.
    var route = parseRoute();
    var index = route.stopNo ? route.stopNo - 1 : -1;
    if (route.isSummary && window.TripSummary.has()) {
      history.replaceState({ view: "summary" }, "", pathFor(SUMMARY_SEG));
      showSummary().then(function (opened) {
        if (!opened) history.replaceState({ stopNo: null }, "", pathFor(null));
      });
    } else if (index >= 0 && stops[index]) {
      history.replaceState({ stopNo: index + 1 }, "", pathFor(index + 1));
      showStop(index);
    } else if (route.hasStop) {
      history.replaceState({ stopNo: null }, "", pathFor(null));
    }
  }

  // ── Hero ──────────────────────────────────────────────────────────────────
  // Where the trip is in its life. The about page shows this on the cards, but
  // a reader who arrived by deep link or bookmark never saw those — so the pill
  // is what tells them whether the trip is still being added to.
  var STATUS_LABELS = { upcoming: "Upcoming", live: "Live", complete: "Complete" };

  // The trip's colour preset, stamped on <html> so every --trip-* token on the
  // page (and in person-travel.css, which styles the postcard reader) resolves
  // to that palette. The list is a whitelist, not a passthrough: an unknown or
  // absent theme — an offline copy cached before the column existed — falls
  // back to enamel rather than writing an attribute nothing has styles for.
  var THEMES = ["enamel", "terracotta", "pine", "plum"];

  function applyTheme() {
    var theme = trip && trip.theme;
    if (THEMES.indexOf(theme) < 0) theme = "enamel";
    document.documentElement.setAttribute("data-trip-theme", theme);
  }

  function renderStatus() {
    // The lookup is also the validation: an unrecognised (or absent) status —
    // an offline copy cached before the field existed, say — shows nothing
    // rather than an empty pill, and never reaches the class name.
    var label = trip && STATUS_LABELS[trip.status];
    if (!label) {
      statusEl.hidden = true;
      statusEl.textContent = "";
      return;
    }
    statusEl.hidden = false;
    statusEl.className = "trip-status trip-status--" + trip.status;
    statusEl.innerHTML = trip.status === "live"
      ? '<span class="trip-status__dot" aria-hidden="true"></span>' + label
      : label;
  }

  function renderHero() {
    applyTheme();
    var heading = trip.headline || trip.title || "Trip";
    document.title = (trip.title || heading) + " — David Rokhinson";
    eyebrowEl.textContent = trip.eyebrow || "";
    eyebrowEl.style.display = trip.eyebrow ? "" : "none";
    renderStatus();
    headlineEl.textContent = heading;
    var albumLabel = albumEl.querySelector("span");
    if (trip.photo_album_url) {
      albumEl.href = trip.photo_album_url;
      albumEl.setAttribute("target", "_blank");
      albumEl.classList.remove("album-link--empty");
      if (albumLabel) albumLabel.textContent = "Photo album ↗";
    } else {
      // No album set — show a muted, non-clickable "No album" pill.
      albumEl.removeAttribute("href");
      albumEl.removeAttribute("target");
      albumEl.classList.add("album-link--empty");
      if (albumLabel) albumLabel.textContent = "No album";
    }
    albumEl.hidden = false;
  }

  // ── Painting a payload ────────────────────────────────────────────────────
  function renderStops() {
    exportBtn.hidden = !stops.length; // nothing to take away until there's a postcard
    window.TripStops.render();
    window.TripSummary.render();
  }

  function applyTrip(data) {
    // Gated on openView, not just on StopView being up: with the recap open the
    // reader holds a one-element list, so currentIndex() is 0 and this would
    // otherwise compare the recap against stop 01 — and swap it out underneath
    // the reader if the two happened to differ.
    var openIndex = openView === "stop" && window.StopView.isOpen()
      ? window.StopView.currentIndex() : -1;
    var openStop = openIndex >= 0 ? stops[openIndex] : null;

    // The recap document is fetched separately, so a fresh payload never carries
    // it. Bring the copy we already have across, or a background refresh would
    // throw it away — and the next offline write would save a trip without it.
    if (trip && trip.summary_html && !data.summary_html) data.summary_html = trip.summary_html;

    trip = data;
    stops = data.stops || [];
    renderHero();
    renderStops();

    // A refresh that lands while a postcard is open repaints the list behind it,
    // which is invisible. Re-rendering the postcard itself is not: it would
    // reload the card and throw away the reader's scroll position and whichever
    // side of the flip they were on. So only do that if the stop's HTML actually
    // changed underneath them.
    if (openStop) {
      var still = stops[openIndex];
      if (!still) exitStop();
      else if (still.html_content !== openStop.html_content) showStop(openIndex);
    }
    // The recap on screen needs no equivalent: its document isn't in this
    // payload, so a refresh can't have changed it. The one case that matters is
    // it being deleted out from under the reader.
    if (openView === "summary" && !window.TripSummary.has()) exitStop();
  }

  function renderNotFound(message) {
    trip = null;
    headlineEl.textContent = "Trip not found";
    eyebrowEl.style.display = "none";
    renderStatus();
    albumEl.hidden = true;
    exportBtn.hidden = true;
    window.TripSummary.render(); // trip is null now, so this hides the banner
    window.TripStops.renderError(message);
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  // Pencil (in the stops header) → edit-mode toggle.
  PA.wireLoginButton(loginBtn);

  window.TripStops.init({
    stops: function () { return stops; },
    // Read for `status`, which picks which end of the trip the list opens on.
    trip: function () { return trip; },
    onOpen: openStop,
  });

  window.TripSummary.init({
    trip: function () { return trip; },
    slug: function () { return parseRoute().slug; },
    onOpen: openSummary,
  });

  window.TripData.init({
    slug: function () { return parseRoute().slug; },
    trip: function () { return trip; },
    onData: function (data) { applyTrip(data); resolveRoute(); },
    onError: renderNotFound,
    // The admin bar keeps itself in sync with admin state; this is the one
    // transition PA.onChange can't see — the trip only just stopped (or started)
    // being null.
    onSettled: function () { window.TripAdmin.renderBar(); },
  });

  // Hand TripAdmin the keys to the state it edits. setStops is
  // assign-and-repaint, so the admin module never calls a renderer of ours
  // directly.
  window.TripAdmin.init({
    bar: adminBar,
    trip: function () { return trip; },
    stops: function () { return stops; },
    setStops: function (next) { stops = next; renderStops(); },
    // Same assign-and-repaint verb as setStops, for the recap's three fields.
    // `patch` is {summary_html, summary_title, summary_caption} as submitted;
    // has_summary is derived here rather than waited on, because the admin echo
    // is deliberately the small card shape and doesn't carry it.
    setSummary: function (patch) {
      if (!trip) return;
      trip.summary_html = patch.summary_html || null;
      trip.summary_title = patch.summary_title || null;
      trip.summary_caption = patch.summary_caption || null;
      trip.has_summary = !!trip.summary_html;
      window.TripSummary.setDoc(trip.summary_html);
      window.TripSummary.render();
      window.TripAdmin.renderBar(); // the button's label tracks has_summary
    },
    orderedStops: window.TripStops.orderedStops,
    canonicalFrom: window.TripStops.canonicalFrom,
  });

  // Download the whole trip as one static HTML file. Public — no admin gate.
  // Each stop is rendered in a hidden sandboxed frame and snapshotted, so this
  // takes a moment per postcard; the button reports progress meanwhile. `stops`
  // is passed canonical (00 → N) so the file reads chronologically regardless of
  // the on-screen order toggle.
  exportBtn.addEventListener("click", async function () {
    if (!trip || !stops.length) return;
    exportBtn.disabled = true;
    try {
      await window.TripExport.download(trip, stops, {
        onProgress: function (done, total) {
          exportLabel.textContent = "Preparing… " + done + "/" + total;
        },
      });
    } catch (err) {
      window.alert("Could not build the download: " + err.message);
    } finally {
      exportBtn.disabled = false;
      exportLabel.textContent = "Download";
    }
  });

  // Re-render when admin state flips. wireLoginButton keeps the pencil in sync
  // and TripAdmin keeps its own bar in sync; the stops only re-render once the
  // trip has loaded. The display order is deliberately NOT reset here, so
  // entering or leaving edit mode preserves the order the stops were just shown
  // in — that state lives in TripStops and nothing here touches it.
  PA.onChange(function () {
    if (!trip) return;
    renderStops();
  });

  document.addEventListener("DOMContentLoaded", function () {
    if (!parseRoute().slug) { headlineEl.textContent = "Trip not found"; return; }
    // Fire and forget: load() reports every failure through onError/the refresh
    // button itself, so there is nothing here to await or handle.
    window.TripData.load().catch(function () {});
  });
})();
