// @ts-check
// widgets/bgg-sync-sheet.js — the confirmation before either BGG sync runs.
//
// BOTH directions are destructive, just to different data. The push overwrites
// the user's BoardGameGeek collection; the import overwrites their BgB shelf.
// So both get a sheet naming every row they will touch, and the sheet's commit
// button is the second tap .claude/rules/web-frontend.md requires of any
// destructive action.
//
// A SHEET, NOT PolaroidPopup.confirm. A list of changes is a list
// (.claude/rules/overlays.md §1), and PolaroidPopup.confirm's body is an
// escapeHtml'd plain string that cannot render one. Docs/ARCHITECTURE.md §7
// Rule 3 names this carve-out so the next contributor does not "fix" it back.
//
// One widget, two payloads — the two directions are the same comparison read
// opposite ways, so the rows come from ui/bgg-diff-list.js either way.
//
// Its class is named in the theme re-point list in styles.css; a body-level
// sheet lands outside the screen that opened it (.claude/rules/theming.md §8).

(function () {
  /**
   * @typedef {Object} SyncSheetOpts
   * @property {any} diff                  the POST /bgg/check response
   * @property {"push"|"pull"} direction
   * @property {Element|null} [returnFocus]
   * @property {() => void} onConfirm      fired once, after the sheet closes
   */

  const COPY = {
    push: {
      title: "Push to BoardGameGeek",
      label: "Review changes to your BoardGameGeek collection",
      sub: (n) => `${n} ${n === 1 ? "change" : "changes"} to your real BGG collection`,
      cta: (n) => `Push ${n} ${n === 1 ? "change" : "changes"}`,
      empty: "Your BoardGameGeek collection already matches your BgB shelf.",
    },
    pull: {
      title: "Import from BoardGameGeek",
      label: "Review changes to your BoardgameBuddy shelf",
      sub: (n) => `${n} ${n === 1 ? "change" : "changes"} to your BoardgameBuddy shelf`,
      cta: (n) => `Import ${n} ${n === 1 ? "change" : "changes"}`,
      empty: "Your BgB shelf already matches your BoardGameGeek collection.",
    },
  };

  const sheet = new window.BgbBottomSheet({
    id: "bgb-bgg-sync-sheet",
    className: "bgg-sync-sheet",
    label: "Review sync",
  });

  /** @param {SyncSheetOpts} opts */
  function open(opts) {
    const dir = opts.direction === "pull" ? "pull" : "push";
    const copy = COPY[dir];
    const diff = opts.diff || {};
    // A pull's HELD rows are listed but are not changes — they are the
    // reassurance that makes the button safe to press — so they are excluded
    // from the count and from the commit label.
    const rows = (dir === "pull" ? diff.pull_changes : diff.push_changes) || [];
    const held = dir === "pull" ? rows.filter((r) => r.change === "held").length : 0;
    const total = (dir === "pull" ? diff.pull_total : diff.push_total) || 0;
    const actionable = Math.max(0, total - held);

    let confirmed = false;

    sheet.open({
      label: copy.label,
      returnFocus: opts.returnFocus || null,
      html: `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">${copy.title}</h3>
          <p class="bgb-sheet__sub">${copy.sub(actionable)}</p>
          <div class="bgb-sheet__list bgg-sync-sheet__list">
            ${actionable || held
              ? window.renderBggDiffList(diff, { variant: "sheet", direction: dir })
              : `<p class="bgg-diff__note">${copy.empty}</p>`}
          </div>
          <div class="bgg-sync-sheet__foot">
            ${actionable
              ? `<button class="btn btn-primary bgg-sync-sheet__go" type="button" data-sync-go>
                   ${copy.cta(actionable)}
                 </button>`
              : ""}
            <button class="bgb-sheet__cancel" type="button" data-action="close">
              ${actionable ? "Cancel" : "Close"}
            </button>
          </div>
        </div>`,
      onClick: (e) => {
        const t = /** @type {any} */ (e.target);
        if (!t.closest("[data-sync-go]")) return;
        // Close first, then act: the caller repaints the card, and running a
        // sync behind a live sheet would leave it describing a stale plan.
        confirmed = true;
        sheet.close();
      },
      onClose: () => {
        if (confirmed && opts.onConfirm) opts.onConfirm();
      },
    });
  }

  window.BggSyncSheet = { open, close: () => sheet.close(), get isOpen() { return sheet.isOpen; } };
})();
