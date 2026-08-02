// html-span-editor.js — edit the prose inside a stored HTML page without
// touching its layout, CSS, or scripts.
//
// It parses the stored HTML with DOMParser (which does NOT execute scripts),
// pulls out the block-level text elements (h1–h6, p, li, blockquote,
// figcaption), and opens each as its own small inline WYSIWYG field
// (bold / italic / link). On getHTML() the edited inline content is written
// back into the exact original nodes and the whole document is re-serialized —
// so everything outside the edited spans is preserved.
//
// An "Advanced (HTML)" tab exposes the raw source + a "Load file" import for
// full control / pasting a brand-new page.
//
//   const ed = HtmlSpanEditor.create(mountEl, initialHtml);
//   ed.getHTML();  // reconciled full-document HTML string
(function () {
  "use strict";

  var PA = window.PersonAdmin;
  var BLOCK_SEL = "p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption";
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

  // Innermost block-level text elements that actually contain text.
  function editableNodes(doc) {
    return Array.prototype.slice.call(doc.body.querySelectorAll(BLOCK_SEL))
      .filter(function (el) {
        return el.textContent.trim() && !el.querySelector(BLOCK_SEL);
      });
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
    var editables = editableNodes(doc);
    var mode = "text";
    var lastField = null;

    mount.innerHTML =
      '<div class="hse">' +
        '<div class="hse-tabs">' +
          '<button type="button" class="hse-tab hse-tab--on" data-mode="text">Text</button>' +
          '<button type="button" class="hse-tab" data-mode="html">Advanced (HTML)</button>' +
        "</div>" +
        '<div class="hse-pane hse-pane--text">' +
          '<div class="hse-toolbar">' +
            '<button type="button" class="hse-tb" data-cmd="bold" title="Bold"><b>B</b></button>' +
            '<button type="button" class="hse-tb" data-cmd="italic" title="Italic"><i>I</i></button>' +
            '<button type="button" class="hse-tb" data-cmd="link" title="Add link">Link</button>' +
          "</div>" +
          '<div class="hse-blocks"></div>' +
        "</div>" +
        '<div class="hse-pane hse-pane--html" hidden>' +
          '<div class="pa-import">' +
            '<label class="pa-btn pa-btn--ghost pa-btn--sm pa-import__btn">Load file' +
              '<input type="file" accept=".html,text/html,.htm" hidden /></label>' +
            '<span class="pa-import__name"></span>' +
          "</div>" +
          '<textarea class="hse-source" rows="16" spellcheck="false"></textarea>' +
        "</div>" +
      "</div>";

    var blocksEl = mount.querySelector(".hse-blocks");
    var sourceEl = mount.querySelector(".hse-source");
    var toolbar = mount.querySelector(".hse-toolbar");
    var textPane = mount.querySelector(".hse-pane--text");
    var htmlPane = mount.querySelector(".hse-pane--html");

    function renderBlocks() {
      if (!editables.length) {
        blocksEl.innerHTML =
          '<p class="hse-empty">No text blocks detected. Paste HTML or use “Load file” ' +
          'in the Advanced tab, then switch back here to edit the text.</p>';
        return;
      }
      blocksEl.innerHTML = editables.map(function (el, i) {
        return '<div class="hse-block">' +
          '<span class="hse-block__tag">' + escText(el.tagName.toLowerCase()) + "</span>" +
          '<div class="hse-block__field" contenteditable="true" data-idx="' + i + '">' +
            el.innerHTML +
          "</div></div>";
      }).join("");
      blocksEl.querySelectorAll(".hse-block__field").forEach(function (f) {
        f.addEventListener("focus", function () { lastField = f; });
      });
    }

    // Write each field's (sanitized) inline HTML back into its source node.
    function reconcileToDoc() {
      blocksEl.querySelectorAll(".hse-block__field").forEach(function (f) {
        var idx = Number(f.getAttribute("data-idx"));
        if (editables[idx]) editables[idx].innerHTML = sanitizeInline(f.innerHTML);
      });
    }

    function syncFromSource() {
      doc = parseDoc(sourceEl.value);
      editables = editableNodes(doc);
      renderBlocks();
    }

    function switchMode(m, tab) {
      if (m === mode) return;
      if (m === "html") { reconcileToDoc(); sourceEl.value = serialize(doc); }
      else { syncFromSource(); }
      mode = m;
      mount.querySelectorAll(".hse-tab").forEach(function (t) {
        t.classList.toggle("hse-tab--on", t === tab);
      });
      textPane.hidden = m !== "text";
      htmlPane.hidden = m !== "html";
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

    // Advanced-tab file import → raw source.
    var fileInp = htmlPane.querySelector("input[type=file]");
    fileInp.addEventListener("change", function () {
      var file = fileInp.files && fileInp.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        sourceEl.value = String(reader.result || "");
        var nm = htmlPane.querySelector(".pa-import__name");
        if (nm) nm.textContent = file.name;
      };
      reader.onerror = function () { window.alert("Could not read that file."); };
      reader.readAsText(file);
    });

    sourceEl.value = initialHtml || "";
    renderBlocks();

    function getHTML() {
      if (mode === "html") return sourceEl.value;
      reconcileToDoc();
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
