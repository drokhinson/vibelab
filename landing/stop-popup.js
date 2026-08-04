// stop-popup.js — singleton popup that renders a stop's stored HTML page in a
// sandboxed iframe. Used on the trip page: tapping a stop card opens it here.
//
// The trip page loads every stop's html_content in one pass, so the popup renders
// straight from memory — no per-stop fetch. Call StopPopup.show(stops, index) with
// the trip's whole stop list in canonical order; a bottom nav bar pages
// Previous/Next in place so you can read through the route without closing the
// popup between stops.
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
