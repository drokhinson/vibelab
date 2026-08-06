// trip.js — renders a single trip page at /travel/:slug. Reads the slug from the
// path, fetches the trip + its stops, paints the hero + stop cards. Tapping a
// stop navigates to /travel/:slug/:stop, where StopView renders its stored HTML
// full-screen. In admin mode (?admin), adds create / edit / delete / reorder
// controls for stops.
//
// Both screens live on this one page: the trip loads with every stop's
// html_content in a single request, so opening a stop is a pushState and a
// frame swap — no reload, no second fetch — and Back returns to the list with
// its scroll position and order toggle intact. This module is the only place
// that writes history; StopView asks it to move and never touches the URL.
(function () {
  "use strict";

  var PA = window.PersonAdmin;
  var tripScreen = document.getElementById("trip-screen");
  var eyebrowEl = document.getElementById("trip-eyebrow");
  var headlineEl = document.getElementById("trip-headline");
  var albumEl = document.getElementById("trip-album");
  var adminBar = document.getElementById("travel-admin-bar");
  // Only the heading itself comes and goes — its row is permanent, because the
  // admin pencil and the order toggle live in it.
  var stopsHeadingEl = document.getElementById("stops-heading");
  var orderToggleBtn = document.getElementById("stops-order-toggle");
  var stopsEl = document.getElementById("stops");
  var loginBtn = document.getElementById("admin-login-btn");
  var exportBtn = document.getElementById("trip-export-btn");
  var exportLabel = document.getElementById("trip-export-label");

  var trip = null;
  var stops = [];
  // Display order. Default shows the newest (last-added) stop first — a
  // non-persisted, view-only flip of the canonical `stops` array. Entering edit
  // mode keeps whatever order was on screen (it does NOT snap back to canonical),
  // so the admin edits the stops in the order they were just looking at. The
  // per-row reorder maps back to canonical, so it stays correct in either order.
  var oldestFirst = false;

  function orderedStops() {
    return oldestFirst ? stops : stops.slice().reverse();
  }

  // The inverse of orderedStops(): takes an array in displayed order and returns
  // it in canonical order. TripAdmin's ↑/↓ arrows move a stop within what the
  // admin is looking at, and this is what turns that back into sort_order —
  // which keeps `oldestFirst` a private detail of this file.
  function canonicalFrom(view) {
    return oldestFirst ? view : view.slice().reverse();
  }

  function isAdmin() { return PA.isAdmin(); }

  // ── Routing ───────────────────────────────────────────────────────────────
  // /travel/<trip-slug>            → the stop list
  // /travel/<trip-slug>/<stop-no>  → that stop's postcard, full screen
  //
  // The stop number is 1-based over the *canonical* stops array — the same
  // number stopRow() stamps on the card badge and StopView shows in its counter.
  // Canonical, not displayed, so the URL doesn't change meaning when the viewer
  // flips the list to oldest-first.
  var TRAVEL_PATH = /^\/travel\/([^/]+)(?:\/([^/]+))?\/?$/;

  function parseRoute() {
    var m = TRAVEL_PATH.exec(window.location.pathname);
    if (!m) {
      // Not the deployed path shape (a local static server, a preview host that
      // serves trip.html directly). Fall back to the last segment as the slug.
      var parts = window.location.pathname.split("/").filter(Boolean);
      return { slug: parts.length ? decodeURIComponent(parts[parts.length - 1]) : "", stopNo: null, hasStop: false };
    }
    // parseInt so a zero-padded segment ("/05", matching the card badge) resolves;
    // loadTrip rewrites it to the canonical unpadded form. `hasStop` is tracked
    // separately from `stopNo` so a segment that's present but unusable ("/0",
    // "/abc") is still recognised as a stale URL worth rewriting.
    var n = m[2] == null ? NaN : parseInt(decodeURIComponent(m[2]), 10);
    return {
      slug: decodeURIComponent(m[1]),
      stopNo: isFinite(n) && n > 0 ? n : null,
      hasStop: m[2] != null,
    };
  }

  function pathFor(stopNo) {
    var base = "/travel/" + encodeURIComponent(trip && trip.slug ? trip.slug : parseRoute().slug);
    return stopNo ? base + "/" + stopNo : base;
  }

  // True once a card tap has pushed a stop entry, so ✕ / Escape can unwind it
  // with history.back() — that returns to the list at its previous scroll
  // position instead of stacking another entry. A deep link starts false.
  var pushedFromList = false;

  function showList() {
    window.StopView.close();
    tripScreen.hidden = false;
    pushedFromList = false;
    document.title = (trip ? (trip.title || trip.headline || "Trip") : "Trip") + " — David Rokhinson";
  }

  // Renders the stop screen for a canonical index. Does not touch history — the
  // callers below own that.
  function showStop(index) {
    var stop = stops[index];
    if (!stop) return;
    tripScreen.hidden = true;
    document.title = (stop.title || "Postcard") + " — " + (trip ? (trip.title || "Trip") : "Trip");
    window.StopView.show(stops, index, { onNavigate: goToStop, onExit: exitStop });
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

  function exitStop() {
    if (pushedFromList) { history.back(); return; } // popstate paints the list
    history.pushState({ stopNo: null }, "", pathFor(null));
    showList();
  }

  // Back/forward: replay whatever the URL now says, without writing history.
  window.addEventListener("popstate", function () {
    if (!trip) return;
    var route = parseRoute();
    var index = route.stopNo ? route.stopNo - 1 : -1;
    if (index >= 0 && stops[index]) showStop(index);
    else showList();
  });

  // ── Hero ──────────────────────────────────────────────────────────────────
  function renderHero() {
    var heading = trip.headline || trip.title || "Trip";
    document.title = (trip.title || heading) + " — David Rokhinson";
    eyebrowEl.textContent = trip.eyebrow || "";
    eyebrowEl.style.display = trip.eyebrow ? "" : "none";
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

  // ── Stop cards ──────────────────────────────────────────────────────────
  function stopRow(stop, index) {
    // Number belongs to the stop (its rank in the canonical sort_order), not the
    // display slot — so it travels with the card when the view order is flipped.
    // Shown 1-based even though sort_order is 0-based.
    var no = String(stops.indexOf(stop) + 1).padStart(2, "0");
    var noteHtml = stop.note ? '<p class="stop__note">' + PA.esc(stop.note) + "</p>" : "";
    // Empty string outside admin mode — the ↑ ↓ Edit Delete row lives in
    // trip-admin.js so this file stays about the public card.
    var controls = window.TripAdmin.controls(stop, index);
    return '' +
      '<li class="stop-row">' +
        '<button class="stop" data-id="' + PA.escAttr(stop.id) + '" data-title="' + PA.escAttr(stop.title) + '">' +
          '<span class="stop__no"><span class="n">' + PA.esc(no) + '</span><span class="lbl">Stop</span></span>' +
          '<span class="stop__body">' +
            '<span class="stop__city">' + PA.esc(stop.title) + "</span>" +
            (stop.meta ? '<span class="stop__meta">' + PA.esc(stop.meta) + "</span>" : "") +
            noteHtml +
          "</span>" +
          '<span class="stop__go" aria-hidden="true">↗</span>' +
        "</button>" +
        controls +
      "</li>";
  }

  // Public order toggle: visible only to non-admin viewers with 2+ stops (one
  // stop can't reorder; admin has its own per-row reorder controls).
  function syncOrderToggle() {
    var show = !isAdmin() && stops.length >= 2;
    orderToggleBtn.hidden = !show;
    if (!show) return;
    orderToggleBtn.setAttribute("aria-pressed", oldestFirst ? "true" : "false");
    orderToggleBtn.classList.toggle("is-reversed", oldestFirst);
    var label = oldestFirst ? "Show newest first" : "Show oldest first";
    orderToggleBtn.title = label;
    orderToggleBtn.setAttribute("aria-label", label);
  }

  function renderStops() {
    // Nothing to take away until there's at least one postcard.
    exportBtn.hidden = !stops.length;
    if (!stops.length) {
      stopsHeadingEl.hidden = !isAdmin();
      syncOrderToggle();
      stopsEl.innerHTML = isAdmin()
        ? '<li class="empty">No stops yet. Use “Add stop” above.</li>'
        : '<li class="empty">First postcard coming soon.</li>';
      return;
    }
    stopsHeadingEl.hidden = false;
    syncOrderToggle();
    stopsEl.innerHTML = orderedStops().map(stopRow).join("");
    wireStops();
  }

  function wireStops() {
    stopsEl.querySelectorAll(".stop").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        // Opens from memory — the whole trip (incl. every stop's HTML) is loaded
        // in one pass, so there's no per-stop fetch here. The index is into the
        // canonical order, NOT the displayed order: it becomes the URL's stop
        // number and drives Previous/Next, so both stay independent of this
        // page's order toggle.
        var idx = stops.findIndex(function (s) { return s.id === id; });
        if (idx >= 0) openStop(idx);
      });
    });
    window.TripAdmin.wireRows(stopsEl);
  }

  // ── Load ────────────────────────────────────────────────────────────────
  async function loadTrip() {
    var route = parseRoute();
    if (!route.slug) {
      headlineEl.textContent = "Trip not found";
      return;
    }
    try {
      trip = await PA.publicFetch("/trips/" + encodeURIComponent(route.slug));
      stops = trip.stops || [];
      renderHero();
      renderStops();
      // Deep link to a stop. The list is already painted underneath, so ✕ has
      // somewhere to land. A number that no longer exists (a deleted or
      // reordered stop, a hand-typed URL) quietly falls back to the trip rather
      // than showing an error; a valid but non-canonical one ("/05") is
      // normalised. Either way replaceState, so Back still leaves the site.
      var index = route.stopNo ? route.stopNo - 1 : -1;
      if (index >= 0 && stops[index]) {
        history.replaceState({ stopNo: index + 1 }, "", pathFor(index + 1));
        showStop(index);
      } else if (route.hasStop) {
        history.replaceState({ stopNo: null }, "", pathFor(null));
      }
    } catch (err) {
      trip = null;
      headlineEl.textContent = "Trip not found";
      eyebrowEl.style.display = "none";
      albumEl.hidden = true;
      stopsHeadingEl.hidden = true;
      orderToggleBtn.hidden = true;
      exportBtn.hidden = true;
      stopsEl.innerHTML = '<li class="empty empty--error">' + PA.esc(err.message) + "</li>";
    }
    // The bar keeps itself in sync with admin state; this is the one transition
    // PA.onChange can't see — the trip only just stopped being null.
    window.TripAdmin.renderBar();
  }

  // Pencil (in the stops header) → edit-mode toggle.
  PA.wireLoginButton(loginBtn);

  // Hand TripAdmin the keys to the state it edits. This file stays the only
  // thing that assigns `trip` / `stops`; setStops is assign-and-repaint, so the
  // admin module never calls a renderer of ours directly.
  window.TripAdmin.init({
    bar: adminBar,
    trip: function () { return trip; },
    stops: function () { return stops; },
    setStops: function (next) { stops = next; renderStops(); },
    orderedStops: orderedStops,
    canonicalFrom: canonicalFrom,
  });

  // Public reverse-order toggle. Lives outside #stops so it survives re-renders
  // and only needs wiring once.
  orderToggleBtn.addEventListener("click", function () {
    oldestFirst = !oldestFirst;
    renderStops();
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
  // trip has loaded. The display order (`oldestFirst`) is deliberately NOT reset
  // here, so entering or leaving edit mode preserves the order the stops were
  // just shown in.
  PA.onChange(function () {
    if (!trip) return;
    renderStops();
  });

  document.addEventListener("DOMContentLoaded", loadTrip);
})();
