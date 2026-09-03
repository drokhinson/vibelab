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
  // Three ways forward and all of them are optional: draft with AI, import a
  // .md file, or skip straight to writing (the footer's own button, so it
  // reads as "carry on" rather than a fourth choice competing here).
  //
  // @param {{typeLabel: string, typeIcon: string, genPrompt: string,
  //          generating: boolean, saving: boolean, error: ?string}} s
  function renderDraftStep(s) {
    const busy = s.generating || s.saving;
    // The prompt is genuinely optional, and the placeholder is the only place
    // that can say what a good one looks like without a paragraph of copy.
    const promptField = `
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
    `;

    return `
      <div class="chapter-wiz__step">
        <h3 class="chapter-wiz__title font-display">Want a head start?</h3>
        <p class="chapter-wiz__lede">
          Have the AI draft your
          <span class="chapter-wiz__typechip">
            <i data-icon="${escapeAttr(s.typeIcon || "book")}" class="w-3 h-3"></i>
            ${escapeHtml(s.typeLabel)}
          </span>
          chapter, bring your own file, or skip and write it yourself.
          Nothing is saved until you hit Save on the next step.
        </p>

        ${promptField}

        <button type="button"
                class="chapter-wiz__genbtn ${s.generating ? "chapter-wiz__genbtn--busy" : ""}"
                ${busy ? "disabled" : ""}
                onclick="${V}._onGenerateAi()">
          <i data-icon="sparkles" class="w-4 h-4"></i>
          <span>${s.generating ? "Drafting your chapter…" : "Generate with AI"}</span>
        </button>

        ${s.error ? `<div class="chapter-wiz__error">${escapeHtml(s.error)}</div>` : ""}

        <div class="chapter-wiz__or"><span>or</span></div>

        <label class="chapter-wiz__import ${busy ? "chapter-wiz__import--off" : ""}"
               title="Import a .md file as this chapter">
          <input type="file" accept=".md,text/markdown,text/plain"
                 ${busy ? "disabled" : ""}
                 onchange="${V}._onImportMd(event)" />
          <i data-icon="upload" class="w-4 h-4"></i>
          <span>Import a .md file</span>
        </label>
      </div>
    `;
  }

  window.ChapterWizardSteps = {
    type: renderTypeStep,
    draft: renderDraftStep,
  };
})();
