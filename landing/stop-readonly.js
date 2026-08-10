// stop-readonly.js — makes an authored postcard document inert before it is
// handed to a frame.
//
// Postcards are hand-written HTML and some of them carry editing affordances: a
// contenteditable block, a stray <input>. On screen that means tapping the card
// puts a caret in a text box (and raises the keyboard on a phone) instead of
// flipping it. Rather than rewrite every stored document, every postcard is
// neutered on the way in.
//
// It has to be done from inside the document, not from the page: the stop frame
// is sandboxed with allow-scripts and NO allow-same-origin, so the page cannot
// reach its DOM. So harden() splices a <style> and a <script> into the HTML
// string — the same technique trip-export.js uses for its harvester — and they
// run inside the postcard's own opaque origin.
//
//   StopReadonly.harden(html) -> html
(function () {
  "use strict";

  // pointer-events:none is the part that fixes the tap: the touch falls through
  // the field to whatever ancestor carries the postcard's own flip handler.
  // Nothing here is given `disabled` — that would grey the control out and
  // restyle the card. pointer-events plus tabindex=-1 already make it
  // unreachable, and readOnly covers a field that somehow gets focus anyway.
  //
  // Only TEXT-ENTRY controls, hence the :not() list. The problem this solves is
  // that tapping a text field raises the phone keyboard and steals the flip tap
  // — a range, checkbox, radio or button does none of that, and neutering them
  // would silently break a document's own controls (a trip recap's scrub bar is
  // exactly the shape that would hit this). Keep the two selectors in step.
  var FIELD_SEL = "input:not([type=range]):not([type=checkbox]):not([type=radio])" +
    ":not([type=button]):not([type=submit]):not([type=reset]):not([type=image])" +
    ",textarea,select";

  var STYLE = "<style>" +
    "[contenteditable]{-webkit-user-modify:read-only!important;user-modify:read-only!important;}" +
    FIELD_SEL + "{pointer-events:none!important;caret-color:transparent!important;}" +
    "</style>";

  // Runs inside the postcard. The MutationObserver is what covers cards that
  // build their DOM in their own script — the route map and flag rows do exactly
  // that. Note the `!== "false"` guard before writing contenteditable: the
  // observer watches that attribute, so an unconditional write would retrigger
  // itself forever.
  var SCRIPT =
    "<script>(function(){" +
      "function fix(){" +
        'var l=document.querySelectorAll("[contenteditable]"),i,n;' +
        "for(i=0;i<l.length;i++){n=l[i];" +
          'if(String(n.getAttribute("contenteditable")).toLowerCase()!=="false")' +
            'n.setAttribute("contenteditable","false");}' +
        "l=document.querySelectorAll(" + JSON.stringify(FIELD_SEL) + ");" +
        "for(i=0;i<l.length;i++){n=l[i];" +
          'try{if("readOnly" in n&&!n.readOnly)n.readOnly=true;}catch(e){}' +
          "if(n.tabIndex!==-1)n.tabIndex=-1;}" +
      "}" +
      'try{document.designMode="off";}catch(e){}' +
      "fix();" +
      "try{new MutationObserver(fix).observe(document.documentElement," +
        '{childList:true,subtree:true,attributes:true,attributeFilter:["contenteditable"]});}catch(e){}' +
      'addEventListener("DOMContentLoaded",fix);addEventListener("load",fix);' +
    "})();<\/script>";

  function spliceBeforeBodyEnd(html, chunk) {
    var i = html.lastIndexOf("</body>");
    return i < 0 ? html + chunk : html.slice(0, i) + chunk + html.slice(i);
  }

  function harden(html) {
    if (!html) return "";
    var head = /<head[^>]*>/i.exec(html);
    if (head) {
      // Style first thing in the head, so it applies before the card's own
      // script has a chance to run.
      var at = head.index + head[0].length;
      return spliceBeforeBodyEnd(html.slice(0, at) + STYLE + html.slice(at), SCRIPT);
    }
    // No <head> at all. Putting a <style> in front of the doctype would drop the
    // document into quirks mode and reflow the whole card, so both pieces go at
    // the end instead.
    return spliceBeforeBodyEnd(html, STYLE + SCRIPT);
  }

  window.StopReadonly = { harden: harden };
})();
