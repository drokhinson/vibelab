// trip-export-css.js — the CSS half of the trip export (see trip-export.js).
//
// Given one stop's parsed document, it does two things and returns the CSS to
// emit for that stop:
//
//   1. Re-scopes the stop's own stylesheet under a per-stop class. Each stop is
//      a whole standalone page whose <style> claims :root, *, body, .card,
//      .face — dropped into a shared document as-is, two stops would clobber
//      each other and the export's chrome.
//   2. Flattens the two-sided flip rig into a front/back pair laid out side by
//      side, which is what a postcard has to be on a page you can't tap.
//
// Detection is driven by the declarations (preserve-3d, backface-visibility,
// rotateY(180deg), perspective), not by class names, so a differently authored
// postcard still flattens.
//
//   TripExportCss.flatten(doc, ".pcx-0")  // mutates doc, returns a CSS string
(function () {
  "use strict";

  var STYLE_RULE = 1, MEDIA_RULE = 4, SUPPORTS_RULE = 12;
  var HINT_RE = /tap the card|turn it over|\bflip\b/i;
  var DEFAULT_RATIO = "1000 / 1500";

  // Paper is the constraint the screen layout can ignore. An A4-landscape page
  // box (12mm margins → ~1032×715px) can't hold a portrait postcard pair at the
  // width these pages need, and break-inside:avoid is only a request — a block
  // taller than the page gets split anyway.
  var PRINT_CARD_W = 1000;    // px — the width the card lays out at, before scaling
  var PRINT_GAP = 16;
  var PRINT_CARD_H = 580;     // px of an A4-landscape page box left under the header
  var PRINT_PORTRAIT_W = 730; // px of an A4-portrait page box, if the user flips it

  // ── Scoping ─────────────────────────────────────────────────────────────
  // Leading :root / html / body map onto the scope element itself, keeping
  // anything attached to them attached (body.foo → .pcx-0.foo).
  function prefixSelector(selectorText, scope) {
    return selectorText.split(",").map(function (part) {
      part = part.trim();
      if (!part) return "";
      if (part === "*") return scope + ", " + scope + " *";
      var root = part.match(/^(?::root(?![\w-])|html(?![\w-])|body(?![\w-]))/i);
      if (!root) return scope + " " + part;
      return scope + part.slice(root[0].length).replace(/^\s+body(?![\w-])/i, "");
    }).join(", ");
  }

  function walkRules(rules, scope, out, probe) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i], inner;
      if (r.type === STYLE_RULE) {
        probe(r); // read flip signals off the ORIGINAL selector
        out.push(prefixSelector(r.selectorText, scope) + "{" + r.style.cssText + "}");
      } else if (r.type === MEDIA_RULE) {
        // The postcards ship their own @media print, which unrolls the flip with
        // page-break-after:always on each face — that splits a postcard's front
        // from its back on paper, the exact thing this export exists to fix.
        // The export owns print; drop the stop's print rules entirely.
        var cond = r.conditionText || (r.media && r.media.mediaText) || "";
        if (/(^|[\s(,])print([\s),]|$)/i.test(cond)) continue;
        inner = [];
        walkRules(r.cssRules, scope, inner, probe);
        out.push("@media " + cond + "{" + inner.join("\n") + "}");
      } else if (r.type === SUPPORTS_RULE) {
        inner = [];
        walkRules(r.cssRules, scope, inner, probe);
        out.push("@supports " + r.conditionText + "{" + inner.join("\n") + "}");
      } else {
        out.push(r.cssText); // @keyframes, @font-face — never prefixed
      }
    }
  }

  // media="not all" makes the browser parse the sheet while applying none of it,
  // so injecting a stop's body{...} can't restyle the live trip page. A <style>
  // inside a DOMParser document has .sheet === null (no browsing context), so the
  // live document is the only place this can happen. Rules the CSSOM can't parse
  // are dropped — the stop popup wouldn't have rendered them either.
  function scopeCss(cssText, scope, out, probe) {
    var el = document.createElement("style");
    el.media = "not all";
    el.textContent = cssText;
    document.head.appendChild(el);
    try {
      if (el.sheet && el.sheet.cssRules) walkRules(el.sheet.cssRules, scope, out, probe);
    } catch (err) {
      console.warn("Trip export: could not scope a stylesheet.", err);
    }
    el.remove();
  }

  // ── Flip detection ──────────────────────────────────────────────────────
  function makeProbe(sig) {
    return function (rule) {
      var s = rule.style, v;
      if (/preserve-3d/i.test(s.getPropertyValue("transform-style"))) {
        sig.card.push(rule.selectorText);
        v = s.getPropertyValue("aspect-ratio");
        if (v && !sig.ratio) sig.ratio = v.trim();
      }
      if (/hidden/i.test(s.getPropertyValue("backface-visibility") ||
                         s.getPropertyValue("-webkit-backface-visibility"))) {
        sig.face.push(rule.selectorText);
      }
      if (/rotatey\(\s*180/i.test(s.getPropertyValue("transform"))) sig.back.push(rule.selectorText);
      v = s.getPropertyValue("perspective");
      if (v && !/^\s*none\s*$/i.test(v)) sig.stage.push(rule.selectorText);
    };
  }

  function matchAny(el, selectors) {
    try { return selectors.length ? el.matches(selectors.join(",")) : false; } catch (_) { return false; }
  }

  function unflip(doc, sig) {
    if (!sig.card.length || !sig.face.length) return false;
    var card, faces;
    try {
      card = doc.body.querySelector(sig.card.join(","));
      if (!card) return false;
      faces = Array.prototype.slice.call(card.querySelectorAll(sig.face.join(",")));
    } catch (_) { return false; }
    if (faces.length < 2) return false;

    var back = null;
    for (var i = 0; i < faces.length && !back; i++) {
      if (matchAny(faces[i], sig.back)) back = faces[i];
    }
    if (!back) back = faces[1];
    var front = faces[0] === back ? faces[1] : faces[0];

    card.setAttribute("data-tx-card", "");
    front.setAttribute("data-tx-face", "front");
    back.setAttribute("data-tx-face", "back");
    // Front always reads left.
    if (front.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_PRECEDING) {
      back.parentNode.insertBefore(front, back);
    }
    // The stage is whichever ancestor sets the perspective.
    for (var el = card.parentElement; el && el !== doc.body; el = el.parentElement) {
      if (matchAny(el, sig.stage)) { el.setAttribute("data-tx-stage", ""); break; }
    }
    return true;
  }

  // "Tap the card to turn it over" is a lie once both faces are showing.
  function dropFlipHints(doc) {
    doc.body.querySelectorAll("p,span,div,small,figcaption").forEach(function (el) {
      if (el.children.length > 1) return;
      var t = (el.textContent || "").trim();
      if (t && t.length <= 120 && HINT_RE.test(t)) el.remove();
    });
  }

  // ── Overrides ───────────────────────────────────────────────────────────
  function flipOverrides(scope, ratio) {
    return [
      scope + " [data-tx-stage]{ perspective:none !important; width:100% !important;" +
        " max-width:none !important; }",
      // Grid, not flex: two 1fr columns are exactly equal whatever the faces
      // contain, where flex items with an aspect-ratio size off their content
      // and the denser back face ends up wider than the front.
      scope + " [data-tx-card]{ transform:none !important; transform-style:flat !important;" +
        " transition:none !important; aspect-ratio:auto !important; position:relative;" +
        " display:grid; grid-template-columns:1fr 1fr; align-items:start; gap:" + PRINT_GAP + "px;" +
        " width:100%; height:auto; cursor:default; }",
      scope + " [data-tx-face]{ position:relative !important; inset:auto !important;" +
        " transform:none !important; backface-visibility:visible !important;" +
        " -webkit-backface-visibility:visible !important; min-width:0; min-height:0;" +
        " width:auto; height:auto; aspect-ratio:" + ratio + "; }",
    ].join("\n");
  }

  // On paper, pin the card to its on-screen layout width and scale the whole
  // thing down. Scaling rather than narrowing is the point: postcards size their
  // type in vw/clamp against the viewport, so a narrower card reflows its text,
  // overflows the fixed-ratio face and clips the map off the bottom. Scaling
  // shrinks type and card together, so nothing reflows at all.
  function printFit(scope, ratio) {
    var parts = String(ratio).split("/");
    var r = parts.length === 2 ? parseFloat(parts[0]) / parseFloat(parts[1]) : NaN;
    if (!isFinite(r) || r <= 0) r = 1000 / 1500;
    var faceH = ((PRINT_CARD_W - PRINT_GAP) / 2) / r;

    function block(query, k) {
      return query + "{" +
        scope + ".tx-card{ display:block !important; overflow:hidden; margin:0 auto;" +
          " width:" + Math.round(PRINT_CARD_W * k) + "px;" +
          " height:" + Math.round(faceH * k) + "px; }" +
        scope + " [data-tx-stage]{ width:" + PRINT_CARD_W + "px !important; margin:0 !important; }" +
        scope + " [data-tx-card]{ width:" + PRINT_CARD_W + "px; transform:scale(" + k.toFixed(4) +
          ") !important; transform-origin:top left; }" +
        "}";
    }

    var landscape = Math.min(1, PRINT_CARD_H / faceH);
    return [
      block("@media print", landscape),
      // The document asks for landscape, but the print dialog can override it —
      // and on a portrait page the binding constraint is width, not height.
      block("@media print and (orientation:portrait)",
            Math.min(landscape, PRINT_PORTRAIT_W / PRINT_CARD_W)),
    ].join("\n");
  }

  // ── Entry point ─────────────────────────────────────────────────────────
  // Mutates `doc`: strips its <style> elements (their content comes back as the
  // return value) and tags the flip rig. Returns the CSS to emit for this stop.
  function flatten(doc, scope) {
    var sig = { card: [], face: [], back: [], stage: [], ratio: "" };
    var probe = makeProbe(sig);
    var out = [];
    var styles = Array.prototype.slice.call(doc.querySelectorAll("style"));
    styles.forEach(function (el) { scopeCss(el.textContent, scope, out, probe); });
    styles.forEach(function (el) { el.remove(); });

    if (unflip(doc, sig)) {
      dropFlipHints(doc);
      var ratio = sig.ratio || DEFAULT_RATIO;
      out.push(flipOverrides(scope, ratio));
      out.push(printFit(scope, ratio));
    }
    return out.join("\n");
  }

  window.TripExportCss = { flatten: flatten };
})();
