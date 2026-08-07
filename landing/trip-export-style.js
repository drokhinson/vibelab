// trip-export-style.js — the chrome CSS for the file trip-export.js produces.
// Split out purely so trip-export.js stays about the pipeline and this stays
// about how the exported document looks.
//
// Two sheets, and the order matters. `base` is emitted BEFORE each stop's
// re-scoped CSS; `late` is emitted AFTER it. The flip overrides in
// trip-export.js are `.pcx-N [data-tx-card]` (0,2,0) and the responsive/print
// rules here are `.tx-card [data-tx-card]` — identical specificity, so the only
// thing that lets print win is coming last.
//
// The palette is the trip's own colour preset, so the download reads as the
// same artefact as the page it came from. Rather than keeping a second copy of
// the four palettes here, `base` READS the tokens off the live document — the
// export is always generated from a trip page that already has the theme
// applied, so the two cannot drift. FALLBACK is only for the case where a token
// resolves empty (a stylesheet that failed to load).
//
//   TripExportStyle.base()   // string — reads the current page's tokens
//   TripExportStyle.late     // string — responsive + print chrome
(function () {
  "use strict";

  var TOKENS = [
    "--trip-ground-top", "--trip-ground-mid", "--trip-ground-deep",
    "--trip-accent", "--trip-plate", "--trip-meta", "--trip-go", "--plaque",
  ];
  var FALLBACK = {
    "--trip-ground-top": "#2E5C86",
    "--trip-ground-mid": "#16324B",
    "--trip-ground-deep": "#0E2032",
    "--trip-accent": "#F2D46B",
    "--trip-plate": "#123C6B",
    "--trip-meta": "#4E7FA6",
    "--trip-go": "#B0552E",
    "--plaque": "#FBFAF6",
  };

  function palette() {
    var cs = window.getComputedStyle(document.documentElement);
    return ":root{ " + TOKENS.map(function (name) {
      var v = (cs.getPropertyValue(name) || "").trim();
      return name + ":" + (v || FALLBACK[name]) + ";";
    }).join(" ") + " }";
  }

  function baseSheet() { return [
    palette(),
    "*{ box-sizing:border-box; }",
    // This file DOES scroll (it's the whole trip on one page), so body keeps
    // its fixed gradient. html carries the gradient's end colour so the iOS
    // repaint bug in background-attachment:fixed falls back to dark instead of
    // flashing the white canvas.
    "html{ background:var(--trip-ground-deep); }",
    "body{ margin:0; padding:36px 20px 64px; color:#D6DFE7;",
    "  font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;",
    "  background:radial-gradient(120% 90% at 50% 0%, var(--trip-ground-top) 0%, var(--trip-ground-mid) 55%, var(--trip-ground-deep) 100%);",
    "  background-attachment:fixed; -webkit-font-smoothing:antialiased; }",
    ".tx-wrap{ max-width:1040px; margin:0 auto; }",

    ".tx-hero{ text-align:center; padding-bottom:2.5rem; margin-bottom:2.75rem;",
    "  border-bottom:1px solid rgba(255,255,255,.14); }",
    ".tx-hero__eyebrow{ margin:0 0 .9rem; font-size:.72rem; letter-spacing:.32em;",
    "  text-transform:uppercase; color:var(--trip-accent); font-weight:700; }",
    ".tx-hero h1{ margin:0 0 1rem; font-size:clamp(2rem,6vw,3.2rem); line-height:.98;",
    "  font-weight:800; letter-spacing:-.03em; color:#fff; }",
    ".tx-hero__lede{ margin:0 auto 1rem; max-width:52ch; font-size:1rem; line-height:1.6;",
    "  color:rgba(214,223,231,.9); }",
    ".tx-hero__album{ margin:0; font-size:.85rem; color:var(--trip-accent); word-break:break-all; }",
    ".tx-hero__album a{ color:inherit; }",

    ".tx-stop{ margin:0 0 3.5rem; }",
    ".tx-stop__head{ display:flex; align-items:center; gap:.9rem; margin:0 0 .6rem; }",
    ".tx-stop__no{ flex:none; width:52px; height:52px; border-radius:12px; display:flex;",
    "  align-items:center; justify-content:center; background:var(--trip-plate); color:var(--plaque);",
    "  font-family:'Arial Narrow',Impact,sans-serif; font-size:1.5rem; font-weight:800; line-height:1; }",
    ".tx-stop__title{ margin:0; font-family:'Arial Narrow',Impact,sans-serif; font-size:1.7rem;",
    "  line-height:1; font-weight:700; text-transform:uppercase; color:#fff; }",
    ".tx-stop__meta{ margin:.35rem 0 0; font-size:.74rem; letter-spacing:.16em;",
    "  text-transform:uppercase; font-weight:700; color:var(--trip-meta); }",
    ".tx-stop__note{ margin:0 0 1rem 4.1rem; font-size:.95rem; line-height:1.55;",
    "  color:rgba(214,223,231,.85); }",
    // Each stop's own page CSS lands on .tx-card (its body{...} is re-scoped
    // onto this element), so it keeps its original backdrop and padding.
    ".tx-card{ border-radius:14px; overflow:hidden; }",

    ".tx-foot{ margin-top:1rem; padding-top:1.5rem; text-align:center; font-size:.78rem;",
    "  color:rgba(214,223,231,.5); border-top:1px solid rgba(255,255,255,.14); }",
    ".tx-foot a{ color:inherit; }",
  ].join("\n"); }

  var late = [
    // A postcard that shipped an editable box is inert here — trip-export.js's
    // sanitize() already dropped its scripts and marked the fields readonly, and
    // this stops a stray one from still catching taps in the exported file.
    ".tx-card input, .tx-card textarea, .tx-card select{",
    "  pointer-events:none !important; caret-color:transparent !important; }",
    ".tx-card [contenteditable]{ -webkit-user-modify:read-only !important;",
    "  user-modify:read-only !important; }",

    // Narrow screens can't hold two faces abreast; stack them.
    "@media (max-width:760px){",
    "  .tx-card [data-tx-card]{ grid-template-columns:1fr; }",
    "  .tx-stop__note{ margin-left:0; }",
    "}",

    "@media print{",
    "  @page{ size:A4 landscape; margin:12mm; }",
    "  html, body{ background:#fff !important; }",
    "  body{ color:#111; padding:0; }",
    "  .tx-hero{ border-bottom-color:#bbb; }",
    "  .tx-hero h1, .tx-stop__title{ color:#111; }",
    "  .tx-hero__lede, .tx-stop__note{ color:#333; }",
    "  .tx-hero__album, .tx-foot{ color:#555; }",
    "  .tx-foot{ border-top-color:#bbb; }",
    // The stop's re-scoped body{...} put a dark gradient on this element; on
    // paper that is a full-bleed ink dump.
    "  .tx-card{ background:#fff !important; background-image:none !important;",
    "    padding:0 !important; border-radius:0; }",
    // Continuous flow — no forced break between stops — but never slice a
    // postcard, a face, or an image across a page boundary.
    "  .tx-stop, .tx-stop__head, .tx-card, .tx-card [data-tx-card]{",
    "    break-inside:avoid; page-break-inside:avoid; }",
    "  .tx-card [data-tx-face], .tx-card img, .tx-card svg{",
    "    break-inside:avoid; page-break-inside:avoid; }",
    // Fitting a postcard onto a page needs the card's aspect ratio, so those
    // rules are emitted per stop by trip-export.js (printFit) — they have to
    // come from there anyway to outrank this sheet's screen layout.
    "}",
  ].join("\n");

  window.TripExportStyle = { base: baseSheet, late: late };
})();
