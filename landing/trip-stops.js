// trip-stops.js — the trip page's stop list: the cards, the section heading, and
// the public newest/oldest order toggle.
//
// Display order is this module's private business. Everywhere else on the page
// `stops` is canonical (sort_order, oldest first) — the URL's stop number,
// StopView's Previous/Next and the badge on each card all count in it — and this
// is the only file that flips it for display. orderedStops() and canonicalFrom()
// are the two directions of that mapping; TripAdmin uses the pair to move a row
// within what the admin is looking at and store the result back as sort_order.
//
//   TripStops.init({ stops: fn, trip: fn, onOpen: fn(canonicalIndex) })
(function () {
  "use strict";

  var PA = window.PersonAdmin;
  // Only the heading itself comes and goes — its row is permanent, because the
  // admin pencil, the refresh button and the order toggle all live in it.
  var headingEl = document.getElementById("stops-heading");
  var toggleBtn = document.getElementById("stops-order-toggle");
  var listEl = document.getElementById("stops");

  var host = null;

  function stops() { return (host && host.stops()) || []; }
  function trip() { return (host && host.trip && host.trip()) || null; }
  function isAdmin() { return PA.isAdmin(); }

  // Which end of the trip the list opens on — a non-persisted, view-only flip of
  // the canonical array. Entering edit mode keeps whatever order was on screen
  // (it does NOT snap back to canonical), so the admin edits the stops in the
  // order they were just looking at.
  //
  // The starting value comes from the trip's status, because a trip that is
  // still happening and one that is over want opposite ends: a live trip is
  // being followed, so the newest postcard belongs at the top, while a finished
  // trip is read as a story and starts at stop 01. An upcoming trip is an
  // itinerary, so it reads forwards too.
  var oldestFirst = false;

  // The status default is a starting point, not a rule — applied once, the first
  // time a trip lands, and never again. TripData repaints on every background
  // refresh and after every admin edit, and re-deriving here would yank the list
  // back out of whatever order the reader had chosen.
  var statusDefaultApplied = false;

  function applyStatusDefault() {
    if (statusDefaultApplied) return;
    var t = trip();
    if (!t) return;
    statusDefaultApplied = true;
    // Anything that isn't 'live' reads forwards, which also covers a payload
    // with no status at all (an offline copy cached before the column existed).
    oldestFirst = t.status !== "live";
  }

  function orderedStops() {
    var all = stops();
    return oldestFirst ? all : all.slice().reverse();
  }

  // The inverse of orderedStops(): takes an array in displayed order and returns
  // it in canonical order. TripAdmin's ↑/↓ arrows move a stop within what the
  // admin is looking at, and this is what turns that back into sort_order —
  // which keeps `oldestFirst` private to this file.
  function canonicalFrom(view) {
    return oldestFirst ? view : view.slice().reverse();
  }

  function stopRow(stop, index) {
    // Number belongs to the stop (its rank in the canonical sort_order), not the
    // display slot — so it travels with the card when the view order is flipped.
    // Shown 1-based even though sort_order is 0-based.
    var no = String(stops().indexOf(stop) + 1).padStart(2, "0");
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
    var show = !isAdmin() && stops().length >= 2;
    toggleBtn.hidden = !show;
    if (!show) return;
    toggleBtn.setAttribute("aria-pressed", oldestFirst ? "true" : "false");
    toggleBtn.classList.toggle("is-reversed", oldestFirst);
    var label = oldestFirst ? "Show newest first" : "Show oldest first";
    toggleBtn.title = label;
    toggleBtn.setAttribute("aria-label", label);
  }

  function wireRows() {
    listEl.querySelectorAll(".stop").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        // Opens from memory — the whole trip (incl. every stop's HTML) is loaded
        // in one pass, so there's no per-stop fetch here. The index handed back
        // is into the canonical order, NOT the displayed order: it becomes the
        // URL's stop number and drives Previous/Next, so both stay independent
        // of this page's order toggle.
        var idx = stops().findIndex(function (s) { return s.id === id; });
        if (idx >= 0 && host.onOpen) host.onOpen(idx);
      });
    });
    window.TripAdmin.wireRows(listEl);
  }

  function render() {
    applyStatusDefault();
    if (!stops().length) {
      headingEl.hidden = !isAdmin();
      syncOrderToggle();
      listEl.innerHTML = isAdmin()
        ? '<li class="empty">No stops yet. Use “Add stop” above.</li>'
        : '<li class="empty">First postcard coming soon.</li>';
      return;
    }
    headingEl.hidden = false;
    syncOrderToggle();
    listEl.innerHTML = orderedStops().map(stopRow).join("");
    wireRows();
  }

  // The trip itself couldn't be loaded — no heading, no order toggle, just the
  // reason in place of the cards.
  function renderError(message) {
    headingEl.hidden = true;
    toggleBtn.hidden = true;
    listEl.innerHTML = '<li class="empty empty--error">' + PA.esc(message) + "</li>";
  }

  // Lives outside #stops, so it survives re-renders and only needs wiring once.
  toggleBtn.addEventListener("click", function () {
    oldestFirst = !oldestFirst;
    render();
  });

  window.TripStops = {
    init: function (opts) { host = opts || null; },
    render: render,
    renderError: renderError,
    orderedStops: orderedStops,
    canonicalFrom: canonicalFrom,
  };
})();
