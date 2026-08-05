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
  var reorderSeq = 0;
  // Display order. Default shows the newest (last-added) stop first — a
  // non-persisted, view-only flip of the canonical `stops` array. Entering edit
  // mode keeps whatever order was on screen (it does NOT snap back to canonical),
  // so the admin edits the stops in the order they were just looking at. The
  // per-row reorder maps back to canonical, so it stays correct in either order.
  var oldestFirst = false;

  function orderedStops() {
    return oldestFirst ? stops : stops.slice().reverse();
  }

  var STOP_FIELDS = [
    { name: "title", label: "Name", type: "text", required: true },
    { name: "meta", label: "Subtitle", type: "text" },
    { name: "note", label: "Note (one-line teaser)", type: "text" },
    { name: "html_content", label: "Content", type: "htmleditor", required: true },
  ];

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
  // Both writes below run inside formModal's onSubmit, so the modal holds a
  // spinner until the request lands AND the list has been re-rendered from the
  // response — by the time it closes, the cards (and the `stops` array the popup
  // reads from) are already the saved data. A failure leaves the form open with
  // its input intact and the reason in the modal's error strip.
  async function onAddStop() {
    await PA.formModal({
      title: "Add stop",
      submitLabel: "Create",
      savingLabel: "Creating…",
      fields: STOP_FIELDS,
      values: {},
      onSubmit: async function (vals) {
        // The API returns the full stop (incl. html_content); splice it into
        // local state and re-render — no refetch (fully reactive).
        var created = await PA.adminFetch("/admin/trips/" + trip.id + "/stops", {
          method: "POST", body: JSON.stringify(vals),
        });
        stops.push(created);
        renderStops();
      },
    });
  }

  async function onEditStop(id) {
    // html_content is already in memory (loaded in one pass) — no fetch needed.
    var stop = stops.find(function (s) { return s.id === id; });
    if (!stop) return;
    await PA.formModal({
      title: "Edit stop",
      submitLabel: "Save",
      savingLabel: "Saving…",
      fields: STOP_FIELDS,
      values: {
        title: stop.title,
        meta: stop.meta,
        note: stop.note,
        html_content: stop.html_content,
      },
      onSubmit: async function (vals) {
        var updated = await PA.adminFetch("/admin/stops/" + id, {
          method: "PUT", body: JSON.stringify(vals),
        });
        var idx = stops.findIndex(function (s) { return s.id === id; });
        if (idx >= 0) stops[idx] = updated;
        renderStops();
      },
    });
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
    // The ↑/↓ arrows live on the displayed rows, so `dir` is a move within the
    // displayed order. Swap there, then map back to the canonical `stops` array
    // (reverse when the view is newest-first) before persisting — this keeps the
    // arrows pointing the way the viewer sees regardless of the display order.
    var view = orderedStops();
    var vi = view.findIndex(function (s) { return s.id === id; });
    var vj = vi + dir;
    if (vi < 0 || vj < 0 || vj >= view.length) return;
    var snapshot = stops.slice();
    var newView = view.slice();
    var tmp = newView[vi]; newView[vi] = newView[vj]; newView[vj] = tmp;
    stops = oldestFirst ? newView : newView.slice().reverse();
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
    renderAdminBar();
  }

  // Pencil (in the stops header) → edit-mode toggle.
  PA.wireLoginButton(loginBtn);

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

  // Re-render when admin state flips. wireLoginButton keeps the pencil in
  // sync; the admin bar + stops only re-render once the trip has loaded.
  // The display order (`oldestFirst`) is deliberately NOT reset here, so entering
  // or leaving edit mode preserves the order the stops were just shown in.
  PA.onChange(function () {
    if (!trip) return;
    renderAdminBar();
    renderStops();
  });

  document.addEventListener("DOMContentLoaded", loadTrip);
})();
