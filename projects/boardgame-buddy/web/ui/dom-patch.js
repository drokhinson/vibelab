// ui/dom-patch.js — patch a live DOM subtree towards freshly rendered markup,
// touching only the nodes that actually differ.
//
// Why this exists: every render surface in this app hands back an HTML STRING,
// and the cheap way to apply one is `host.innerHTML = html`. That tears down and
// rebuilds every node underneath, even the ones whose markup is identical — so a
// photo <img> re-decodes and visibly blinks, a card replays its entrance
// animation, a scroller loses its position, :active is lost out from under a
// finger mid-press (mobile-web.md §5), and every icon has to be re-hydrated. On
// a surface that paints from a local seed and then repaints from a confirming
// fetch a second later, the user watches all of that happen to a card they are
// already looking at.
//
// morph() walks the live tree against the new one and writes only differences:
// changed text, changed attributes, added and removed nodes. Everything else
// keeps its identity, which is what keeps the image, the scroll offset, the
// press state and the caret.
//
// API:
//   window.BgbDomPatch.morph(liveRoot, html)   — patch liveRoot's CHILDREN
//
// Four things about this file are load-bearing:
//
// 1. A generic reconciler is the right shape HERE specifically because every
//    handler in this codebase is an inline `onclick`/`oninput` ATTRIBUTE. The
//    usual objection to morphing — that you must re-attach listeners to
//    preserved nodes — does not apply; handlers ride along as attributes like
//    any other. web-frontend.md's prescribed alternative (a stable host element
//    per region plus a structural-vs-field diff) assumes bound listeners, and on
//    a card that is eight optional data-shaped regions it is eight host/binding
//    pairs against this one file.
//
// 2. Namespaces. mobile-web.md §4: never set innerHTML on an SVG-namespaced
//    element — WebKit builds HTML <path> nodes that lay out as nothing. This
//    file parses ONCE, into a plain detached <div>, so <svg> goes through the
//    HTML parser's foreign-content path and lands in the SVG namespace; and it
//    only ever MOVES nodes out of that parsed tree, never constructs them. Node
//    identity is compared on nodeName AND namespaceURI, and `class` on an SVG is
//    written with setAttribute (`el.className` there is a read-only
//    SVGAnimatedString).
//
// 3. The freshly rendered markup is authoritative for `value` and `checked`.
//    Those are PROPERTIES, and they part company from their attributes the
//    moment a user touches the control — so attribute syncing alone is not
//    enough. This reproduces what innerHTML + restoreFocus does today: a
//    round-score cell typed as "5x" still snaps back to the sanitized "5", and a
//    Won checkbox still follows autoSelectWinners. A control the template
//    renders with NO `value` attribute is treated as uncontrolled and keeps what
//    is in it — a search box the user has typed into keeps their query across a
//    repaint of the list beneath it.
//
// 4. morph() syncs liveRoot's CHILDREN and never liveRoot's own attributes.
//    The host belongs to its owner — a BgbModal backdrop, a list host — and the
//    markup only owns what goes inside it.
//
// Matching is positional by default. A container whose element children ALL
// carry `data-morph-key` is matched by key instead, so a conditional block
// appearing or disappearing cannot slide its siblings by one and pair an <img>
// against a <section> — which would replace the very node this file exists to
// preserve. Keys never imply a reorder in practice, and deliberately so:
// re-parenting a focused element blurs it.

// @ts-check

(function () {
  const ELEMENT = 1;
  const TEXT = 3;
  const COMMENT = 8;

  /**
   * Patch `root`'s children towards `html`.
   *
   * @param {Element|null} root the live host. Its own attributes are left alone.
   * @param {string} html what its children should end up matching.
   */
  function morph(root, html) {
    if (!root) return;
    const next = document.createElement("div");
    next.innerHTML = html;
    // Hydrate icons on the NEW tree before comparing anything. BgbIcons swaps
    // each `<i data-icon>` placeholder for an inline <svg data-icon-name>, so
    // the live DOM never holds the <i> a template emits — without this pass
    // every icon reads as a tag mismatch and is rebuilt on every morph. Glyphs
    // are built once per name and cloned (ui/icons.js), and render() takes any
    // ParentNode, detached ones included, so this is cheap.
    if (window.BgbIcons) window.BgbIcons.render(next);
    patchChildren(root, next);
  }

  /** @param {Node} node @returns {string|null} */
  function keyOf(node) {
    return node.nodeType === ELEMENT
      ? /** @type {Element} */ (node).getAttribute("data-morph-key")
      : null;
  }

  /**
   * True when every ELEMENT child carries a key — the container has opted in
   * wholesale. A partially keyed container falls back to positional rather than
   * guessing, because a half-keyed match is worse than no match.
   * @param {Node[]} nodes
   */
  function fullyKeyed(nodes) {
    let seen = 0;
    for (const n of nodes) {
      if (n.nodeType !== ELEMENT) continue;
      if (!keyOf(n)) return false;
      seen++;
    }
    return seen > 0;
  }

  /** Can `cur` be patched into `nu`, or does it have to be replaced? */
  function compatible(cur, nu) {
    return cur.nodeType === nu.nodeType
      && cur.nodeName === nu.nodeName
      && cur.namespaceURI === nu.namespaceURI;
  }

  /** @param {Node} oldParent @param {Node} newParent */
  function patchChildren(oldParent, newParent) {
    // Snapshot both lists: childNodes is live, and adopting a node out of
    // newParent removes it from that list mid-walk.
    const olds = Array.prototype.slice.call(oldParent.childNodes);
    const news = Array.prototype.slice.call(newParent.childNodes);
    if (fullyKeyed(olds) && fullyKeyed(news)) {
      patchKeyed(oldParent, olds, news);
      return;
    }
    const n = Math.max(olds.length, news.length);
    for (let i = 0; i < n; i++) {
      const cur = olds[i];
      const nu = news[i];
      if (!nu) { oldParent.removeChild(cur); continue; }
      // Appended in ascending index order, so this lands in the right place.
      if (!cur) { oldParent.appendChild(nu); continue; }
      if (!compatible(cur, nu)) { oldParent.replaceChild(nu, cur); continue; }
      patchSame(cur, nu);
    }
  }

  /**
   * Key-matched reconcile. Element children pair by `data-morph-key`; the
   * whitespace and comment nodes between them are unkeyed by nature and pair
   * positionally among themselves.
   *
   * @param {Node} parent @param {Node[]} olds @param {Node[]} news
   */
  function patchKeyed(parent, olds, news) {
    const byKey = new Map();
    for (const o of olds) {
      const k = keyOf(o);
      if (k && !byKey.has(k)) byKey.set(k, o);
    }
    const plain = olds.filter((o) => o.nodeType !== ELEMENT);
    let plainAt = 0;
    const kept = new Set();
    /** The children `parent` should end up holding, in order. */
    const want = [];

    for (const nu of news) {
      const cur = nu.nodeType === ELEMENT
        ? byKey.get(keyOf(nu))
        : plain[plainAt++];
      if (cur && !kept.has(cur) && compatible(cur, nu)) {
        kept.add(cur);
        patchSame(cur, nu);
        want.push(cur);
      } else {
        want.push(nu);
      }
    }

    for (const o of olds) {
      if (!kept.has(o) && o.parentNode === parent) parent.removeChild(o);
    }
    // Place each survivor and each newcomer at its index. A survivor already in
    // position is skipped, so nothing that did not move is re-parented.
    for (let i = 0; i < want.length; i++) {
      const at = parent.childNodes[i];
      if (at !== want[i]) parent.insertBefore(want[i], at || null);
    }
  }

  /**
   * Patch two nodes already known to be of the same kind.
   * @param {Node} cur the live node @param {Node} nu its counterpart
   */
  function patchSame(cur, nu) {
    if (cur.nodeType === TEXT || cur.nodeType === COMMENT) {
      if (cur.nodeValue !== nu.nodeValue) cur.nodeValue = nu.nodeValue;
      return;
    }
    if (cur.nodeType !== ELEMENT) return;
    const curEl = /** @type {Element} */ (cur);
    const nuEl = /** @type {Element} */ (nu);

    // A hydrated icon of the same name at the same size is the same drawing.
    // Skipping the subtree is the difference between walking a handful of nodes
    // and walking every <path> of every glyph on the card.
    const icon = curEl.getAttribute("data-icon-name");
    if (icon
        && nuEl.getAttribute("data-icon-name") === icon
        && curEl.getAttribute("class") === nuEl.getAttribute("class")) {
      return;
    }

    patchAttributes(curEl, nuEl);

    if (curEl.tagName === "TEXTAREA") {
      // Its live text child is the DEFAULT value, not what the user has typed —
      // the dirty-value flag makes the two independent. syncValue owns the
      // current one, so recursing would only rewrite a node nothing reads.
      syncValue(/** @type {any} */ (curEl), nuEl.textContent || "");
      return;
    }
    syncFormState(curEl, nuEl);
    patchChildren(curEl, nuEl);
  }

  /** @param {Element} cur @param {Element} nu */
  function patchAttributes(cur, nu) {
    const wanted = nu.attributes;
    for (let i = 0; i < wanted.length; i++) {
      const a = wanted[i];
      if (cur.getAttribute(a.name) !== a.value) cur.setAttribute(a.name, a.value);
    }
    // Backwards: removeAttribute mutates the live NamedNodeMap being walked.
    const held = cur.attributes;
    for (let i = held.length - 1; i >= 0; i--) {
      const name = held[i].name;
      if (!nu.hasAttribute(name)) cur.removeAttribute(name);
    }
  }

  /** @param {Element} cur @param {Element} nu */
  function syncFormState(cur, nu) {
    const tag = cur.tagName;
    if (tag === "INPUT") {
      const input = /** @type {any} */ (cur);
      const type = (cur.getAttribute("type") || "text").toLowerCase();
      // A file input's value is not ours to write — assigning a non-empty one
      // throws, and the picked file is state no render can reproduce.
      if (type === "file") return;
      if (type === "checkbox" || type === "radio") {
        const on = nu.hasAttribute("checked");
        if (input.checked !== on) input.checked = on;
        return;
      }
      // No `value` attribute at all means the field is uncontrolled — the
      // add-player input, whose half-typed name must survive a repaint it did
      // not cause.
      if (!nu.hasAttribute("value")) return;
      syncValue(input, nu.getAttribute("value") || "");
      return;
    }
    if (tag === "OPTION") {
      const opt = /** @type {any} */ (cur);
      const on = nu.hasAttribute("selected");
      if (opt.selected !== on) opt.selected = on;
    }
  }

  /**
   * Write a control's value, keeping the caret where the user left it.
   *
   * Only reached when the markup and the live property actually disagree, which
   * for a focused field means the render corrected what was typed. Clamped to
   * the new length so a shortened value cannot throw.
   *
   * @param {any} el @param {string} want
   */
  function syncValue(el, want) {
    if (el.value === want) return;
    const focused = el === document.activeElement;
    // selectionStart reads null on some input types (number, date); guard it
    // the same way helpers.js's restoreFocus does.
    const start = focused ? el.selectionStart : null;
    const end = focused ? el.selectionEnd : null;
    el.value = want;
    if (start == null || !el.setSelectionRange) return;
    try {
      el.setSelectionRange(
        Math.min(start, want.length),
        Math.min(end == null ? start : end, want.length)
      );
    } catch (_) {}
  }

  window.BgbDomPatch = { morph };
})();
