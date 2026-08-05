// trip-export.js — "Download this trip": builds ONE self-contained static HTML
// file from the trip hero plus every stop's stored postcard page.
//
// The awkward part is that a postcard is only half-written on disk. The stored
// html_content ships #map, #flagRow, the flag swatches and the distance figures
// EMPTY; the page's own <script> fills them at runtime (the whole route map is
// an innerHTML assignment). Serializing the source would quietly produce an
// export with no map and no flags — so each stop is rendered and snapshotted
// instead.
//
// The frame that renders it stays sandboxed exactly as stop-view.js requires
// (allow-scripts, never allow-same-origin), which means we cannot read its DOM.
// So we splice our own harvester into the srcdoc and let the frame post its
// outerHTML up to us as a plain string; we only ever touch the string.
//
// Scripts, on* handlers and javascript: URLs are stripped from that snapshot, so
// the produced file is inert. Per-stop CSS scoping and the flip-card flattening
// live in trip-export-css.js; the exported document's own chrome lives in
// trip-export-style.js.
//
//   TripExport.download(trip, stops, { onProgress: function (done, total) {} })
(function () {
  "use strict";

  var PA = window.PersonAdmin;
  var HARVEST_TIMEOUT_MS = 8000;

  function esc(s) { return PA ? PA.esc(s) : String(s == null ? "" : s); }
  function pad(n) { return String(n).padStart(2, "0"); }

  // ── 1. Harvest the rendered postcard ────────────────────────────────────
  // Runs inside the stop's own frame, after the stop's own script. The settle
  // delay is a timer, NOT requestAnimationFrame: the harvest frame is offscreen
  // and visibility:hidden, so it never gets animation frames and an rAF-based
  // handshake would hang until the timeout every single time.
  var HARVESTER =
    '<script>(function(){var s=function(){try{parent.postMessage(' +
    '{__tripExport:1,html:document.documentElement.outerHTML},"*");}catch(e){}};' +
    "var go=function(){setTimeout(s,60);};" +
    'if(document.readyState==="complete")go();else addEventListener("load",go);' +
    "})();<\/script>";

  function withHarvester(html) {
    var i = html.lastIndexOf("</body>");
    return i < 0 ? html + HARVESTER : html.slice(0, i) + HARVESTER + html.slice(i);
  }

  // Resolves to the rendered document as a string, or to the untouched source if
  // the stop's script never finishes — a broken stop still exports, just
  // unpopulated.
  function harvest(html) {
    return new Promise(function (resolve) {
      var frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts"); // NEVER add allow-same-origin
      frame.setAttribute("aria-hidden", "true");
      frame.style.cssText = "position:fixed;left:-10000px;top:0;width:900px;" +
        "height:1500px;border:0;visibility:hidden;";
      var timer = null;
      var done = false;

      function finish(result) {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        if (frame.parentNode) frame.parentNode.removeChild(frame);
        resolve(result);
      }
      // A sandbox without allow-same-origin gives the frame an opaque origin, so
      // event.origin is the literal string "null" — checking it proves nothing.
      // Identify the sender by its window instead.
      function onMessage(ev) {
        if (ev.source !== frame.contentWindow) return;
        if (!ev.data || ev.data.__tripExport !== 1) return;
        finish(ev.data.html || html);
      }

      window.addEventListener("message", onMessage);
      timer = setTimeout(function () { finish(html); }, HARVEST_TIMEOUT_MS);
      document.body.appendChild(frame);
      frame.srcdoc = withHarvester(html);
    });
  }

  // ── 2. Sanitize ─────────────────────────────────────────────────────────
  function sanitize(doc) {
    doc.querySelectorAll("script,link[rel~=stylesheet]").forEach(function (n) { n.remove(); });
    doc.querySelectorAll("*").forEach(function (el) {
      for (var i = el.attributes.length - 1; i >= 0; i--) {
        var name = el.attributes[i].name;
        var lower = name.toLowerCase();
        if (lower.indexOf("on") === 0) { el.removeAttribute(name); continue; }
        if ((lower === "href" || lower === "src" || lower === "xlink:href") &&
            /^\s*javascript:/i.test(el.attributes[i].value)) el.removeAttribute(name);
      }
    });
  }

  // ── 3. Build ────────────────────────────────────────────────────────────
  function stopSection(stop, no, scopeCls, doc) {
    // The stop's body{...} is re-scoped onto .tx-card, so carry body's own class
    // and inline style across too or rules keyed on them stop matching.
    var bodyCls = doc.body.className ? " " + esc(doc.body.className) : "";
    var bodyStyle = doc.body.getAttribute("style");
    return '<section class="tx-stop">' +
      '<header class="tx-stop__head">' +
        '<span class="tx-stop__no">' + esc(no) + "</span>" +
        "<div>" +
          '<h2 class="tx-stop__title">' + esc(stop.title) + "</h2>" +
          (stop.meta ? '<p class="tx-stop__meta">' + esc(stop.meta) + "</p>" : "") +
        "</div>" +
      "</header>" +
      (stop.note ? '<p class="tx-stop__note">' + esc(stop.note) + "</p>" : "") +
      '<div class="tx-card ' + scopeCls + bodyCls + '"' +
        (bodyStyle ? ' style="' + esc(bodyStyle) + '"' : "") + ">" +
        doc.body.innerHTML +
      "</div>" +
    "</section>";
  }

  function hero(trip) {
    var album = /^https?:/i.test(trip.photo_album_url || "") ? trip.photo_album_url : "";
    return '<header class="tx-hero">' +
      (trip.eyebrow ? '<p class="tx-hero__eyebrow">' + esc(trip.eyebrow) + "</p>" : "") +
      "<h1>" + esc(trip.headline || trip.title || "Trip") + "</h1>" +
      (trip.lede ? '<p class="tx-hero__lede">' + esc(trip.lede) + "</p>" : "") +
      (album ? '<p class="tx-hero__album">Photo album: <a href="' + esc(album) +
        '" rel="noopener">' + esc(album) + "</a></p>" : "") +
      "</header>";
  }

  // Stops are exported in canonical order (00 → N), regardless of the page's
  // newest-first display toggle — a keepsake reads chronologically.
  async function buildHtml(trip, stops, onProgress) {
    var css = [];
    var body = [hero(trip)];

    for (var i = 0; i < stops.length; i++) {
      var stop = stops[i];
      var scopeCls = "pcx-" + i;
      // Parsing never runs scripts, so the snapshot is safe to handle here.
      var doc = new DOMParser().parseFromString(
        await harvest(stop.html_content || ""), "text/html");
      sanitize(doc);
      css.push("/* ── stop " + pad(i) + " ── */\n" +
        window.TripExportCss.flatten(doc, "." + scopeCls));
      body.push(stopSection(stop, pad(i), scopeCls, doc));
      if (onProgress) onProgress(i + 1, stops.length);
    }

    var source = window.location.origin + "/travel/" + (trip.slug || "");
    body.push('<footer class="tx-foot">Exported from <a href="' + esc(source) + '">' +
      esc(source) + "</a></footer>");

    return "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n" +
      '<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      "<title>" + esc(trip.title || "Trip") + "</title>\n" +
      "<style>\n" + window.TripExportStyle.base + "\n</style>\n" +
      "<style>\n" + css.join("\n\n") + "\n</style>\n" +
      // Late: the responsive + print chrome shares its specificity with the
      // scoped stop rules, so it has to come after them to win.
      "<style>\n" + window.TripExportStyle.late + "\n</style>\n" +
      '</head>\n<body>\n<div class="tx-wrap">\n' + body.join("\n") +
      "\n</div>\n</body>\n</html>\n";
  }

  // ── 4. Save ─────────────────────────────────────────────────────────────
  function saveBlob(blob, filename) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  async function download(trip, stops, opts) {
    opts = opts || {};
    var html = await buildHtml(trip || {}, stops || [], opts.onProgress);
    var stem = String((trip && trip.slug) || "trip").replace(/[^\w\- ]+/g, "").trim() || "trip";
    saveBlob(new Blob([html], { type: "text/html;charset=utf-8" }), stem + ".html");
  }

  window.TripExport = { download: download };
})();
