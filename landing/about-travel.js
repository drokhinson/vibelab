// about-travel.js — dynamic Travel section on the person page (about.html).
// Fetches trips from the person API and renders them as cards. In admin mode
// (enter via ?admin), adds create / edit / delete controls.
(function () {
  "use strict";

  var PA = window.PersonAdmin;
  var grid = document.getElementById("travel-grid");
  var adminBar = document.getElementById("travel-admin-bar");
  var loginBtn = document.getElementById("admin-login-btn");
  var travelEditBtn = document.getElementById("travel-edit-btn");
  var trips = [];
  var dynamicActive = false;

  // Fallback card art — the arrow mark the section shipped with. Used whenever a
  // trip has no icon_url set.
  var ARROW_SVG =
    '<svg viewBox="0 0 64 64" width="52" height="52" fill="none" stroke="currentColor" ' +
    'stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M8 52 L40 20" /><path d="M28 16 L44 16 L44 32" />' +
    '<circle cx="12" cy="48" r="6" /><circle cx="52" cy="24" r="6" /></svg>';

  // Where a trip is in its life. Mirrors the CHECK constraint on
  // person_trips.status and TripStatus in the backend's constants.py. The order
  // here is the order the card's cycle button walks: a trip is announced, then
  // lived, then over.
  var STATUSES = [
    { value: "upcoming", label: "Upcoming" },
    { value: "live", label: "Live" },
    { value: "complete", label: "Complete" },
  ];
  var DEFAULT_STATUS = "upcoming";

  function statusOf(t) {
    // A trip served by a backend that predates the column has no status; treat
    // it as the plain card rather than greying it out.
    for (var i = 0; i < STATUSES.length; i++) {
      if (STATUSES[i].value === t.status) return t.status;
    }
    return "complete";
  }

  function statusLabel(value) {
    for (var i = 0; i < STATUSES.length; i++) {
      if (STATUSES[i].value === value) return STATUSES[i].label;
    }
    return value;
  }

  function nextStatus(value) {
    for (var i = 0; i < STATUSES.length; i++) {
      if (STATUSES[i].value === value) return STATUSES[(i + 1) % STATUSES.length].value;
    }
    return DEFAULT_STATUS;
  }

  var TRIP_FIELDS = [
    { name: "title", label: "Title", type: "text", required: true },
    { name: "eyebrow", label: "Eyebrow (hero kicker)", type: "text" },
    { name: "headline", label: "Headline (hero H1)", type: "text" },
    { name: "lede", label: "Lede (hero paragraph)", type: "textarea", rows: 3 },
    { name: "photo_album_url", label: "Photo album URL", type: "url" },
    // Deliberately "text", not "url": formModal's <form> has no novalidate, so a
    // url input's native validation would silently refuse to submit a repo-relative
    // path like assets/sprites/trips/… — which is how committed card art is set.
    { name: "icon_url", label: "Card icon (image URL or assets path)", type: "text",
      placeholder: "assets/sprites/trips/… or https://… — blank for the arrow" },
    { name: "card_cta", label: "Card CTA text", type: "text", placeholder: "Follow the route ↗" },
    { name: "sort_order", label: "Sort order", type: "number" },
    { name: "status", label: "Status", type: "select", options: STATUSES },
    { name: "is_published", label: "Published", type: "checkbox" },
  ];

  function isAdmin() { return PA.isAdmin(); }

  // ── Rendering ───────────────────────────────────────────────────────────
  function tripCard(t) {
    var admin = isAdmin();
    var status = statusOf(t);
    var upcoming = status === "upcoming";
    var cta = t.card_cta || "Follow the route ↗";
    var adminControls = admin
      ? '<div class="pa-card-controls">' +
          // Cycles upcoming → live → complete and saves immediately, so the
          // common edit (a trip just started, a trip just ended) is one click
          // rather than a trip through the modal.
          '<button class="pa-btn pa-btn--ghost pa-status-trip" data-id="' + PA.escAttr(t.id) +
          '" title="Status: ' + PA.escAttr(statusLabel(status)) + ' — click for ' +
          PA.escAttr(statusLabel(nextStatus(status))) + '">' + PA.esc(statusLabel(status)) +
          "</button>" +
          '<button class="pa-btn pa-btn--ghost pa-edit-trip" data-id="' + PA.escAttr(t.id) +
          '" title="Edit trip">Edit</button>' +
          '<button class="pa-btn pa-btn--danger pa-del-trip" data-id="' + PA.escAttr(t.id) +
          '" data-title="' + PA.escAttr(t.title) + '" title="Delete trip">Delete</button>' +
        "</div>"
      : "";
    var draftBadge = (admin && !t.is_published)
      ? '<span class="pa-badge">Draft</span>' : "";
    // A trip that is happening right now says so, in the corner of its card.
    var liveBubble = status === "live"
      ? '<span class="travel-card__live"><span class="travel-card__live-dot" aria-hidden="true">' +
        "</span>Live</span>"
      : "";
    // An upcoming trip has nothing to read yet, so the card is a teaser: greyed
    // out, with the word across it. `aria-hidden` on the band because the same
    // word is already in the card's own label below.
    var upcomingBand = upcoming
      ? '<span class="travel-card__upcoming" aria-hidden="true">Upcoming</span>' : "";
    // A dead or hotlink-blocked icon removes itself, leaving the plain art panel
    // rather than a broken-image glyph; no-referrer dodges referer hotlink checks.
    var art = t.icon_url
      ? '<img class="travel-card__art-img" src="' + PA.escAttr(t.icon_url) + '" alt="" ' +
        'loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />'
      : ARROW_SVG;
    var inner =
      '<div class="travel-card__art' + (t.icon_url ? " travel-card__art--img" : "") +
        '" aria-hidden="true">' + art + "</div>" +
      '<div class="travel-card__body">' +
        '<h3 class="travel-card__title">' + PA.esc(t.title) + draftBadge + "</h3>" +
        '<span class="travel-card__cta">' +
          PA.esc(upcoming ? "Upcoming — not yet underway" : cta) + "</span>" +
      "</div>" +
      liveBubble + upcomingBand;
    // An upcoming trip is a <div>, not an <a>: there is nothing to open yet, and
    // dropping the element rather than suppressing its clicks is what actually
    // takes it out of the tab order and off the screen reader's link list. The
    // admin controls sit outside the card, so it stays fully editable.
    var card = upcoming
      ? '<div class="travel-card travel-card--upcoming">' + inner + "</div>"
      : '<a class="travel-card' + (status === "live" ? " travel-card--live" : "") +
        '" href="/travel/' + PA.escAttr(t.slug) + '">' + inner + "</a>";
    return '<div class="travel-card-wrap">' + card + adminControls + "</div>";
  }

  function renderGrid() {
    grid.innerHTML = trips.map(tripCard).join("");
    if (isAdmin()) wireCardControls();
  }

  function renderAdminBar() {
    if (!isAdmin()) { adminBar.hidden = true; adminBar.innerHTML = ""; return; }
    adminBar.hidden = false;
    // Add trip now lives on the inline header pencil; the bar keeps Sign out so
    // it stays reachable once login moved to the footer pill.
    adminBar.innerHTML =
      '<span class="pa-tag">Admin</span>' +
      '<button class="pa-btn pa-btn--ghost" id="pa-signout">Sign out</button>';
    document.getElementById("pa-signout").addEventListener("click", function () { PA.signOut(); });
  }

  function wireCardControls() {
    grid.querySelectorAll(".pa-edit-trip").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        onEditTrip(btn.getAttribute("data-id"));
      });
    });
    grid.querySelectorAll(".pa-del-trip").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        onDeleteTrip(btn.getAttribute("data-id"), btn.getAttribute("data-title"));
      });
    });
    grid.querySelectorAll(".pa-status-trip").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        onCycleStatus(btn.getAttribute("data-id"));
      });
    });
  }

  // ── Admin actions ─────────────────────────────────────────────────────────
  // formModal sends null for a blanked input and the API skips null fields, so a
  // field normally can't be unset once written. Send "" for icon_url instead —
  // it's not null, so the API writes it, and "" is falsy on render (back to the
  // arrow). Scoped to this field on purpose; the general behaviour is unchanged.
  function clearableIcon(vals) {
    if (vals.icon_url == null) vals.icon_url = "";
    return vals;
  }

  async function onAddTrip() {
    var vals = await PA.formModal({
      title: "Add trip",
      submitLabel: "Create",
      fields: TRIP_FIELDS,
      values: { is_published: true, status: DEFAULT_STATUS },
    });
    if (!vals) return;
    try {
      await PA.adminFetch("/admin/trips", {
        method: "POST", body: JSON.stringify(clearableIcon(vals)),
      });
      await loadTrips();
    } catch (err) { window.alert("Could not create trip: " + err.message); }
  }

  async function onEditTrip(id) {
    var trip = trips.find(function (t) { return t.id === id; });
    if (!trip) return;
    var vals = await PA.formModal({
      title: "Edit trip",
      submitLabel: "Save",
      fields: TRIP_FIELDS,
      values: trip,
    });
    if (!vals) return;
    try {
      await PA.adminFetch("/admin/trips/" + id, {
        method: "PUT", body: JSON.stringify(clearableIcon(vals)),
      });
      await loadTrips();
    } catch (err) { window.alert("Could not save trip: " + err.message); }
  }

  // Repaints first and persists after — the whole point of the cycle button is
  // that a status change is instant, and waiting on the round-trip would make
  // three clicks through the cycle feel like three page loads. A failed save
  // puts the old status back and says why, the same shape as the stop reorder
  // in trip-admin.js.
  async function onCycleStatus(id) {
    var trip = trips.find(function (t) { return t.id === id; });
    if (!trip) return;
    var previous = trip.status;
    trip.status = nextStatus(statusOf(trip));
    renderGrid();
    try {
      await PA.adminFetch("/admin/trips/" + id, {
        method: "PUT", body: JSON.stringify({ status: trip.status }),
      });
    } catch (err) {
      trip.status = previous;
      renderGrid();
      window.alert("Could not change the status: " + err.message);
    }
  }

  async function onDeleteTrip(id, title) {
    if (!window.confirm('Delete "' + title + '" and all its stops? This cannot be undone.')) return;
    try {
      await PA.adminFetch("/admin/trips/" + id, { method: "DELETE" });
      await loadTrips();
    } catch (err) { window.alert("Could not delete trip: " + err.message); }
  }

  // ── Load ────────────────────────────────────────────────────────────────
  async function loadTrips() {
    var fetched;
    try {
      fetched = await PA.publicFetch("/trips");
    } catch (err) {
      // Backend unreachable — leave the grid empty, no error banner. The
      // section stays dormant until the backend is reachable again.
      console.warn("Travel: trips unavailable.", err);
      return;
    }
    dynamicActive = true;
    trips = fetched || [];
    renderGrid();
    renderAdminBar();
  }

  // ── About-page admin controls ─────────────────────────────────────────────
  // The shared PA.wireLoginButton (header pencil + chip) is left for trip.html.
  // Here the footer pill is the login/edit toggle and an inline pencil beside
  // the Travel heading opens Add-trip — both driven directly off PA state.

  // Footer pill: click toggles edit mode; label + accent reflect the state.
  function renderLoginPill() {
    if (!loginBtn) return;
    var editing = PA.isAdmin();
    var loggedIn = PA.hasKey();
    loginBtn.textContent = !loggedIn ? "Admin" : (editing ? "Editing" : "Logged in");
    var label = !loggedIn ? "Admin login"
      : editing ? "Editing — click to stop editing"
      : "Logged in — click to edit";
    loginBtn.title = label;
    loginBtn.setAttribute("aria-label", label);
    loginBtn.classList.toggle("admin-pill--editing", editing);
  }
  if (loginBtn) loginBtn.addEventListener("click", function () { PA.toggleEdit(); });

  // Inline Travel pencil: visible only in edit mode; opens the Add-trip modal.
  function renderTravelEditBtn() {
    if (travelEditBtn) travelEditBtn.hidden = !isAdmin();
  }
  if (travelEditBtn) travelEditBtn.addEventListener("click", onAddTrip);

  // Re-render when admin state flips. The pill + pencil update on every change;
  // the grid/bar only re-render once dynamic mode is active, so we don't paint
  // an empty grid before the backend has responded.
  PA.onChange(function () {
    renderLoginPill();
    renderTravelEditBtn();
    if (!dynamicActive) return;
    renderAdminBar();
    renderGrid();
  });

  // Initial paint (before any state change / backend response).
  renderLoginPill();
  renderTravelEditBtn();

  document.addEventListener("DOMContentLoaded", loadTrips);
})();
