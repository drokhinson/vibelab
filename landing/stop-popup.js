// stop-popup.js — singleton popup that renders a stop's stored HTML page in a
// sandboxed iframe. Used on the trip page: tapping a stop card opens it here.
//
// The trip page loads every stop's html_content in one pass, so the popup renders
// straight from memory — no per-stop fetch. Call StopPopup.show(title, html).
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

  function dismiss() {
    var existing = document.getElementById(BACKDROP_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    document.removeEventListener("keydown", onKey);
  }

  function onKey(ev) { if (ev.key === "Escape") dismiss(); }

  function esc(s) { return PA ? PA.esc(s) : String(s == null ? "" : s); }

  function show(title, html) {
    dismiss(); // singleton — never stack two

    var root = document.createElement("div");
    root.id = BACKDROP_ID;
    root.className = "stop-popup__backdrop";
    root.innerHTML =
      '<div class="stop-popup__shell" role="dialog" aria-modal="true">' +
        '<div class="stop-popup__bar">' +
          '<span class="stop-popup__title">' + esc(title || "Postcard") + "</span>" +
          '<button class="stop-popup__close" aria-label="Close">&times;</button>' +
        "</div>" +
      "</div>";

    root.addEventListener("click", function (ev) { if (ev.target === root) dismiss(); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(root);
    root.querySelector(".stop-popup__close").addEventListener("click", dismiss);

    var frame = document.createElement("iframe");
    frame.className = "stop-popup__frame";
    frame.setAttribute("sandbox", "allow-scripts"); // NO allow-same-origin
    frame.setAttribute("title", title || "Postcard");
    // Set via the DOM property (not an attribute string) so we don't have to
    // attribute-escape a ~400 KB document.
    frame.srcdoc = html || "";
    root.querySelector(".stop-popup__shell").appendChild(frame);
  }

  window.StopPopup = { show: show, dismiss: dismiss };
})();
