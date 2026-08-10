// trip-admin.js — the create / edit / delete / reorder controls for a trip's
// stops. Split out purely so trip.js stays about the public page: everything in
// here only exists in admin mode (?admin + a key), so a reader — human or model
// — working on the trip page never has to load it.
//
// trip.js owns the state; this module owns the admin UI. The seam is a host
// object passed once at startup, the same shape as StopView's — pass data in,
// hand callbacks back, and let the page script stay the only thing that mutates
// `trip` / `stops`:
//
//   TripAdmin.init({
//     bar,                    // the #travel-admin-bar element
//     trip:  fn () -> trip,   // for trip.id on the write paths
//     stops: fn () -> stops,  // the canonical (sort_order) array
//     setStops: fn (next),    // replace the array AND repaint the list
//     setSummary: fn (patch), // same, for the trip's recap fields
//     orderedStops: fn () -> stops in *display* order,
//     canonicalFrom: fn (view) -> that display order mapped back to canonical,
//   })
//   TripAdmin.controls(stop, index)  // → the row's admin buttons, "" when not admin
//   TripAdmin.wireRows(container)    // binds them; no-ops when not admin
//   TripAdmin.renderBar()            // paints (or clears) the admin bar
//
// Two things the contract is deliberately hiding:
//
// `setStops` is assign-and-repaint in one verb, so nothing here calls a renderer
// — every write is "hand trip.js the new array" and the list follows.
//
// The display order (newest-first vs oldest-first) never leaves trip.js. The
// ↑/↓ arrows move a stop within the order the admin is *looking at*, while
// sort_order is canonical, so `canonicalFrom` is how this module asks trip.js to
// translate rather than knowing which way the list is currently flipped.
(function () {
  "use strict";

  var PA = window.PersonAdmin;
  var host = null;
  var reorderSeq = 0;

  var STOP_FIELDS = [
    { name: "title", label: "Name", type: "text", required: true },
    { name: "meta", label: "Subtitle", type: "text" },
    { name: "note", label: "Note (one-line teaser)", type: "text" },
    { name: "html_content", label: "Content", type: "htmleditor", required: true },
  ];

  // The trip's recap: one standalone HTML page about the whole journey.
  //
  // A plain textarea, not the `htmleditor` a stop gets. Two reasons. These
  // documents are generated rather than written — an animated route replay with
  // base64 photos runs to hundreds of KB — so opening every text node as its own
  // WYSIWYG field is slow and buys nothing. And HtmlSpanEditor never returns ""
  // for an empty editor; it returns a skeleton document, which is truthy, so a
  // stray Save would store a blank page and the banner would appear with nothing
  // behind it. A textarea reports blank as null, which clearableSummary turns
  // into the "" that actually clears the column.
  //
  // `importFile` is the Load-file button — that is how a 600KB artifact gets in.
  var SUMMARY_FIELDS = [
    { name: "summary_title", label: "Recap name", type: "text", placeholder: "Trip recap" },
    { name: "summary_caption", label: "Banner subline", type: "text",
      placeholder: "e.g. 2,021 km in six days" },
    { name: "summary_html", label: "Recap page (full HTML document)", type: "textarea",
      rows: 6, importFile: true, placeholder: "<!DOCTYPE html>…  — or use Load file" },
  ];

  function isAdmin() { return PA.isAdmin(); }

  // ── Row controls ──────────────────────────────────────────────────────────
  // Rendered into trip.js's stop card by stopRow(); `index` is the row's slot in
  // the *displayed* order, which is what the ↑/↓ disabled states key off.
  function controls(stop, index) {
    if (!isAdmin() || !host) return "";
    var stops = host.stops();
    return '<div class="pa-card-controls">' +
      '<button class="pa-btn pa-btn--ghost pa-btn--sm pa-move" data-dir="-1" data-id="' +
        PA.escAttr(stop.id) + '" title="Move up"' + (index === 0 ? " disabled" : "") + ">↑</button>" +
      '<button class="pa-btn pa-btn--ghost pa-btn--sm pa-move" data-dir="1" data-id="' +
        PA.escAttr(stop.id) + '" title="Move down"' + (index === stops.length - 1 ? " disabled" : "") + ">↓</button>" +
      '<button class="pa-btn pa-btn--ghost pa-btn--sm pa-edit-stop" data-id="' +
        PA.escAttr(stop.id) + '">Edit</button>' +
      '<button class="pa-btn pa-btn--danger pa-btn--sm pa-del-stop" data-id="' +
        PA.escAttr(stop.id) + '" data-title="' + PA.escAttr(stop.title) + '">Delete</button>' +
    "</div>";
  }

  function wireRows(container) {
    if (!isAdmin() || !host || !container) return;
    container.querySelectorAll(".pa-move").forEach(function (btn) {
      btn.addEventListener("click", function () {
        onMove(btn.getAttribute("data-id"), Number(btn.getAttribute("data-dir")));
      });
    });
    container.querySelectorAll(".pa-edit-stop").forEach(function (btn) {
      btn.addEventListener("click", function () { onEditStop(btn.getAttribute("data-id")); });
    });
    container.querySelectorAll(".pa-del-stop").forEach(function (btn) {
      btn.addEventListener("click", function () {
        onDeleteStop(btn.getAttribute("data-id"), btn.getAttribute("data-title"));
      });
    });
  }

  // ── Admin bar ─────────────────────────────────────────────────────────────
  function renderBar() {
    if (!host) return;
    var bar = host.bar;
    if (!isAdmin() || !host.trip()) { bar.hidden = true; bar.innerHTML = ""; return; }
    bar.hidden = false;
    bar.innerHTML =
      '<span class="pa-tag">Admin</span>' +
      '<button class="pa-btn pa-btn--primary" id="pa-add-stop">+ Add stop</button>' +
      '<button class="pa-btn pa-btn--ghost" id="pa-edit-summary">' +
        (window.TripSummary.has() ? "Edit recap" : "+ Add recap") + "</button>" +
      '<button class="pa-btn pa-btn--ghost" id="pa-signout">Sign out</button>';
    document.getElementById("pa-add-stop").addEventListener("click", onAddStop);
    document.getElementById("pa-edit-summary").addEventListener("click", onEditSummary);
    document.getElementById("pa-signout").addEventListener("click", function () { PA.signOut(); });
  }

  // ── Admin actions ─────────────────────────────────────────────────────────
  // Both writes below run inside formModal's onSubmit, so the modal holds a
  // spinner until the request lands AND the list has been re-rendered from the
  // response — by the time it closes, the cards (and the `stops` array the stop
  // screen reads from) are already the saved data. A failure leaves the form
  // open with its input intact and the reason in the modal's error strip.
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
        var created = await PA.adminFetch("/admin/trips/" + host.trip().id + "/stops", {
          method: "POST", body: JSON.stringify(vals),
        });
        host.setStops(host.stops().concat([created]));
      },
    });
  }

  async function onEditStop(id) {
    // html_content is already in memory (loaded in one pass) — no fetch needed.
    var stop = host.stops().find(function (s) { return s.id === id; });
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
        host.setStops(host.stops().map(function (s) { return s.id === id ? updated : s; }));
      },
    });
  }

  // ── The recap ─────────────────────────────────────────────────────────────
  // formModal sends null for a blanked input and the API skips null fields, so a
  // field normally can't be unset once written. Send "" instead — it isn't null,
  // so the API writes it, and the API stores a blank as NULL, which drops
  // has_summary back to false. Same trick as clearableIcon in about-travel.js.
  function clearableSummary(vals) {
    ["summary_html", "summary_title", "summary_caption"].forEach(function (k) {
      if (vals[k] == null) vals[k] = "";
    });
    return vals;
  }

  // Unlike a stop, the recap document is NOT in the trip payload — it is fetched
  // on demand — so the form has to go and get it before it can show it.
  async function onEditSummary() {
    var trip = host.trip();
    if (!trip) return;
    var current = "";
    if (window.TripSummary.has()) {
      try {
        current = (await window.TripSummary.load()) || "";
      } catch (err) {
        // Opening the form on a recap we couldn't read would offer an empty box
        // over a document that still exists — and Save would destroy it.
        window.alert("Could not load the current recap: " + err.message);
        return;
      }
    }
    await PA.formModal({
      title: window.TripSummary.has() ? "Edit recap" : "Add recap",
      submitLabel: "Save",
      savingLabel: "Saving…",
      fields: SUMMARY_FIELDS,
      values: {
        summary_title: trip.summary_title,
        summary_caption: trip.summary_caption,
        summary_html: current,
      },
      onSubmit: async function (vals) {
        var body = clearableSummary(vals);
        await PA.adminFetch("/admin/trips/" + trip.id, {
          method: "PUT", body: JSON.stringify(body),
        });
        // Patch from what was submitted, not from the echo: the trip-update
        // response is deliberately the small card shape and carries none of
        // these fields (see _TRIP_COLS in trip_routes.py).
        host.setSummary(body);
      },
    });
  }

  async function onDeleteStop(id, title) {
    if (!window.confirm('Delete stop "' + title + '"? This cannot be undone.')) return;
    try {
      await PA.adminFetch("/admin/stops/" + id, { method: "DELETE" });
      host.setStops(host.stops().filter(function (s) { return s.id !== id; }));
    } catch (err) { window.alert("Could not delete stop: " + err.message); }
  }

  // Optimistic reorder: swap locally + repaint, then persist. Reconcile on the
  // echo; roll back to the snapshot on error. Guarded by a monotonic token so an
  // older reorder resolving late can't clobber a newer one.
  async function onMove(id, dir) {
    // The ↑/↓ arrows live on the displayed rows, so `dir` is a move within the
    // displayed order. Swap there, then ask trip.js to map the result back to
    // canonical before persisting — this keeps the arrows pointing the way the
    // viewer sees regardless of the display order.
    var view = host.orderedStops();
    var vi = view.findIndex(function (s) { return s.id === id; });
    var vj = vi + dir;
    if (vi < 0 || vj < 0 || vj >= view.length) return;
    var snapshot = host.stops().slice();
    var newView = view.slice();
    var tmp = newView[vi]; newView[vi] = newView[vj]; newView[vj] = tmp;
    host.setStops(host.canonicalFrom(newView));

    var seq = ++reorderSeq;
    try {
      await PA.adminFetch("/admin/trips/" + host.trip().id + "/stops/reorder", {
        method: "POST",
        body: JSON.stringify({ stop_ids: host.stops().map(function (s) { return s.id; }) }),
      });
      if (seq !== reorderSeq) return; // a newer reorder superseded this one
    } catch (err) {
      if (seq !== reorderSeq) return;
      host.setStops(snapshot);
      window.alert("Could not reorder: " + err.message);
    }
  }

  function init(h) {
    host = h;
    // Subscribe then paint once — the same shape as PA.wireLoginButton. The bar
    // is this module's own business, so trip.js doesn't repaint it on admin
    // state changes; it only calls renderBar() once the trip has loaded, which
    // is the one transition PA.onChange doesn't cover.
    PA.onChange(renderBar);
    renderBar();
  }

  window.TripAdmin = {
    init: init,
    controls: controls,
    wireRows: wireRows,
    renderBar: renderBar,
  };
})();
