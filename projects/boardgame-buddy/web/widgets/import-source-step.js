// widgets/import-source-step.js — "where are these plays coming from?"
//
// The wizard's first step, and the only one that shows no progress bar: the
// branches are different lengths (a note is read, then its names and its games
// are resolved; a camera roll is picked and paged through), so a counter here
// would have to promise a number nobody can know yet. Once a source is picked
// the bar counts that branch's real, known-length path, and a user only ever
// walks one.
//
// Built from `.imp-list` / `.imp-row`, the same row the Players and Games steps
// use, so a source is picked with the same gesture a name is matched with.

(function () {
  const V = "window.importWizardView";

  /**
   * @typedef {Object} SourceOption
   * @property {string} key     What `_pickSource` takes, or "" when unavailable.
   * @property {string} icon    A name from the vendored set (ui/icons.js).
   * @property {string} title
   * @property {string} sub
   * @property {string|null} [extra]  A second line, for a pointer elsewhere.
   */

  /** @type {SourceOption[]} */
  const SOURCES = [
    {
      key: "notes",
      icon: "sticky-note",
      title: "Notes",
      sub: "Paste a list, a table or a page of tally marks — or photograph the "
         + "page — and it gets read into plays you review.",
    },
    {
      key: "photos",
      icon: "camera",
      title: "Photos",
      sub: "Pick photos of games you've played. Each one keeps its date and its "
         + "country; you add the game and who was there.",
    },
    {
      key: "",
      icon: "dices",
      title: "BoardGameGeek",
      sub: "Coming soon — bringing over the plays you've recorded on BGG.",
      // Without this the row reads as a regression to the people already using
      // the BGG sync, which is not going anywhere and is not this wizard.
      extra: "Syncing your BGG collection is already in Settings → Connections.",
    },
    {
      key: "",
      icon: "gamepad-2",
      title: "Board Game Arena",
      sub: "Coming soon — importing the plays from your Board Game Arena account.",
    },
  ];

  /**
   * @param {{resume: {source: string, label: string}|null}} [opts]
   */
  function render(opts) {
    const resume = opts && opts.resume;
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Where are these plays coming from?</h3>
        <p class="imp-step__lede">
          Nothing is written until you've reviewed every play.
        </p>
        <div class="imp-list">
          ${resume ? renderResume(resume) : ""}
          ${SOURCES.map(renderRow).join("")}
        </div>
      </div>
    `;
  }

  /**
   * An unfinished import, offered before the sources.
   *
   * Leading the list rather than replacing it: the draft is worth more than a
   * fresh start, but somebody who came here to import something else must not
   * have to discard it first to reach the row they wanted.
   */
  function renderResume(resume) {
    return `
      <button class="imp-row" type="button"
              onclick="${escapeAttr(`${V}._resumeDraft()`)}">
        <span class="imp-row__art"><i data-icon="history" class="w-4 h-4"></i></span>
        <span class="imp-row__body">
          <span class="imp-row__name">Pick up where you left off</span>
          <span class="imp-row__sub">${escapeHtml(resume.label)}</span>
        </span>
        <span class="imp-row__chev"><i data-icon="chevron-right" class="w-4 h-4"></i></span>
      </button>
    `;
  }

  /** @param {SourceOption} src */
  function renderRow(src) {
    const soon = !src.key;
    // A disabled <button>, not a <div>: it stays out of the tab order and is
    // announced as unavailable rather than as a thing that simply does nothing.
    return `
      <button class="imp-row${soon ? " imp-row--soon" : ""}" type="button"
              ${soon ? `disabled aria-disabled="true"` : ""}
              ${soon ? "" : `onclick="${escapeAttr(`${V}._pickSource('${jsStr(src.key)}')`)}"`}>
        <span class="imp-row__art"><i data-icon="${src.icon}" class="w-4 h-4"></i></span>
        <span class="imp-row__body">
          <span class="imp-row__name">${escapeHtml(src.title)}</span>
          <span class="imp-row__sub">${escapeHtml(src.sub)}</span>
          ${src.extra ? `<span class="imp-row__sub">${escapeHtml(src.extra)}</span>` : ""}
        </span>
        ${soon
          ? `<span class="imp-row__soon">Coming soon</span>`
          : `<span class="imp-row__chev"><i data-icon="chevron-right" class="w-4 h-4"></i></span>`}
      </button>
    `;
  }

  window.ImportSourceStep = { render, SOURCES };
})();
