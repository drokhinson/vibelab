// ui/bgg-log-step.js — one step row of a BGG progress log.
//
// Promoted out of ui/bgg-import-log.js when the push log needed the same
// markup (.claude/rules/ui-object-design.md §4: extract at instance #2). Both
// logs narrate a different sequence, but a step is a step — same icon states,
// same shape, same CSS.

(function () {
  /**
   * `error` exists because a step that finished and achieved nothing is not a
   * done step. A push where every write was refused used to draw a checkmark
   * beside "Sent every change to BoardGameGeek".
   *
   * @param {"done"|"active"|"idle"|"error"} state
   * @param {string} body  already-escaped HTML for the step's text
   * @returns {string}
   */
  function bggLogStep(state, body) {
    const icon = state === "done"
      ? `<i data-icon="check" class="bgg-log__icon"></i>`
      : state === "error"
        ? `<i data-icon="alert-triangle" class="bgg-log__icon bgg-log__icon--error"></i>`
        : state === "active"
          ? `<i data-icon="loader-2" class="bgg-log__icon bgg-log__icon--spin"></i>`
          : `<span class="bgg-log__icon bgg-log__icon--idle"></span>`;
    return `<li class="bgg-log__step bgg-log__step--${state}">${icon}<span class="bgg-log__body">${body}</span></li>`;
  }

  window.bggLogStep = bggLogStep;
})();
