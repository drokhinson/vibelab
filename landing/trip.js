// trip.js — renders a single trip page at /travel/:slug. Reads the slug from the
// path, fetches the trip + its stops, paints the hero + stop cards. Tapping a
// stop opens its stored HTML in the sandboxed StopPopup. In admin mode (?admin),
// adds create / edit / delete / reorder controls for stops.
(function () {
  "use strict";

  var PA = window.PersonAdmin;
  var eyebrowEl = document.getElementById("trip-eyebrow");
  var headlineEl = document.getElementById("trip-headline");
  var albumEl = document.getElementById("trip-album");
  var adminBar = document.getElementById("travel-admin-bar");
  var stopsHeaderEl = document.getElementById("stops-header");
  var orderToggleBtn = document.getElementById("stops-order-toggle");
  var stopsEl = document.getElementById("stops");
  var loginBtn = document.getElementById("admin-login-btn");

  var trip = null;
  var stops = [];
  var reorderSeq = 0;
  // Public display order. Default shows the newest (last-added) stop first — a
  // non-persisted, view-only flip of the canonical `stops` array. Admins always
  // see the curated sort_order (ascending) so the per-row reorder stays intact,
  // so this only affects non-admin viewers.
  var oldestFirst = false;

  function orderedStops() {
    if (isAdmin()) return stops;                       // curated order for editing
    return oldestFirst ? stops : stops.slice().reverse();
  }

  var STOP_FIELDS = [
    { name: "title", label: "Name", type: "text", required: true },
    { name: "meta", label: "Subtitle", type: "text" },
    { name: "note", label: "Note (one-line teaser)", type: "text" },
    { name: "html_content", label: "Content", type: "htmleditor", required: true },
  ];

  function isAdmin() { return PA.isAdmin(); }

  function slugFromPath() {
    var parts = window.location.pathname.split("/").filter(Boolean);
    return parts.length ? decodeURIComponent(parts[parts.length - 1]) : "";
  }

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
    var no = String(index).padStart(2, "0");
    var noteHtml = stop.note ? '<p class="stop__note">' + PA.esc(stop.note) + "</p>" : "";
    var admin = isAdmin();
    var controls = admin
      ? '<div class="pa-card-controls">' +
          '<button class="pa-btn pa-btn--ghost pa-btn--sm pa-move" data-dir="-1" data-id="' +
            PA.escAttr(stop.id) + '" title="Move up"' + (index === 0 ? " disabled" : "") + ">↑</button>" +
          '<button class="pa-btn pa-btn--ghost pa-btn--sm pa-move" data-dir="1" data-id="' +
            PA.escAttr(stop.id) + '" title="Move down"' + (index === stops.length - 1 ? " disabled" : "") + ">↓</button>" +
          '<button class="pa-btn pa-btn--ghost pa-btn--sm pa-edit-stop" data-id="' +
            PA.escAttr(stop.id) + '">Edit</button>' +
          '<button class="pa-btn pa-btn--danger pa-btn--sm pa-del-stop" data-id="' +
            PA.escAttr(stop.id) + '" data-title="' + PA.escAttr(stop.title) + '">Delete</button>' +
        "</div>"
      : "";
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
    if (!stops.length) {
      stopsHeaderEl.hidden = !isAdmin();
      syncOrderToggle();
      stopsEl.innerHTML = isAdmin()
        ? '<li class="empty">No stops yet. Use “Add stop” above.</li>'
        : '<li class="empty">First postcard coming soon.</li>';
      return;
    }
    stopsHeaderEl.hidden = false;
    syncOrderToggle();
    stopsEl.innerHTML = orderedStops().map(stopRow).join("");
    wireStops();
  }

  function wireStops() {
    stopsEl.querySelectorAll(".stop").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        // Opens from memory — the whole trip (incl. every stop's HTML) is loaded
        // in one pass, so there's no per-stop fetch here. Pass the displayed
        // order so the popup pages Prev/Next in the order the viewer sees.
        var view = orderedStops();
        var idx = view.findIndex(function (s) { return s.id === id; });
        if (idx >= 0) window.StopPopup.show(view, idx);
      });
    });
    if (!isAdmin()) return;
    stopsEl.querySelectorAll(".pa-move").forEach(function (btn) {
      btn.addEventListener("click", function () {
        onMove(btn.getAttribute("data-id"), Number(btn.getAttribute("data-dir")));
      });
    });
    stopsEl.querySelectorAll(".pa-edit-stop").forEach(function (btn) {
      btn.addEventListener("click", function () { onEditStop(btn.getAttribute("data-id")); });
    });
    stopsEl.querySelectorAll(".pa-del-stop").forEach(function (btn) {
      btn.addEventListener("click", function () {
        onDeleteStop(btn.getAttribute("data-id"), btn.getAttribute("data-title"));
      });
    });
  }

  // ── Admin bar ─────────────────────────────────────────────────────────────
  function renderAdminBar() {
    if (!isAdmin() || !trip) { adminBar.hidden = true; adminBar.innerHTML = ""; return; }
    adminBar.hidden = false;
    adminBar.innerHTML =
      '<span class="pa-tag">Admin</span>' +
      '<button class="pa-btn pa-btn--primary" id="pa-add-stop">+ Add stop</button>' +
      '<button class="pa-btn pa-btn--ghost" id="pa-signout">Sign out</button>';
    document.getElementById("pa-add-stop").addEventListener("click", onAddStop);
    document.getElementById("pa-signout").addEventListener("click", function () { PA.signOut(); });
  }

  // ── Admin actions ─────────────────────────────────────────────────────────
  async function onAddStop() {
    var vals = await PA.formModal({
      title: "Add stop",
      submitLabel: "Create",
      fields: STOP_FIELDS,
      values: {},
    });
    if (!vals) return;
    try {
      // The API returns the full stop (incl. html_content); splice it into local
      // state and re-render — no refetch (fully reactive).
      var created = await PA.adminFetch("/admin/trips/" + trip.id + "/stops", {
        method: "POST", body: JSON.stringify(vals),
      });
      stops.push(created);
      renderStops();
    } catch (err) { window.alert("Could not add stop: " + err.message); }
  }

  async function onEditStop(id) {
    // html_content is already in memory (loaded in one pass) — no fetch needed.
    var stop = stops.find(function (s) { return s.id === id; });
    if (!stop) return;
    var vals = await PA.formModal({
      title: "Edit stop",
      submitLabel: "Save",
      fields: STOP_FIELDS,
      values: {
        title: stop.title,
        meta: stop.meta,
        note: stop.note,
        html_content: stop.html_content,
      },
    });
    if (!vals) return;
    try {
      var updated = await PA.adminFetch("/admin/stops/" + id, {
        method: "PUT", body: JSON.stringify(vals),
      });
      var idx = stops.findIndex(function (s) { return s.id === id; });
      if (idx >= 0) stops[idx] = updated;
      renderStops();
    } catch (err) { window.alert("Could not save stop: " + err.message); }
  }

  async function onDeleteStop(id, title) {
    if (!window.confirm('Delete stop "' + title + '"? This cannot be undone.')) return;
    try {
      await PA.adminFetch("/admin/stops/" + id, { method: "DELETE" });
      stops = stops.filter(function (s) { return s.id !== id; });
      renderStops();
    } catch (err) { window.alert("Could not delete stop: " + err.message); }
  }

  // Optimistic reorder: swap locally + repaint, then persist. Reconcile on the
  // echo; roll back by reloading on error. Guarded by a monotonic token so an
  // older reorder resolving late can't clobber a newer one.
  async function onMove(id, dir) {
    var i = stops.findIndex(function (s) { return s.id === id; });
    var j = i + dir;
    if (i < 0 || j < 0 || j >= stops.length) return;
    var snapshot = stops.slice();
    var tmp = stops[i]; stops[i] = stops[j]; stops[j] = tmp;
    renderStops();

    var seq = ++reorderSeq;
    try {
      await PA.adminFetch("/admin/trips/" + trip.id + "/stops/reorder", {
        method: "POST",
        body: JSON.stringify({ stop_ids: stops.map(function (s) { return s.id; }) }),
      });
      if (seq !== reorderSeq) return; // a newer reorder superseded this one
    } catch (err) {
      if (seq !== reorderSeq) return;
      stops = snapshot;
      renderStops();
      window.alert("Could not reorder: " + err.message);
    }
  }

  // ── Load ────────────────────────────────────────────────────────────────
  async function loadTrip() {
    var slug = slugFromPath();
    if (!slug) {
      headlineEl.textContent = "Trip not found";
      return;
    }
    try {
      trip = await PA.publicFetch("/trips/" + encodeURIComponent(slug));
      stops = trip.stops || [];
      renderHero();
      renderStops();
    } catch (err) {
      trip = null;
      headlineEl.textContent = "Trip not found";
      eyebrowEl.style.display = "none";
      albumEl.hidden = true;
      stopsHeaderEl.hidden = true;
      stopsEl.innerHTML = '<li class="empty empty--error">' + PA.esc(err.message) + "</li>";
    }
    renderAdminBar();
  }

  // Header pencil → edit-mode toggle + "Logged in / Editing" chip (shared).
  PA.wireLoginButton(loginBtn);

  // Public reverse-order toggle. Lives outside #stops so it survives re-renders
  // and only needs wiring once.
  orderToggleBtn.addEventListener("click", function () {
    oldestFirst = !oldestFirst;
    renderStops();
  });

  // Re-render when admin state flips. wireLoginButton keeps the pencil + chip
  // in sync; the admin bar + stops only re-render once the trip has loaded.
  // Reset to the default (newest-first) view when admin state flips, so leaving
  // admin returns the public viewer to the default order.
  PA.onChange(function () {
    if (!trip) return;
    oldestFirst = false;
    renderAdminBar();
    renderStops();
  });

  document.addEventListener("DOMContentLoaded", loadTrip);
})();
