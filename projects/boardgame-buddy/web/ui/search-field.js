// ui/search-field.js — the × that clears a search box, once, for every search
// box in the app.
//
// Five surfaces had already grown their own copy of this — the import popup's
// filter, the Gather expansion filter, and the shelf / game-picker / player-
// picker sheets — each with its own `data-*-action` spelling, its own clear
// method and its own "keep the × in sync with the query" call that the next
// surface had to remember to write. Three of the app's search boxes had no ×
// at all. That is instance #5 of one lifecycle, which is well past the point
// `.claude/rules/ui-object-design.md` §4 says to extract.
//
// WHAT IS SHARED IS THE LIFECYCLE, NOT THE LOOK. Two delegated document
// listeners drive every field:
//
//   * `input` inside a `[data-search-host]` shows or hides that host's ×.
//   * a click on the × empties the input, repaints, **dispatches a real
//     `input` event**, and puts focus back in the box.
//
// That dispatch is the whole trick: every call site already has an input
// handler — an inline `oninput`, an `addEventListener`, a debounced search —
// and a synthetic event runs it unchanged. So no screen needs a clear path of
// its own, and a field added later gets the × by wearing the two attributes.
//
// Delegation on `document` rather than per-field binding is not a shortcut
// either: nearly every host in this app repaints by replacing `innerHTML`, so
// a bound listener would have to be re-attached after each paint and one
// forgotten call site is a dead ×.
//
// Two entry points, because hosts differ in how much chrome they own:
//
//   render()      — the whole field (optional magnifier, input, ×), for a
//                   plain search box that had no wrapper of its own.
//   clearButton() — the × alone, for a host that already draws its own field
//                   (`.game-finder`, the parchment scroll's search row). Those
//                   add `data-search-host` to the wrapper they already have.

// @ts-check

(function () {
  const HOST_ATTR = "data-search-host";
  const CLEAR_SEL = "[data-search-clear]";

  /**
   * @typedef {Object} SearchFieldOpts
   * @property {string} id            Input id. Required — call sites restore
   *   focus by id across a repaint, and it is what the field is addressed by.
   * @property {string} [value]       Current query; decides the ×'s initial state.
   * @property {string} [placeholder]
   * @property {string} [ariaLabel]   Defaults to the placeholder.
   * @property {string} [clearLabel]  The ×'s accessible name. Default "Clear search".
   * @property {string} [oninput]     Inline JS, as the call sites here already use.
   * @property {string} [onkeydown]
   * @property {string} [onblur]
   * @property {string} [cls]         Extra classes on the wrapper.
   * @property {string} [inputCls]    Extra classes on the input.
   * @property {boolean} [icon]       Leading magnifier. Default false — only
   *   the surfaces that already drew one pass true, so no existing screen
   *   changes shape for this.
   * @property {string} [autocapitalize] Default "off"; the player picker wants "words".
   */

  /**
   * The × alone. For a host that already owns its field markup — it needs
   * `data-search-host` on the wrapper and exactly one `<input>` inside it.
   *
   * `onmousedown` is prevented so the tap doesn't blur the input on its way to
   * the click: without it the software keyboard closes and re-opens, which
   * reads as the field being torn down and rebuilt.
   *
   * @param {{label?: string, value?: string}} [opts]
   * @returns {string}
   */
  function clearButton({ label = "Clear search", value = "" } = {}) {
    return `
      <button type="button" class="field-clear-btn" data-search-clear
              aria-label="${escapeAttr(label)}"
              onmousedown="event.preventDefault()"${value ? "" : " hidden"}>
        <i data-icon="x" class="w-4 h-4"></i>
      </button>`;
  }

  /**
   * A whole search field: wrapper, optional magnifier, input, ×.
   * @param {SearchFieldOpts} opts
   * @returns {string}
   */
  function render(opts) {
    const o = opts || /** @type {SearchFieldOpts} */ ({});
    if (!o.id) throw new Error("BgbSearchField.render: id is required");
    const value = o.value || "";
    const label = o.ariaLabel || o.placeholder || "Search";
    const attr = (name, v) => (v ? ` ${name}="${escapeAttr(v)}"` : "");
    return `
      <div class="search-field${o.icon ? " search-field--icon" : ""}${o.cls ? " " + o.cls : ""}" ${HOST_ATTR}>
        ${o.icon ? `<i data-icon="search" class="w-4 h-4 search-field__icon"></i>` : ""}
        <input type="text" id="${escapeAttr(o.id)}"
               class="input input-bordered search-field__input${o.inputCls ? " " + o.inputCls : ""}"
               placeholder="${escapeAttr(o.placeholder || "")}"
               aria-label="${escapeAttr(label)}"
               value="${escapeAttr(value)}"
               autocomplete="off" autocapitalize="${escapeAttr(o.autocapitalize || "off")}"
               autocorrect="off" spellcheck="false"${attr("oninput", o.oninput)}${attr("onkeydown", o.onkeydown)}${attr("onblur", o.onblur)} />
        ${clearButton({ label: o.clearLabel || "Clear search", value })}
      </div>`;
  }

  /** The × inside `host`, if it has one. @param {Element} host */
  function _btn(host) {
    return /** @type {HTMLElement|null} */ (host.querySelector(CLEAR_SEL));
  }

  /** @param {Element} host @param {string} value */
  function _paint(host, value) {
    const btn = _btn(host);
    if (btn) btn.hidden = !value;
  }

  /**
   * Empty a field and tell its owner. The `input` event is deliberately real
   * and bubbling: it is what runs the call site's own handler, so clearing
   * needs no per-screen code.
   *
   * @param {HTMLInputElement|null} input
   */
  function clearInput(input) {
    if (!input) return;
    const id = input.id;
    input.value = "";
    const host = input.closest(`[${HOST_ATTR}]`);
    if (host) _paint(host, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // Re-resolve by id before focusing. Several call sites repaint their whole
    // shell from the input handler above, which detaches the very node we were
    // handed — focusing that would silently do nothing and drop the user out
    // of the field they just cleared. (This is the reason every search field
    // in the app carries a stable id; see .claude/rules/web-frontend.md.)
    const live = id ? document.getElementById(id) : null;
    const target = /** @type {HTMLElement|null} */ (live || (input.isConnected ? input : null));
    if (target) { try { target.focus(); } catch (_) {} }
  }

  /**
   * Clear whichever field lives under `el` — a host element, or anything
   * inside one. For an Escape handler that wants to back out of the search
   * before closing its sheet.
   *
   * @param {Element|null} el
   */
  function clear(el) {
    if (!el) return;
    const host = el.matches && el.matches(`[${HOST_ATTR}]`)
      ? el
      : (el.closest && el.closest(`[${HOST_ATTR}]`)) || el.querySelector(`[${HOST_ATTR}]`);
    if (!host) return;
    clearInput(/** @type {HTMLInputElement|null} */ (host.querySelector("input")));
  }

  /**
   * Re-derive every ×'s state under `root` from its input's current value.
   * Only needed where a host repaints its field markup without going through
   * render() — the rendered form already carries the right initial state, and
   * the `input` listener keeps it there afterwards.
   *
   * @param {ParentNode} [root]
   */
  function sync(root) {
    const scope = root || document;
    for (const host of scope.querySelectorAll(`[${HOST_ATTR}]`)) {
      const input = /** @type {HTMLInputElement|null} */ (host.querySelector("input"));
      _paint(host, (input && input.value) || "");
    }
  }

  // ── The two delegated listeners ───────────────────────────────────────────

  document.addEventListener("input", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (!t || !t.closest) return;
    const host = t.closest(`[${HOST_ATTR}]`);
    if (!host) return;
    _paint(host, /** @type {HTMLInputElement} */ (t).value || "");
  });

  // Capture, and the click stops here: the × sits inside sheets and rows whose
  // own delegated handlers would otherwise read the tap as "pick this row".
  document.addEventListener("click", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (!t || !t.closest) return;
    const btn = t.closest(CLEAR_SEL);
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const host = btn.closest(`[${HOST_ATTR}]`);
    if (!host) return;
    clearInput(/** @type {HTMLInputElement|null} */ (host.querySelector("input")));
  }, true);

  window.BgbSearchField = { render, clearButton, clear, clearInput, sync };
})();
