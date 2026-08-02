// about-travel.js — dynamic Travel section on the person page (about.html).
// Fetches trips from the person API and renders them as cards. In admin mode
// (enter via ?admin), adds create / edit / delete controls.
(function () {
  "use strict";

  var PA = window.PersonAdmin;
  var grid = document.getElementById("travel-grid");
  var adminBar = document.getElementById("travel-admin-bar");
  var loginBtn = document.getElementById("admin-login-btn");
  var trips = [];
  var dynamicActive = false;

  // Default card art — the same arrow mark the section shipped with.
  var ARROW_SVG =
    '<svg viewBox="0 0 64 64" width="52" height="52" fill="none" stroke="currentColor" ' +
    'stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M8 52 L40 20" /><path d="M28 16 L44 16 L44 32" />' +
    '<circle cx="12" cy="48" r="6" /><circle cx="52" cy="24" r="6" /></svg>';

  var TRIP_FIELDS = [
    { name: "title", label: "Title", type: "text", required: true },
    { name: "eyebrow", label: "Eyebrow (hero kicker)", type: "text" },
    { name: "headline", label: "Headline (hero H1)", type: "text" },
    { name: "lede", label: "Lede (hero paragraph)", type: "textarea", rows: 3 },
    { name: "photo_album_url", label: "Photo album URL", type: "url" },
    { name: "card_cta", label: "Card CTA text", type: "text", placeholder: "Follow the route ↗" },
    { name: "sort_order", label: "Sort order", type: "number" },
    { name: "is_published", label: "Published", type: "checkbox" },
  ];

  function isAdmin() { return PA.isAdmin(); }

  // ── Rendering ───────────────────────────────────────────────────────────
  function tripCard(t) {
    var admin = isAdmin();
    var cta = t.card_cta || "Follow the route ↗";
    var adminControls = admin
      ? '<div class="pa-card-controls">' +
          '<button class="pa-btn pa-btn--ghost pa-edit-trip" data-id="' + PA.escAttr(t.id) +
          '" title="Edit trip">Edit</button>' +
          '<button class="pa-btn pa-btn--danger pa-del-trip" data-id="' + PA.escAttr(t.id) +
          '" data-title="' + PA.escAttr(t.title) + '" title="Delete trip">Delete</button>' +
        "</div>"
      : "";
    var draftBadge = (admin && !t.is_published)
      ? '<span class="pa-badge">Draft</span>' : "";
    return '' +
      '<div class="travel-card-wrap">' +
        '<a class="travel-card" href="/travel/' + PA.escAttr(t.slug) + '">' +
          '<div class="travel-card__art" aria-hidden="true">' + ARROW_SVG + "</div>" +
          '<div class="travel-card__body">' +
            '<h3 class="travel-card__title">' + PA.esc(t.title) + draftBadge + "</h3>" +
            '<span class="travel-card__cta">' + PA.esc(cta) + "</span>" +
          "</div>" +
        "</a>" +
        adminControls +
      "</div>";
  }

  function renderGrid() {
    grid.innerHTML = trips.map(tripCard).join("");
    if (isAdmin()) wireCardControls();
  }

  function renderAdminBar() {
    if (!isAdmin()) { adminBar.hidden = true; adminBar.innerHTML = ""; return; }
    adminBar.hidden = false;
    adminBar.innerHTML =
      '<span class="pa-tag">Admin</span>' +
      '<button class="pa-btn pa-btn--primary" id="pa-add-trip">+ Add trip</button>' +
      '<button class="pa-btn pa-btn--ghost" id="pa-signout">Sign out</button>';
    document.getElementById("pa-add-trip").addEventListener("click", onAddTrip);
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
  }

  // ── Admin actions ─────────────────────────────────────────────────────────
  async function onAddTrip() {
    var vals = await PA.formModal({
      title: "Add trip",
      submitLabel: "Create",
      fields: TRIP_FIELDS,
      values: { is_published: true },
    });
    if (!vals) return;
    try {
      await PA.adminFetch("/admin/trips", { method: "POST", body: JSON.stringify(vals) });
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
      await PA.adminFetch("/admin/trips/" + id, { method: "PUT", body: JSON.stringify(vals) });
      await loadTrips();
    } catch (err) { window.alert("Could not save trip: " + err.message); }
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

  // Header pencil → edit-mode toggle + "Logged in / Editing" chip (shared).
  PA.wireLoginButton(loginBtn);

  // Re-render when admin state flips. wireLoginButton keeps the pencil + chip
  // in sync; the grid only re-renders once dynamic mode is active, so we don't
  // paint an empty grid before the backend has responded.
  PA.onChange(function () {
    if (!dynamicActive) return;
    renderAdminBar();
    renderGrid();
  });

  document.addEventListener("DOMContentLoaded", loadTrips);
})();
