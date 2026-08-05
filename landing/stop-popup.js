// stop-popup.js — singleton popup that renders a stop's stored HTML page in a
// sandboxed iframe. Used on the trip page: tapping a stop card opens it here.
//
// The trip page loads every stop's html_content in one pass, so the popup renders
// straight from memory — no per-stop fetch. Call StopPopup.show(stops, index) with
// the trip's whole stop list in canonical order; a bottom nav bar pages
// Previous/Next in place so you can read through the route without closing the
// popup between stops.
//
// The bar's download button saves the current stop's stored html_content
// verbatim — source, not a rendered snapshot — so the saved file keeps the
// postcard's own script and draws its map and flags when opened from disk.
// (trip-export.js does the opposite for the whole-trip export, where the
// stops have to be flattened into one inert document.)
//
// The HTML is admin-authored and runs inside a `sandbox="allow-scripts"` iframe
// with NO `allow-same-origin`, so its scripts/styles are isolated in an opaque
// origin and cannot touch this page's DOM, cookies, or storage. NEVER add
// allow-same-origin alongside allow-scripts — that combination re-grants
// same-origin access and defeats the sandbox.
//
// Note on headers: `X-Frame-Options: DENY` governs framing of HTTP responses; a
// `srcdoc` iframe has no HTTP response, so it is not affected. If a
// Content-Security-Policy is ever added to the landing site, it must not block
// the srcdoc frame (frame-src/child-src) and must keep allow-scripts in any
// CSP-level sandbox.
(function () {
  "use strict";

  var PA = window.PersonAdmin;
  var BACKDROP_ID = "person-stop-popup";
  var activeKeyHandler = null;

  function dismiss() {
    var existing = document.getElementById(BACKDROP_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    if (activeKeyHandler) {
      document.removeEventListener("keydown", activeKeyHandler);
      activeKeyHandler = null;
    }
  }

  function esc(s) { return PA ? PA.esc(s) : String(s == null ? "" : s); }

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

  // Kept local rather than reaching into TripExport: stop-popup.js loads before
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

  // show(stops, index): stops is the trip's stop array (each with title +
  // html_content) in canonical order; index is the one to open. Prev/Next page
  // through in place. Because the list is canonical, Next always moves to the
  // next-higher stop number and Previous to the next-lower — the caller's
  // display order (which can be reversed on the trip page) does not affect it.
  // The counter is 1-based, so it reads as the card's badge (e.g. "7 / 9").
  function show(stops, index) {
    dismiss(); // singleton — never stack two

    var list = Array.isArray(stops) ? stops : [];
    if (!list.length) return;
    var current = Math.min(Math.max(index | 0, 0), list.length - 1);
    var multi = list.length > 1;

    var root = document.createElement("div");
    root.id = BACKDROP_ID;
    root.className = "stop-popup__backdrop";
    root.innerHTML =
      '<div class="stop-popup__shell" role="dialog" aria-modal="true">' +
        '<div class="stop-popup__bar">' +
          '<span class="stop-popup__title"></span>' +
          '<button class="stop-popup__dl" type="button" aria-label="Download this postcard" ' +
            'title="Download this postcard">' +
            '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
              'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<path d="M12 3v12M7 12l5 5 5-5M4 20h16"/>' +
            "</svg>" +
          "</button>" +
          '<button class="stop-popup__close" aria-label="Close">&times;</button>' +
        "</div>" +
        (multi
          ? '<div class="stop-popup__nav">' +
              '<button class="stop-popup__nav-btn" data-dir="-1">&larr; Previous</button>' +
              '<span class="stop-popup__counter"></span>' +
              '<button class="stop-popup__nav-btn" data-dir="1">Next &rarr;</button>' +
            "</div>"
          : "") +
      "</div>";

    root.addEventListener("click", function (ev) { if (ev.target === root) dismiss(); });
    document.body.appendChild(root);
    root.querySelector(".stop-popup__close").addEventListener("click", dismiss);

    var shell = root.querySelector(".stop-popup__shell");
    var titleEl = root.querySelector(".stop-popup__title");
    var dlBtn = root.querySelector(".stop-popup__dl");
    var counterEl = root.querySelector(".stop-popup__counter");
    var prevBtn = root.querySelector('.stop-popup__nav-btn[data-dir="-1"]');
    var nextBtn = root.querySelector('.stop-popup__nav-btn[data-dir="1"]');

    var frame = document.createElement("iframe");
    frame.className = "stop-popup__frame";
    frame.setAttribute("sandbox", "allow-scripts"); // NO allow-same-origin
    // Insert the frame between the bar and the (optional) nav footer.
    shell.insertBefore(frame, root.querySelector(".stop-popup__nav"));

    function renderAt(i) {
      current = i;
      var stop = list[current];
      var title = (stop && stop.title) || "Postcard";
      titleEl.textContent = title;
      frame.setAttribute("title", title);
      // Reassigning srcdoc reloads the isolated frame in place. Set via the DOM
      // property (not an attribute) so we don't attribute-escape a large document.
      frame.srcdoc = (stop && stop.html_content) || "";
      dlBtn.disabled = !(stop && stop.html_content);
      if (multi) {
        counterEl.textContent = (current + 1) + " / " + list.length;
        prevBtn.disabled = current === 0;
        nextBtn.disabled = current === list.length - 1;
      }
    }

    function go(delta) {
      var next = current + delta;
      if (next >= 0 && next < list.length) renderAt(next);
    }

    if (multi) {
      prevBtn.addEventListener("click", function () { go(-1); });
      nextBtn.addEventListener("click", function () { go(1); });
    }

    // Saves the stop's stored HTML verbatim, so the downloaded file keeps the
    // postcard's own script and renders its map/flags exactly like the popup.
    // Reads `current` at click time, so paging Prev/Next downloads what's shown.
    dlBtn.addEventListener("click", function () {
      var stop = list[current];
      if (!stop || !stop.html_content) return;
      saveBlob(new Blob([stop.html_content], { type: "text/html;charset=utf-8" }),
        fileNameFor(stop.title));
    });

    activeKeyHandler = function (ev) {
      if (ev.key === "Escape") { dismiss(); return; }
      if (!multi) return;
      if (ev.key === "ArrowLeft") go(-1);
      else if (ev.key === "ArrowRight") go(1);
    };
    document.addEventListener("keydown", activeKeyHandler);

    renderAt(current);
  }

  window.StopPopup = { show: show, dismiss: dismiss };
})();
