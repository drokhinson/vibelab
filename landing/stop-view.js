// stop-view.js — the full-screen stop reader at /travel/:slug/:stop. Renders a
// stop's stored HTML in a sandboxed iframe filling the space between a locked
// header (stop name, download, exit) and a locked footer (Previous, counter,
// Next).
//
// It is a *screen*, not an overlay: no backdrop, no bordered shell, no inset.
// That matters beyond looks — the old popup nested a scrollable shell inside the
// page inside the postcard's own document, so touch scrolling fought between
// three boxes and the shell's border/radius framed the card in a way the
// postcards were never designed for. Here trip.html's `body{overflow:hidden}`
// pins the page, the chrome is `flex:none`, and the iframe is the only flexible
// row — so the postcard's own document is the single scroller on screen.
//
// The trip page loads every stop's html_content in one pass, so this renders
// straight from memory — no per-stop fetch. Call StopView.open(stops, index,
// handlers) with the trip's whole stop list in canonical order.
//
// This module owns no history. Previous/Next/exit call back into trip.js
// (handlers.onNavigate / handlers.onExit), which is the only place that writes
// to the address bar — so the URL and the rendered stop can't drift apart.
//
// The bar's download button saves the current stop's stored html_content
// verbatim — source, not a rendered snapshot — so the saved file keeps the
// postcard's own script and draws its map and flags when opened from disk.
// (trip-export.js does the opposite for the whole-trip export, where the
// stops have to be flattened into one inert document.)
//
// The HTML is admin-authored and runs inside a `sandbox="allow-scripts"` iframe
// with NO `allow-same-origin` (declared in trip.html), so its scripts/styles are
// isolated in an opaque origin and cannot touch this page's DOM, cookies, or
// storage. NEVER add allow-same-origin alongside allow-scripts — that
// combination re-grants same-origin access and defeats the sandbox.
//
// Note on headers: `X-Frame-Options: DENY` governs framing of HTTP responses; a
// `srcdoc` iframe has no HTTP response, so it is not affected. If a
// Content-Security-Policy is ever added to the landing site, it must not block
// the srcdoc frame (frame-src/child-src) and must keep allow-scripts in any
// CSP-level sandbox.
(function () {
  "use strict";

  var root = null, titleEl = null, frame = null, proto = null, dlBtn = null, closeBtn = null;
  var nav = null, counterEl = null, prevBtn = null, nextBtn = null;

  var list = [];
  var current = 0;
  var handlers = {};
  var open = false;
  var keyHandler = null;

  // The markup is static in trip.html, so the iframe (and its sandbox attribute)
  // lives where a reader can see it, and paging Previous/Next swaps only the
  // frame instead of rebuilding the chrome and re-binding its handlers.
  function cache() {
    if (root) return true;
    root = document.getElementById("stop-screen");
    if (!root) return false;
    titleEl = root.querySelector(".stop-screen__title");
    frame = root.querySelector(".stop-screen__frame");
    // A pristine copy of the markup's iframe, taken before anything is ever
    // loaded into it — every stop gets a fresh clone of this. See renderFrame().
    proto = frame.cloneNode(false);
    dlBtn = root.querySelector(".stop-screen__dl");
    closeBtn = root.querySelector(".stop-screen__close");
    nav = root.querySelector(".stop-screen__nav");
    counterEl = root.querySelector(".stop-screen__counter");
    prevBtn = root.querySelector('.stop-screen__nav-btn[data-dir="-1"]');
    nextBtn = root.querySelector('.stop-screen__nav-btn[data-dir="1"]');

    closeBtn.addEventListener("click", exit);
    prevBtn.addEventListener("click", function () { go(-1); });
    nextBtn.addEventListener("click", function () { go(1); });
    // Saves the stop's stored HTML verbatim, so the downloaded file keeps the
    // postcard's own script and renders its map/flags exactly like the screen.
    // Reads `current` at click time, so paging downloads what's shown.
    dlBtn.addEventListener("click", function () {
      var stop = list[current];
      if (!stop || !stop.html_content) return;
      saveBlob(new Blob([stop.html_content], { type: "text/html;charset=utf-8" }),
        fileNameFor(stop.title));
    });
    return true;
  }

  // Same recipe as trip-export.js's filename stem, plus whitespace collapsing.
  function fileNameFor(title) {
    var stem = String(title == null ? "" : title)
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    return (stem || "postcard") + ".html";
  }

  // Kept local rather than reaching into TripExport: stop-view.js loads before
  // the export modules, and TripExport only exposes its whole-trip download.
  function saveBlob(blob, filename) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  // Swaps in a brand-new iframe rather than reassigning srcdoc on the one that's
  // already there. Not a style choice: navigating a *loaded* child frame pushes
  // an entry onto the joint session history, so paging Previous/Next would bury
  // the trip list one bogus entry deeper per postcard and the browser Back
  // button would step through stale iframe documents instead of closing the
  // stop. A newly created frame's first load replaces its own initial entry, so
  // this leaves the history exactly as trip.js wrote it.
  //
  // srcdoc is set on the DOM property before insertion — as a property so we
  // don't attribute-escape a large document, and before insertion so the load is
  // that initial (replacing) navigation. The clone carries the markup's
  // sandbox="allow-scripts" with it; see the header note on why
  // allow-same-origin must never join it.
  function renderFrame(html, title) {
    var next = proto.cloneNode(false);
    next.setAttribute("title", title);
    next.srcdoc = html || "";
    frame.replaceWith(next);
    frame = next;
  }

  // Asks trip.js to move — it rewrites the URL and calls back into show(), so
  // the address bar is never a step behind the postcard on screen.
  function go(delta) {
    var next = current + delta;
    if (!open || next < 0 || next >= list.length) return;
    if (handlers.onNavigate) handlers.onNavigate(next);
  }

  function exit() {
    if (open && handlers.onExit) handlers.onExit();
  }

  // show(stops, index, opts): stops is the trip's stop array (each with title +
  // html_content) in canonical order; index is the one to render. Because the
  // list is canonical, Next always moves to the next-higher stop number and
  // Previous to the next-lower — the trip page's display order (which can be
  // reversed) does not affect it. The counter is 1-based, so it reads as the
  // card's badge and as the URL's stop number (e.g. "7 / 9").
  function show(stops, index, opts) {
    if (!cache()) return;
    list = Array.isArray(stops) ? stops : [];
    if (!list.length) return;
    handlers = opts || {};
    current = Math.min(Math.max(index | 0, 0), list.length - 1);

    var stop = list[current];
    var title = (stop && stop.title) || "Postcard";
    titleEl.textContent = title;
    renderFrame(stop && stop.html_content, title);
    dlBtn.disabled = !(stop && stop.html_content);

    var multi = list.length > 1;
    nav.hidden = !multi;
    if (multi) {
      counterEl.textContent = (current + 1) + " / " + list.length;
      prevBtn.disabled = current === 0;
      nextBtn.disabled = current === list.length - 1;
    }

    if (open) return;
    open = true;
    root.hidden = false;
    keyHandler = function (ev) {
      if (ev.key === "Escape") { exit(); return; }
      if (list.length < 2) return;
      if (ev.key === "ArrowLeft") go(-1);
      else if (ev.key === "ArrowRight") go(1);
    };
    document.addEventListener("keydown", keyHandler);
  }

  function close() {
    if (!root || !open) return;
    open = false;
    root.hidden = true;
    // Drop the document so the postcard's scripts, timers and map tiles stop
    // when the reader is back on the trip list — again by swapping the frame,
    // for the history reason in renderFrame().
    renderFrame("", "Postcard");
    if (keyHandler) {
      document.removeEventListener("keydown", keyHandler);
      keyHandler = null;
    }
  }

  window.StopView = { show: show, close: close, isOpen: function () { return open; } };
})();
