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
   * @property {string} [chip]  The label on a disabled row's badge.
   */

  /**
   * Sources that are BUILT but switched off, keyed by source id.
   *
   * Everything behind an entry here is untouched — the branch, its steps, its
   * draft model, its API routes and its tests all still exist and still pass.
   * The question this table answers is only "may a user start one right now",
   * which is a different question from "does it work". Re-enabling a source is
   * deleting its entry; nothing else has to come back with it.
   *
   * Board Game Arena is off while we look for a supported way to read a
   * player's table history. The branch we have signs in with the user's BGA
   * password, which their terms do not allow — the row said so, which is not
   * the same as not offering it.
   *
   * This is also the gate the WIZARD reads (`isLive`), not just the picker: a
   * disabled row is not an off switch while `/settings/import?source=bga`
   * still walks straight into the branch behind it.
   *
   * @type {Object<string, {chip: string, why: string}>}
   */
  const OFF = {
    bga: {
      chip: "Coming soon",
      why: "Paused while we look for a supported way to read your table "
         + "history.",
    },
  };

  /** @type {SourceOption[]} */
  const STATIC_SOURCES = [
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
      key: "bga",
      icon: "gamepad-2",
      title: "Board Game Arena",
      sub: "Bring over the tables you've finished. Each one keeps its date, "
         + "its scores and everyone who was there.",
      // Whatever OFF says replaces this line while the source is off — see
      // `applyOff`. It is kept here for the day the entry goes away: it is the
      // one thing that might make somebody not want to open the door at all,
      // and it belongs on the row rather than only behind it. The account step
      // says it again, at length, above the password field.
      extra: "Needs your BGA password, and their terms don't allow this — "
           + "there's a note to read before you sign in.",
    },
  ];

  /**
   * The BoardGameGeek row, which is four rows depending on the account.
   *
   * NEVER LIVE BEFORE THE LINK STATE IS KNOWN. The picker paints synchronously
   * — the wizard navigates first and fetches after — so `bggAuth` is null on
   * the first paint and arrives a moment later. Rendering the row enabled
   * meanwhile and disabling it when the answer lands would take a control away
   * from under a thumb already on its way down; starting disabled and enabling
   * is the safe direction, because nothing the user could have tapped becomes
   * untappable.
   *
   * @param {"linked"|"unlinked"|"relink_required"|null} bggAuth
   * @returns {SourceOption}
   */
  function bggRow(bggAuth) {
    const base = { icon: "dices", title: "BoardGameGeek" };
    if (bggAuth === "linked") {
      return Object.assign({}, base, {
        key: "bgg",
        sub: "Bring over the plays you've recorded on BoardGameGeek. You match "
           + "the people and check every play before anything is written.",
      });
    }
    if (bggAuth === "unlinked") {
      return Object.assign({}, base, {
        key: "",
        chip: "Not connected",
        sub: "Bring over the plays you've recorded on BoardGameGeek.",
        extra: "Link your BoardGameGeek account in Settings → Connections first.",
      });
    }
    if (bggAuth === "relink_required") {
      return Object.assign({}, base, {
        key: "",
        chip: "Reconnect",
        sub: "Bring over the plays you've recorded on BoardGameGeek.",
        extra: "Your BoardGameGeek session has expired — reconnect in "
             + "Settings → Connections.",
      });
    }
    return Object.assign({}, base, {
      key: "",
      chip: "Checking",
      sub: "Bring over the plays you've recorded on BoardGameGeek.",
    });
  }

  /** Is this source available to start right now? */
  function isLive(source) {
    return !OFF[source];
  }

  /**
   * A row, with its source's off-switch applied.
   *
   * Blanking `key` is what makes renderRow paint the disabled dialect, so an
   * off source reuses the shape the picker already had for one that has not
   * landed — the user meets one kind of unavailable row, not two.
   *
   * @param {SourceOption} src
   * @returns {SourceOption}
   */
  function applyOff(src) {
    const off = OFF[src.key];
    if (!off) return src;
    return Object.assign({}, src, { key: "", chip: off.chip, extra: off.why });
  }

  /**
   * @param {{resume: {source: string, label: string}|null,
   *          bggAuth: "linked"|"unlinked"|"relink_required"|null}} [opts]
   */
  function render(opts) {
    const resume = opts && opts.resume;
    // BoardGameGeek is built per render because its row depends on the link
    // state; every other source is static.
    const sources = STATIC_SOURCES.concat([bggRow((opts && opts.bggAuth) || null)])
      .map(applyOff);
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Where are these plays coming from?</h3>
        <p class="imp-step__lede">
          Nothing is written until you've reviewed every play.
        </p>
        <div class="imp-list">
          ${resume ? renderResume(resume) : ""}
          ${sources.map(renderRow).join("")}
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
          ? `<span class="imp-row__soon">${escapeHtml(src.chip || "Coming soon")}</span>`
          : `<span class="imp-row__chev"><i data-icon="chevron-right" class="w-4 h-4"></i></span>`}
      </button>
    `;
  }

  window.ImportSourceStep = { render, bggRow, isLive, STATIC_SOURCES, OFF };
})();
