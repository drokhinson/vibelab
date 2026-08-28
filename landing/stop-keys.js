// stop-keys.js — let the keyboard keep working after the reader clicks a
// postcard.
//
// The stop reader binds ArrowLeft/ArrowRight/Escape on the page (see
// stop-view.js), which is fine right up until the reader touches the card —
// and touching the card is the whole point, since a postcard is a click-to-flip
// two-sided thing. That click moves focus into the stop frame, and from then on
// every keystroke fires in the frame's document and stops there: the frame is
// sandboxed with allow-scripts and NO allow-same-origin, so it is a separate
// document in an opaque origin and key events do not cross the boundary. The
// arrows would silently die on the first flip.
//
// Same constraint and same remedy as stop-readonly.js and stop-pair.js: the
// page can never reach into the postcard, so the work is spliced into the
// srcdoc string and runs inside the postcard's own origin. Here it runs in the
// frame-to-parent direction — the frame reports the key, the page decides what
// it means.
//
//   StopKeys.relay(html) -> html      // splice the reporter in
//   StopKeys.attach(frame, onKey)     // hear that frame's keys
//
// Only the three keys the reader actually uses are forwarded, and nothing else
// about the keystroke leaves the frame — this is a navigation relay, not a
// keylogger. The reporter never calls preventDefault(), so a postcard that
// handles its own keys is untouched by it.
(function () {
  "use strict";

  // Runs inside the postcard. Additive and passive: one listener that reports
  // three keys upward and does nothing else.
  var SCRIPT =
    "<script>(function(){" +
      'var K={ArrowLeft:1,ArrowRight:1,Escape:1};' +
      // The stop frame's fields are already inert (stop-readonly.js), but a
      // caret in a text box still means the keystroke belongs to the box.
      'var FIELD="input,textarea,select,[contenteditable]";' +
      'addEventListener("keydown",function(ev){' +
        "if(!K[ev.key])return;" +
        "var a=document.activeElement;" +
        "try{if(a&&a.closest&&a.closest(FIELD))return;}catch(e){}" +
        "try{parent.postMessage({__stopKeys:1,key:ev.key,repeat:!!ev.repeat," +
          "meta:!!ev.metaKey,ctrl:!!ev.ctrlKey,alt:!!ev.altKey}," +
          '"*");}catch(e){}' +
      "});" +
    "})();<\/script>";

  function relay(html) {
    if (!html) return "";
    var i = html.lastIndexOf("</body>");
    return i < 0 ? html + SCRIPT : html.slice(0, i) + SCRIPT + html.slice(i);
  }

  // ── Parent side ───────────────────────────────────────────────────────────
  // One frame is live at a time — stop-view.js replaces it wholesale on every
  // render — so this keeps a single window listener and a pointer to the frame
  // that is allowed to talk, rather than a listener per frame. During a
  // Previous/Next slide the outgoing frame is still in the DOM for a moment;
  // it is no longer `live`, so its keys are ignored.
  var live = null;
  var sink = null;
  var bound = false;

  function onMessage(ev) {
    // Origin is the literal string "null" in an opaque-origin frame, so it
    // proves nothing; identify the sender by its window instead. Same rule as
    // stop-pair.js's listener and trip-export.js's harvester.
    if (!live || !sink) return;
    try { if (ev.source !== live.contentWindow) return; }
    catch (_) { return; }
    var d = ev.data;
    if (!d || d.__stopKeys !== 1 || typeof d.key !== "string") return;
    sink(d.key, { repeat: !!d.repeat, meta: !!d.meta, ctrl: !!d.ctrl, alt: !!d.alt });
  }

  function attach(frame, onKey) {
    live = frame;
    sink = onKey;
    if (bound) return;
    bound = true;
    window.addEventListener("message", onMessage);
  }

  window.StopKeys = { relay: relay, attach: attach };
})();
