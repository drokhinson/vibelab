// stop-pair.js — on a sideways phone, lay a postcard's two faces side by side
// instead of asking the reader to flip it.
//
// A postcard is a two-sided flip card sized for a phone held upright. Turned
// sideways there is width to spare and almost no height, which is exactly the
// shape a front/back pair wants — so in landscape the flip rig is flattened
// into two columns and the "tap the card to turn it over" line, now a lie, is
// hidden.
//
// Same constraint as stop-readonly.js: the stop frame is sandboxed with
// allow-scripts and NO allow-same-origin, so this page can never touch the
// postcard's DOM. Both halves of the work are spliced into the srcdoc string
// and run inside the postcard's own opaque origin.
//
//   StopPair.pair(html) -> html   // splice the <style> + <script> in
//   StopPair.attach(frame)        // tell that frame when to pair, and when to stop
//
// Detection is by CSS *declaration*, never by class name — postcards are
// hand-authored and name nothing consistently. The four signals (preserve-3d →
// the card, backface-visibility:hidden → a face, rotateY(180deg) → the back,
// a non-none perspective → the stage) are the same ones trip-export-css.js
// uses to flatten a card for the whole-trip export, and the overrides below are
// that module's flipOverrides() minus its print half. The two copies cannot
// share a module — this one has to reach the postcard as a string, and runs in
// a different realm once it gets there — so THEY MUST BE KEPT IN STEP BY HAND.
//
// Whether to pair is decided out here, not by a media query inside the frame.
// The frame box is always shorter than the page, so an in-frame query would
// pair a postcard on a short desktop window while the page still showed its
// bars. Instead the parent's own breakpoint is posted in, which also means
// rotating re-lays-out the card in place — the frame is never rebuilt, so the
// reader keeps their scroll position.
(function () {
  "use strict";

  // Must match the landscape block in person-travel.css. That query is what
  // moves Previous/Next into the side rails; this is what pairs the faces
  // behind them, and they only make sense together.
  var LANDSCAPE = "(orientation: landscape) and (max-height: 620px)";

  // Nothing in here applies until the parent says the phone is held sideways,
  // so a portrait card is untouched down to the last declaration. Every rule is
  // !important because it is overriding CSS this file has never seen — the
  // export can rely on source order for that, and a splice into someone else's
  // document cannot. The one value that isn't constant, the card's own
  // aspect-ratio, arrives as a custom property the script sets; the fallback is
  // trip-export-css.js's DEFAULT_RATIO.
  var STYLE = "<style data-tx-pair>" +
    // box-sizing is this file's one addition to the export's overrides:
    // width:100% on a content-box stage that carries padding overflows its
    // parent by exactly that padding, and sideways there is no width to spare.
    "html[data-tx-paired] [data-tx-stage]{perspective:none!important;" +
      "box-sizing:border-box!important;width:100%!important;" +
      "max-width:none!important;}" +
    // Grid, not flex: two 1fr columns are exactly equal whatever the faces
    // contain, where flex items with an aspect-ratio size off their content and
    // the denser back face ends up wider than the front.
    "html[data-tx-paired] [data-tx-card]{transform:none!important;" +
      "transform-style:flat!important;transition:none!important;" +
      "aspect-ratio:auto!important;position:relative!important;" +
      "display:grid!important;grid-template-columns:1fr 1fr!important;" +
      "align-items:start!important;gap:16px!important;" +
      // max-width goes too, unlike the export's version of these overrides: a
      // card that caps itself for a phone held upright would otherwise pair
      // into two narrow columns down the middle of a screen turned sideways
      // precisely to give it more width.
      "width:100%!important;max-width:none!important;" +
      "height:auto!important;cursor:default!important;}" +
    "html[data-tx-paired] [data-tx-face]{position:relative!important;" +
      "inset:auto!important;transform:none!important;" +
      "backface-visibility:visible!important;" +
      "-webkit-backface-visibility:visible!important;" +
      "min-width:0!important;min-height:0!important;" +
      "width:auto!important;height:auto!important;" +
      "aspect-ratio:var(--tx-face-ratio,1000/1500)!important;}" +
    // Front always reads left. Placing only the back leaves the front to
    // auto-place into the one free cell, so this works whichever order the two
    // faces are authored in — no DOM reordering needed.
    'html[data-tx-paired] [data-tx-face="back"]{grid-column:2!important;}' +
    "html[data-tx-paired] [data-tx-hint]{display:none!important;}" +
    "</style>";

  // Runs inside the postcard. Everything it does is additive and reversible:
  // it only tags elements, and the tags do nothing until <html> carries
  // data-tx-paired. Rotating back to portrait drops that one attribute and the
  // card flips again.
  var SCRIPT =
    "<script>(function(){" +
      // Keep in step with trip-export-css.js's HINT_RE.
      'var HINT=/tap the card|turn it over|\\bflip\\b/i;' +
      "var sig=null,tagged=false;" +

      // ── detect ──
      "function probe(r){var s=r.style,v;if(!s)return;" +
        'if(/preserve-3d/i.test(s.getPropertyValue("transform-style"))){' +
          "sig.card.push(r.selectorText);" +
          'v=s.getPropertyValue("aspect-ratio");' +
          "if(v&&!sig.ratio)sig.ratio=v.trim();}" +
        'if(/hidden/i.test(s.getPropertyValue("backface-visibility")||' +
          's.getPropertyValue("-webkit-backface-visibility")))' +
          "sig.face.push(r.selectorText);" +
        'if(/rotatey\\(\\s*180/i.test(s.getPropertyValue("transform")))' +
          "sig.back.push(r.selectorText);" +
        'v=s.getPropertyValue("perspective");' +
        'if(v&&!/^\\s*none\\s*$/i.test(v))sig.stage.push(r.selectorText);}' +

      // Postcards ship their own @media print, which unrolls the flip — those
      // rules describe paper, not the card, so they would poison the signature.
      "function walk(rules){for(var i=0;i<rules.length;i++){var r=rules[i];" +
        "if(r.type===1){probe(r);continue;}" +
        "if(!r.cssRules)continue;" +
        'var c=r.conditionText||(r.media&&r.media.mediaText)||"";' +
        "if(/(^|[\\s(,])print([\\s),]|$)/i.test(c))continue;" +
        "walk(r.cssRules);}}" +

      "function collect(){sig={card:[],face:[],back:[],stage:[],ratio:\"\"};" +
        "var sheets=document.styleSheets,i;" +
        "for(i=0;i<sheets.length;i++){" +
          // Our own sheet declares none of the four signals, but skip it anyway
          // so it can never be read as part of the card.
          "try{if(sheets[i].ownerNode&&sheets[i].ownerNode.hasAttribute&&" +
            'sheets[i].ownerNode.hasAttribute("data-tx-pair"))continue;' +
            "if(sheets[i].cssRules)walk(sheets[i].cssRules);}catch(e){}}}" +

      // ── tag ──
      "function matchAny(el,sels){try{" +
        'return sels.length?el.matches(sels.join(",")):false;}catch(e){return false;}}' +

      "function tag(){if(tagged||!document.body)return;" +
        "if(!sig||!sig.card.length||!sig.face.length)return;" +
        "var card,faces;try{" +
          'card=document.body.querySelector(sig.card.join(","));' +
          "if(!card)return;" +
          'faces=[].slice.call(card.querySelectorAll(sig.face.join(",")));' +
        "}catch(e){return;}" +
        "if(faces.length<2)return;" +
        "var back=null,front,el,i,n,t;" +
        "for(i=0;i<faces.length&&!back;i++)if(matchAny(faces[i],sig.back))back=faces[i];" +
        "if(!back)back=faces[1];" +
        "front=faces[0]===back?faces[1]:faces[0];" +
        'card.setAttribute("data-tx-card","");' +
        'front.setAttribute("data-tx-face","front");' +
        'back.setAttribute("data-tx-face","back");' +
        // The stage is whichever ancestor sets the perspective.
        "for(el=card.parentElement;el&&el!==document.body;el=el.parentElement){" +
          'if(matchAny(el,sig.stage)){el.setAttribute("data-tx-stage","");break;}}' +
        "if(sig.ratio)document.documentElement.style.setProperty(" +
          '"--tx-face-ratio",sig.ratio);' +
        'var l=document.body.querySelectorAll("p,span,div,small,figcaption");' +
        "for(i=0;i<l.length;i++){n=l[i];if(n.children.length>1)continue;" +
          't=(n.textContent||"").trim();' +
          'if(t&&t.length<=120&&HINT.test(t))n.setAttribute("data-tx-hint","");}' +
        "tagged=true;}" +

      // Cheap enough to redo: a postcard whose own script builds the card late
      // (the route map and the flag rows do exactly that) is caught by the
      // later passes, and tag() is a no-op once it has succeeded.
      "function run(){if(tagged)return;try{collect();tag();}catch(e){}}" +
      "run();" +
      'addEventListener("DOMContentLoaded",run);addEventListener("load",run);' +

      // ── the parent's verdict ──
      // Origin is the literal string "null" in an opaque-origin frame, so it
      // proves nothing; identify the sender by its window instead. Same rule as
      // trip-export.js's harvester, in the other direction.
      'addEventListener("message",function(ev){' +
        "if(ev.source!==parent||!ev.data||ev.data.__stopPair!==1)return;" +
        "run();" +
        "var h=document.documentElement;" +
        'if(ev.data.paired)h.setAttribute("data-tx-paired","");' +
        'else h.removeAttribute("data-tx-paired");});' +
    "})();<\/script>";

  function pair(html) {
    if (!html) return "";
    // Both pieces go at the end of the body: the style has to beat whatever the
    // postcard declared for its own card, and every override is scoped under
    // html[data-tx-paired] so none of it can touch the portrait card.
    var i = html.lastIndexOf("</body>");
    var chunk = STYLE + SCRIPT;
    return i < 0 ? html + chunk : html.slice(0, i) + chunk + html.slice(i);
  }

  // ── Parent side ───────────────────────────────────────────────────────────
  // One frame is live at a time — stop-view.js replaces it wholesale on every
  // render, and during a Previous/Next slide the outgoing one is on its way out
  // of the DOM, so only the incoming frame is ever worth talking to.
  var live = null;
  var mql = null;

  function query() {
    if (mql !== null) return mql;
    try { mql = window.matchMedia(LANDSCAPE); } catch (_) { mql = false; }
    if (mql && mql.addEventListener) mql.addEventListener("change", post);
    return mql;
  }

  // contentWindow is null until the frame is in the document, and a frame that
  // has not finished its first load has no listener yet — hence the repeat on
  // load. Posting to a frame that isn't ready simply does nothing.
  function post() {
    if (!live) return;
    var q = query();
    try {
      if (live.contentWindow) {
        live.contentWindow.postMessage(
          { __stopPair: 1, paired: !!(q && q.matches) }, "*");
      }
    } catch (_) { /* frame gone */ }
  }

  function attach(frame) {
    live = frame;
    query();
    frame.addEventListener("load", function () { if (live === frame) post(); });
    post();
  }

  window.StopPair = { pair: pair, attach: attach };
})();
