// html-span-editor.js — edit the prose inside a stored HTML page without
// touching its layout, CSS, or scripts.
//
// It parses the stored HTML with DOMParser (which does NOT execute scripts) and
// opens each text-bearing element as its own small inline WYSIWYG field
// (bold / italic / link). On getHTML() the edited inline content is written
// back into the exact original nodes and the whole document is re-serialized —
// so everything outside the edited fields is preserved.
//
// Three tabs, narrow to wide:
//   Text      — block-level prose only (h1–h6, p, li, blockquote, figcaption).
//   Sections  — the above plus text-bearing containers (span, div, dt/dd, td…).
//               Deliberately hides <style>, <head>/meta, <script>, and anything
//               holding an <img class="photo"> so a photo can never be
//               clobbered by an edit.
//   Full HTML — the raw document source, no guard rails.
//
// "Load file" sits above the tabs and imports into all three at once, so you
// can load a page and go straight to editing.
//
//   const ed = HtmlSpanEditor.create(mountEl, initialHtml);
//   ed.getHTML();  // reconciled full-document HTML string
(function () {
  "use strict";

  var PA = window.PersonAdmin;
  var BLOCK_SEL = "p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption";
  // Sections adds text-bearing containers. Inline formatting tags (b/i/em/a/…)
  // are deliberately absent: as candidates they'd steal "<p>Hi <b>you</b></p>"
  // down to just "you". They stay inside the field, handled by sanitizeInline.
  var SECTION_SEL = BLOCK_SEL + ",span,div,dt,dd,td,th,caption,summary,label,address";
  // An element owning one of these is never editable — sanitizeInline would
  // strip the media out of it.
  var OPAQUE_SEL = "img,svg,canvas,video,iframe,script,style,object,embed";
  var ALLOWED = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, A: 1, BR: 1, SPAN: 1 };
  var EMPTY_DOC = "<!DOCTYPE html><html><head></head><body></body></html>";

  function escText(s) { return PA ? PA.esc(s) : String(s == null ? "" : s); }

  function parseDoc(html) {
    return new DOMParser().parseFromString(html && html.trim() ? html : EMPTY_DOC, "text/html");
  }

  function serialize(doc) {
    var dt = doc.doctype ? "<!DOCTYPE " + doc.doctype.name + ">\n" : "";
    return dt + doc.documentElement.outerHTML;
  }

  // Innermost elements matching `sel` that actually hold text. Rooted at
  // <body>, so <head>, <title> and <meta> are never reachable.
  // Note: a container mixing loose text with a candidate child — e.g.
  // "<div>Total <span>5</span></div>" — yields only the <span>; the loose
  // "Total" stays editable in the Full HTML tab.
  function collectNodes(doc, sel) {
    return Array.prototype.slice.call(doc.body.querySelectorAll(sel)).filter(function (el) {
      if (!el.textContent.trim()) return false;
      if (el.closest("style,script,template,noscript")) return false;
      if (el.querySelector(OPAQUE_SEL)) return false;
      return !Array.prototype.some.call(el.querySelectorAll(sel), function (d) {
        return d.textContent.trim();
      });
    });
  }

  // "span.cityname", "dd", "h3" — enough to tell the fields apart.
  function nodeLabel(el) {
    var name = el.tagName.toLowerCase();
    var cls = (el.getAttribute("class") || "").trim().split(/\s+/)[0];
    if (cls) return name + "." + cls;
    if (el.id) return name + "#" + el.id;
    return name;
  }

  // Keep only inline formatting tags; unwrap everything else (keep its text).
  function sanitizeInline(html) {
    var body = new DOMParser().parseFromString("<body>" + html + "</body>", "text/html").body;
    function ser(node) {
      var out = "";
      node.childNodes.forEach(function (c) {
        if (c.nodeType === 3) {
          out += escText(c.nodeValue);
        } else if (c.nodeType === 1) {
          var tag = c.tagName;
          if (tag === "BR") { out += "<br>"; return; }
          if (ALLOWED[tag]) {
            var name = tag.toLowerCase();
            var open = "<" + name;
            if (tag === "A" && c.getAttribute("href")) {
              open += ' href="' + escText(c.getAttribute("href")) + '"';
            }
            out += open + ">" + ser(c) + "</" + name + ">";
          } else {
            out += ser(c); // unwrap disallowed tag, keep its contents
          }
        }
      });
      return out;
    }
    return ser(body);
  }

  function create(mount, initialHtml) {
    var doc = parseDoc(initialHtml);
    var mode = "text";
    var lastField = null;

    mount.innerHTML =
      '<div class="hse">' +
        '<div class="pa-import">' +
          '<label class="pa-btn pa-btn--ghost pa-btn--sm pa-import__btn">Load file' +
            '<input type="file" accept=".html,text/html,.htm" hidden /></label>' +
          '<span class="pa-import__name"></span>' +
        "</div>" +
        '<div class="hse-tabs">' +
          '<button type="button" class="hse-tab hse-tab--on" data-mode="text">Text</button>' +
          '<button type="button" class="hse-tab" data-mode="sections">Sections</button>' +
          '<button type="button" class="hse-tab" data-mode="html">Full HTML</button>' +
        "</div>" +
        '<div class="hse-toolbar">' +
          '<button type="button" class="hse-tb" data-cmd="bold" title="Bold"><b>B</b></button>' +
          '<button type="button" class="hse-tb" data-cmd="italic" title="Italic"><i>I</i></button>' +
          '<button type="button" class="hse-tb" data-cmd="link" title="Add link">Link</button>' +
        "</div>" +
        '<div class="hse-pane hse-pane--text">' +
          '<div class="hse-blocks"></div>' +
        "</div>" +
        '<div class="hse-pane hse-pane--sections" hidden>' +
          '<div class="hse-blocks hse-blocks--sections"></div>' +
        "</div>" +
        '<div class="hse-pane hse-pane--html" hidden>' +
          '<textarea class="hse-source" rows="16" spellcheck="false"></textarea>' +
        "</div>" +
      "</div>";

    var sourceEl = mount.querySelector(".hse-source");
    var toolbar = mount.querySelector(".hse-toolbar");
    var textPane = mount.querySelector(".hse-pane--text");
    var sectionsPane = mount.querySelector(".hse-pane--sections");
    var htmlPane = mount.querySelector(".hse-pane--html");

    // One block pane: renders a contenteditable field per collected node and
    // writes the edits back into those same live nodes.
    function makeBlockView(container, sel, emptyHint) {
      var nodes = [];

      function render() {
        if (!nodes.length) {
          container.innerHTML = '<p class="hse-empty">' + escText(emptyHint) + "</p>";
          return;
        }
        container.innerHTML = nodes.map(function (el, i) {
          return '<div class="hse-block">' +
            '<span class="hse-block__tag">' + escText(nodeLabel(el)) + "</span>" +
            '<div class="hse-block__field" contenteditable="true" data-idx="' + i + '">' +
              el.innerHTML +
            "</div></div>";
        }).join("");
        container.querySelectorAll(".hse-block__field").forEach(function (f) {
          f.addEventListener("focus", function () { lastField = f; });
        });
      }

      return {
        rebuild: function (d) { nodes = collectNodes(d, sel); render(); },
        reconcile: function () {
          container.querySelectorAll(".hse-block__field").forEach(function (f) {
            var idx = Number(f.getAttribute("data-idx"));
            if (nodes[idx]) nodes[idx].innerHTML = sanitizeInline(f.innerHTML);
          });
        },
      };
    }

    var textView = makeBlockView(
      mount.querySelector(".hse-pane--text .hse-blocks"),
      BLOCK_SEL,
      "No text blocks detected. Use “Load file” above, or paste a page into the Full HTML tab."
    );
    var sectionView = makeBlockView(
      mount.querySelector(".hse-blocks--sections"),
      SECTION_SEL,
      "No editable sections detected. Use “Load file” above, or paste a page into the Full HTML tab."
    );

    function activeView() { return mode === "sections" ? sectionView : textView; }

    function switchMode(m, tab) {
      if (m === mode) return;
      // Flush the pane we're leaving into `doc` before rebuilding the next one.
      if (mode === "html") doc = parseDoc(sourceEl.value);
      else activeView().reconcile();
      mode = m;
      if (m === "html") sourceEl.value = serialize(doc);
      else activeView().rebuild(doc);
      mount.querySelectorAll(".hse-tab").forEach(function (t) {
        t.classList.toggle("hse-tab--on", t === tab);
      });
      textPane.hidden = m !== "text";
      sectionsPane.hidden = m !== "sections";
      htmlPane.hidden = m !== "html";
      toolbar.hidden = m === "html";
    }

    mount.querySelectorAll(".hse-tab").forEach(function (tab) {
      tab.addEventListener("click", function () { switchMode(tab.getAttribute("data-mode"), tab); });
    });

    // Toolbar acts on the focused field. mousedown-preventDefault keeps focus.
    toolbar.addEventListener("mousedown", function (e) { e.preventDefault(); });
    toolbar.querySelectorAll(".hse-tb").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (!lastField) return;
        lastField.focus();
        var cmd = btn.getAttribute("data-cmd");
        if (cmd === "link") {
          var url = window.prompt("Link URL:");
          if (url) document.execCommand("createLink", false, url);
        } else {
          document.execCommand(cmd, false, null);
        }
      });
    });

    // File import → every pane at once, so you can load and edit without a
    // round-trip through the Full HTML tab.
    var fileInp = mount.querySelector(".pa-import input[type=file]");
    var nameEl = mount.querySelector(".pa-import__name");
    fileInp.addEventListener("change", function () {
      var file = fileInp.files && fileInp.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var txt = String(reader.result || "");
        sourceEl.value = txt;
        doc = parseDoc(txt);
        textView.rebuild(doc);
        sectionView.rebuild(doc);
        if (nameEl) nameEl.textContent = file.name;
      };
      reader.onerror = function () { window.alert("Could not read that file."); };
      reader.readAsText(file);
    });

    sourceEl.value = initialHtml || "";
    textView.rebuild(doc);
    sectionView.rebuild(doc);

    function getHTML() {
      if (mode === "html") return sourceEl.value;
      activeView().reconcile();
      return serialize(doc);
    }

    // True when the reconciled document has any body text or elements.
    function hasContent() {
      var probe = parseDoc(getHTML());
      return !!(probe.body.textContent.trim() || probe.body.children.length);
    }

    return { getHTML: getHTML, hasContent: hasContent };
  }

  window.HtmlSpanEditor = { create: create };
})();
