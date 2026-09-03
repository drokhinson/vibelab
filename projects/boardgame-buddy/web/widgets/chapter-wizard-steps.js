// @ts-check
// widgets/chapter-wizard-steps.js — the first two steps of the chapter
// creation wizard.
//
// Pure functions of the view's state: each takes a plain snapshot object and
// returns an HTML string, touching nothing. The view
// (views/reference-guide-add-view.js) owns the state, the fetches and the
// events — same shell/bodies split as import-plays-view.js /
// import-plays-steps.js, along the same seam: what a step IS versus how the
// wizard moves between them.
//
// Step 3 is the markdown editor and deliberately stays in the view: it is not
// a pure function of state — the toolbar reads and writes the live textarea's
// selection, and the popovers restore a caret the re-render destroyed.
//
// Handlers are inline `onclick="window.referenceGuideAddView._foo()"` strings —
// the project idiom, and what keeps these functions pure. Ids that could carry
// anything but a slug go through jsStr THEN escapeAttr; see helpers.js.

(function () {
  const V = "window.referenceGuideAddView";
  /** A handler attribute for a call with one string argument. */
  const call = (method, arg) => escapeAttr(`${V}.${method}('${jsStr(arg)}')`);

  // ── Step 1: pick a chapter type ────────────────────────────────────────────
  //
  // The type is the one thing the rest of the wizard is built on — the AI step
  // can't draft without it and Save can't post without it — so it gets a step
  // of its own rather than a pill scroller competing with a title field.
  //
  // Full-width 56px rows, not the old horizontal pills: a row list is the
  // shape the picker sheets already use for "choose exactly one of six", it
  // needs no scroll to see every option, and it leaves room for the type's
  // own description.
  //
  // @param {{types: Array, formType: string, targetSelector: string}} s
  function renderTypeStep(s) {
    const rows = s.types.map((t) => {
      const on = t.id === s.formType;
      return `
        <button type="button" role="radio" aria-checked="${on ? "true" : "false"}"
                class="chapter-wiz__type ${on ? "chapter-wiz__type--on" : ""}"
                onclick="${call("_pickType", t.id)}">
          <span class="chapter-wiz__type-mark">
            <i data-icon="${escapeAttr(t.icon || "book")}" class="w-5 h-5"></i>
          </span>
          <span class="chapter-wiz__type-label">${escapeHtml(t.label)}</span>
          <span class="chapter-wiz__type-tick">
            ${on ? `<i data-icon="check" class="w-4 h-4"></i>` : ""}
          </span>
        </button>
      `;
    }).join("");

    // No types means the /chapter-types fetch failed (onMount swallows it to a
    // []). Saying so beats a step with a heading and nothing under it.
    const body = rows
      ? `<div class="chapter-wiz__types" role="radiogroup" aria-label="Chapter type">${rows}</div>`
      : `<p class="chapter-wiz__lede">Couldn't load the chapter types. Check your connection and try again.</p>`;

    return `
      <div class="chapter-wiz__step">
        <h3 class="chapter-wiz__title font-display">What kind of chapter?</h3>
        <p class="chapter-wiz__lede">
          One chapter answers one question. Pick the slice of the rules this one covers.
        </p>
        ${s.targetSelector}
        ${body}
      </div>
    `;
  }

  // ── Step 2: the optional head start ────────────────────────────────────────
  //
  // One idea per step: this one is a prompt box and a decision. Both ways
  // forward live in the footer (Skip / Generate, see _renderWizardFooter) —
  // nothing here is a button, so the step reads as "say what you want, or
  // don't". Importing a file used to live here too; it fills the editor rather
  // than steering the AI, so it moved to the editor's own toolbar on step 3.
  //
  // The picked-type row carries a Change link because the footer no longer has
  // a Back: it is the same markup step 3 renders, so changing your mind about
  // the type is one tap from either step. (The device back gesture still steps
  // back too — _wizBack is unchanged.)
  //
  // @param {{typeLabel: string, typeIcon: string, genPrompt: string,
  //          generating: boolean, saving: boolean, error: ?string}} s
  function renderDraftStep(s) {
    const busy = s.generating || s.saving;

    return `
      <div class="chapter-wiz__step">
        <h3 class="chapter-wiz__title font-display">Want a head start?</h3>
        <p class="chapter-wiz__lede">
          Have the AI draft this chapter for you, or skip and write it yourself.
          Nothing is saved until you hit Save on the next step.
        </p>

        <div class="chapter-wiz__picked">
          <span class="chapter-wiz__typechip">
            <i data-icon="${escapeAttr(s.typeIcon || "book")}" class="w-3 h-3"></i>
            ${escapeHtml(s.typeLabel)}
          </span>
          <button type="button" class="chapter-wiz__change"
                  ${busy ? "disabled" : ""}
                  onclick="${V}._goToStep(0)">Change</button>
        </div>

        <label class="chapter-wiz__field">
          <span class="chapter-wiz__label">What should it focus on? <em>(optional)</em></span>
          <textarea id="chapter-gen-prompt"
                    class="chapter-wiz__prompt"
                    rows="3" maxlength="500"
                    ${busy ? "disabled" : ""}
                    spellcheck="true"
                    oninput="${V}._genPrompt = this.value"
                    placeholder="e.g. just the endgame trigger and how final scoring works">${escapeHtml(s.genPrompt)}</textarea>
          <span class="chapter-wiz__hint">
            Leave it blank for a general ${escapeHtml(s.typeLabel.toLowerCase())} chapter.
          </span>
        </label>

        ${s.error ? `<div class="chapter-wiz__error">${escapeHtml(s.error)}</div>` : ""}
      </div>
    `;
  }

  window.ChapterWizardSteps = {
    type: renderTypeStep,
    draft: renderDraftStep,
  };
})();
