// ui/wizard-progress.js — the step counter + segment bar every in-page wizard
// puts above its body.
//
// Two consumers: the play importer (views/import-plays-view.js) and the chapter
// creation wizard (views/reference-guide-add-view.js). Both host it as an
// ordinary block at the top of a screen, which is what makes it shareable —
// the onboarding deck (widgets/onboarding-deck.js) draws the same shape under
// its own .ob-deck__* family and deliberately stays there: it lives inside a
// body-level overlay that owns its own layout, so the two would have had to
// grow a shared host to travel together.
//
// Markup only — no state, no lifecycle. The caller owns the step index and
// re-renders; this returns a string.

(function () {
  const BgbWizardProgress = {
    /**
     * @param {{ step: number, total: number, label?: string }} opts
     *   step  — zero-based index of the current step
     *   total — how many steps there are
     *   label — optional word for what is being counted (default "Step")
     * @returns {string} HTML for the counter + bar
     */
    render(opts) {
      const o = opts || {};
      const total = Math.max(1, Number(o.total) || 1);
      // Clamp rather than trust: a restored draft or a mid-flight step change
      // can hand this an index the current build no longer has a step for, and
      // a bar with a negative or overrun fill is worse than a clamped one.
      const step = Math.min(total - 1, Math.max(0, Number(o.step) || 0));
      const label = o.label || "Step";
      let segs = "";
      for (let n = 0; n < total; n++) {
        segs += `<div class="bgb-wizsteps__seg${n <= step ? " is-done" : ""}"></div>`;
      }
      return `
        <div class="bgb-wizsteps">
          <div class="bgb-wizsteps__count" aria-live="polite">
            ${label} <b>${step + 1}</b> of ${total}
          </div>
          <div class="bgb-wizsteps__bar">${segs}</div>
        </div>
      `;
    },
  };

  window.BgbWizardProgress = BgbWizardProgress;
})();
