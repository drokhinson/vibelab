// ui/switch.js — the on/off switch, once, for every surface that flips a
// boolean the user can see the effect of.
//
// Two call sites today: the collection's "Show all expansions" (which grew the
// original markup as `.exp-tree__switch`) and the scoring card's template bar,
// which turns a scoring grid's labelled rows on and off over the plain R1..Rn
// table. That is instance #2 of one control, which is the moment
// `.claude/rules/ui-object-design.md` §4 names for extracting rather than
// copying — the geometry is fiddly enough (a track that has to stay a
// consistent size while the knob's travel is derived from it) that a second
// hand-written copy would drift on the first tweak to either.
//
// WHAT IS SHARED IS THE CONTROL, NOT THE PALETTE. The switch lands on two
// different kinds of surface — the collection is chrome, the scoring card is
// paper, and paper is light in both themes (`.claude/rules/theming.md` §6) — so
// the class family carries a `--paper` variant that re-points the three colours
// it needs at the `--polaroid-*` family. Every other rule is shared.
//
// A BUTTON, NOT A CHECKBOX. `role="switch"` + `aria-checked` is the ARIA
// pattern for an on/off control whose effect is immediate; a checkbox would
// promise a form to submit. The caller supplies inline JS for the tap, which is
// how every other render helper in this app is driven — the hosts here repaint
// by replacing `innerHTML`, so a bound listener would need re-attaching after
// each paint.

// @ts-check

(function () {
  /**
   * @typedef {Object} SwitchOpts
   * @property {boolean} on          Current state; drives `is-on` + aria-checked.
   * @property {string} onclick      Inline JS run on tap.
   * @property {string} [label]      Visible text beside the track. Omit for a
   *   bare switch, and then pass `ariaLabel` — a control with no accessible
   *   name is unusable by a screen reader.
   * @property {string} [ariaLabel]  Accessible name. Defaults to `label`.
   * @property {string} [title]      Tooltip / long-press hint.
   * @property {boolean} [paper]     Paper palette (`--polaroid-*`) instead of
   *   the ground one. True on any photo-paper surface — a polaroid, the
   *   parchment scroll, the cream scorepad.
   * @property {boolean} [compact]   Smaller track for a dense strip. Keeps the
   *   44px target with an inset ::before rather than by growing the row —
   *   the same move `.scoring-tplbar__btn` beside it makes.
   * @property {string} [cls]        Extra classes on the button.
   */

  /**
   * @param {SwitchOpts} opts
   * @returns {string}
   */
  function render(opts) {
    const o = opts || /** @type {SwitchOpts} */ ({});
    const on = !!o.on;
    const name = o.ariaLabel || o.label || "";
    const cls = [
      "bgb-switch",
      on ? "is-on" : "",
      o.paper ? "bgb-switch--paper" : "",
      o.compact ? "bgb-switch--compact" : "",
      o.cls || "",
    ].filter(Boolean).join(" ");
    return `
      <button type="button" role="switch" aria-checked="${on}"
              class="${cls}"
              ${name ? `aria-label="${escapeAttr(name)}"` : ""}
              ${o.title ? `title="${escapeAttr(o.title)}"` : ""}
              onclick="${o.onclick}">
        <span class="bgb-switch__track"><span class="bgb-switch__knob"></span></span>
        ${o.label ? `<span class="bgb-switch__label">${escapeHtml(o.label)}</span>` : ""}
      </button>`;
  }

  window.BgbSwitch = { render };
})();
