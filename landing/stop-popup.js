// stop-popup.js — singleton popup that renders a stop's stored HTML page in a
// sandboxed iframe. Used on the trip page: tapping a stop card opens it here.
//
// The HTML is admin-authored and stored per stop. It runs inside a
// `sandbox="allow-scripts"` iframe with NO `allow-same-origin`, so its scripts
// and styles are isolated in an opaque origin and cannot touch this page's DOM,
// cookies, or storage. NEVER add allow-same-origin alongside allow-scripts —
// that combination re-grants same-origin access and defeats the sandbox.
//
// Note on headers: `X-Frame-Options: DENY` (set on landing responses) governs
// framing of HTTP responses; a `srcdoc` iframe has no HTTP response, so it is
// not affected. If a Content-Security-Policy is ever added to the landing site,
// it must not block the srcdoc frame (frame-src/child-src) and must keep
// allow-scripts in any CSP-level sandbox.
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

  async function show(stopId, title) {
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
        '<div class="stop-popup__state">Loading…</div>' +
      "</div>";

    root.addEventListener("click", function (ev) { if (ev.target === root) dismiss(); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(root);
    root.querySelector(".stop-popup__close").addEventListener("click", dismiss);

    var shell = root.querySelector(".stop-popup__shell");
    var state = root.querySelector(".stop-popup__state");

    try {
      var stop = await PA.publicFetch("/stops/" + encodeURIComponent(stopId));
      // The popup may have been dismissed while loading — bail if so.
      if (!document.getElementById(BACKDROP_ID)) return;
      if (stop.title) {
        var titleEl = root.querySelector(".stop-popup__title");
        if (titleEl) titleEl.textContent = stop.title;
      }
      var frame = document.createElement("iframe");
      frame.className = "stop-popup__frame";
      frame.setAttribute("sandbox", "allow-scripts"); // NO allow-same-origin
      frame.setAttribute("title", stop.title || "Postcard");
      // Set via the DOM property (not an attribute string) so we don't have to
      // attribute-escape a ~400 KB document.
      frame.srcdoc = stop.html_content || "";
      state.replaceWith(frame);
    } catch (err) {
      if (state) {
        state.className = "stop-popup__state stop-popup__state--error";
        state.textContent = "Couldn’t load this stop: " + err.message;
      }
    }

    void shell; // referenced for clarity; layout handled in CSS
  }

  window.StopPopup = { show: show, dismiss: dismiss };
})();
