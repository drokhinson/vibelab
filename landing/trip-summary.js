// trip-summary.js — the trip page's whole-trip recap: the banner above the stop
// list, and the document behind it.
//
// A recap is one hand-authored standalone HTML page about the journey rather
// than a single place — an animated route replay, a stats page, a gallery. It is
// the same KIND of thing as a postcard, so it opens in the same full-screen
// reader (StopView) at /travel/:slug/summary, just with no Previous/Next.
//
// Unlike the stops, the document is NOT in the trip payload. These run to
// hundreds of kilobytes — inline scripts, inline CSS, base64 photos — and most
// readers never open one, so /trips/:slug carries only `has_summary` plus the
// two labels, and the document itself is fetched once, on demand, the first time
// someone opens it.
//
// That fetch is the reason for doc(): NOTHING outside this file reads
// trip.summary_html. If the payload ever goes back to carrying the document
// inline, load() is the only function that changes.
//
//   TripSummary.init({ trip: fn () -> trip, slug: fn () -> slug, onOpen: fn })
//   TripSummary.render()       // paint or hide the banner
//   TripSummary.has()          // does this trip have a recap?
//   TripSummary.load()         // -> Promise<html>; memoized, and caches offline
//   TripSummary.doc()          // the loaded html, or null
//   TripSummary.title()        // the recap's name, defaulted
//   TripSummary.show(onExit)   // hand the document to StopView
(function () {
  "use strict";

  var PA = window.PersonAdmin;
  var bannerEl = document.getElementById("trip-summary");
  var titleEl = document.getElementById("trip-summary-title");
  var metaEl = document.getElementById("trip-summary-meta");

  var DEFAULT_TITLE = "Trip recap";

  var host = null;
  // The fetched document, and the request in flight. Both are keyed to the slug
  // they were fetched for, so they can't survive into a different trip (the page
  // never navigates between trips today, but a memo that outlives its subject is
  // the kind of thing that only breaks later).
  var docHtml = null;
  var docSlug = null;
  var pending = null;

  function trip() { return (host && host.trip()) || null; }
  function slug() { return (host && host.slug()) || ""; }

  function has() {
    var t = trip();
    return !!(t && t.has_summary);
  }

  function title() {
    var t = trip();
    return (t && t.summary_title) || DEFAULT_TITLE;
  }

  function doc() {
    return docSlug === slug() ? docHtml : null;
  }

  // Called by trip-admin.js after a save, so the next open serves the document
  // that was just written instead of re-fetching it (or worse, serving the old
  // one from the memo).
  function setDoc(html) {
    docSlug = slug();
    docHtml = html || null;
    pending = null;
  }

  // ── The document ──────────────────────────────────────────────────────────
  // Resolves to the recap's HTML. Memoized, so opening the reader twice costs
  // one fetch; concurrent callers share the one request.
  //
  // A trip saved for offline reading already has the document on the payload
  // (see the write below), so this resolves from memory with no network at all —
  // which is the whole point of stamping it back onto `trip`.
  function load() {
    var s = slug();
    if (!s || !has()) return Promise.resolve(null);
    if (docSlug === s && docHtml) return Promise.resolve(docHtml);

    var t = trip();
    if (t && t.summary_html) { setDoc(t.summary_html); return Promise.resolve(docHtml); }

    if (pending) return pending;
    pending = PA.publicFetch("/trips/" + encodeURIComponent(s) + "/summary")
      .then(function (data) {
        pending = null;
        setDoc(data && data.html);
        // Stamp it onto the trip so TripCache stores it with everything else,
        // and so trip.js can carry it across a background refresh. Fire and
        // forget: the write is a no-op unless this trip is saved offline, and a
        // background write that fails stays silent — only the switch reports.
        var current = trip();
        if (current && docHtml) {
          current.summary_html = docHtml;
          window.TripCache.write(s, current).catch(function () {});
        }
        return docHtml;
      })
      .catch(function (err) {
        pending = null;
        throw err;
      });
    return pending;
  }

  // ── The banner ────────────────────────────────────────────────────────────
  function render() {
    if (!bannerEl) return;
    if (!has()) {
      bannerEl.hidden = true;
      bannerEl.classList.remove("is-loading");
      return;
    }
    var t = trip();
    bannerEl.hidden = false;
    titleEl.textContent = title();
    metaEl.textContent = t.summary_caption || "The whole trip, start to finish";
    bannerEl.setAttribute("aria-label", "Open " + title());
  }

  function setLoading(on) {
    if (!bannerEl) return;
    bannerEl.classList.toggle("is-loading", !!on);
    if (on) bannerEl.setAttribute("aria-busy", "true");
    else bannerEl.removeAttribute("aria-busy");
  }

  // ── The reader ────────────────────────────────────────────────────────────
  // A one-element list: StopView hides its whole Previous/Next/counter row and
  // ignores the arrow keys below two, so nothing here has to suppress them. Its
  // download button saves html_content verbatim, which for a recap is the live,
  // animated file — see the note in stop-view.js.
  function show(onExit) {
    var html = doc();
    if (!html) return false;
    window.StopView.show([{ title: title(), html_content: html }], 0, {
      onExit: onExit,
      label: "Recap",
    });
    return true;
  }

  if (bannerEl) {
    bannerEl.addEventListener("click", function () {
      if (host && host.onOpen) host.onOpen();
    });
  }

  window.TripSummary = {
    init: function (opts) { host = opts || null; },
    render: render,
    has: has,
    load: load,
    doc: doc,
    setDoc: setDoc,
    title: title,
    show: show,
    setLoading: setLoading,
  };
})();
