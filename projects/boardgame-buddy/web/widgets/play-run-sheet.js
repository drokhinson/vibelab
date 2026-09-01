// @ts-check
// widgets/play-run-sheet.js — what a run of identical imported plays can do.
//
// A run card (ui/play-card.js, migration 005) stands for N plays that are
// indistinguishable from one another. It does not flip, because a flip
// promises a scorecard and there is no single play here to show one for.
// Tapping opens this instead.
//
// It exists for one action — delete the run — and one job besides: saying
// plainly what the card is, since "58 plays" on a tile is the kind of thing a
// person wants confirmed before they remove it.
//
// Deleting a whole IMPORT (every play one paste wrote, one-offs included) is a
// different act and lives in Settings; this sheet is only ever the run.
//
// The shell is ui/bottom-sheet.js and the panel chrome is the shared
// .bgb-sheet__* family; only the .run-sheet__* bits are ours.

(function () {
  class PlayRunSheet {
    constructor() {
      this._card = null;
      this._busy = false;
      this._sheet = new window.BgbBottomSheet({
        id: "bgb-play-run-sheet",
        className: "play-run-sheet",
        label: "Imported plays",
      });
    }

    /** @param {any} card A feed play card with group_count > 1. */
    open(card) {
      if (!card || !card.import_group_id) {
        // A run card the server did not send a group id for cannot be deleted
        // by group, and offering the button anyway would be a dead control.
        // Say so rather than opening a sheet whose only action does nothing.
        if (window.showToast) window.showToast("Can't open that run right now", "error");
        return;
      }
      this._card = card;
      this._busy = false;
      this._sheet.open({
        html: this._panel(),
        returnFocus: document.activeElement,
        onClick: (e) => {
          if (e.target.closest("[data-run-delete]")) this._confirmDelete();
        },
        onClose: () => { this._card = null; this._busy = false; },
      });
    }

    _panel() {
      const c = this._card || {};
      const n = c.group_count || 1;
      const game = (c.game && c.game.name) || "Unknown game";
      const me = window.store && window.store.get && window.store.get("user");
      const isSelf = !!(me && me.display_name && c.winner_display_name === me.display_name);
      const winner = c.winner_display_name
        ? (isSelf ? "You" : c.winner_display_name)
        : null;
      return `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">${n} identical plays</h3>
          <p class="bgb-sheet__sub">${escapeHtml(game)}${
            c.played_at ? ` · ${escapeHtml(formatDate(c.played_at))}` : ""
          }</p>
          <div class="bgb-sheet__list run-sheet__body">
            <p class="run-sheet__line">
              ${winner
                ? `<b>${escapeHtml(winner)}</b> won all ${n} of them.`
                : `No winner was recorded for these.`}
            </p>
            <p class="run-sheet__note">
              These came in from an import, with nothing in the notes to tell
              them apart — that's why they're one card. They each count as a
              play in your stats.
            </p>
            <button class="run-sheet__delete" type="button" data-run-delete>
              <i data-icon="trash-2" class="w-4 h-4"></i>
              <span>Delete ${n === 1 ? "this play" : `these ${n} plays`}</span>
            </button>
          </div>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Close</button>
        </div>
      `;
    }

    async _confirmDelete() {
      if (this._busy) return;
      const c = this._card;
      if (!c) return;
      const n = c.group_count || 1;
      const ok = await window.PolaroidPopup.confirm({
        title: `Delete ${n === 1 ? "this play" : `these ${n} plays`}?`,
        body: "They'll be removed from your history and your stats. This can't be undone — you'd have to import them again.",
        confirmLabel: "Delete",
        cancelLabel: "Keep them",
        destructive: true,
      });
      if (!ok) return;
      this._busy = true;
      let res;
      try {
        res = await window.Play.deleteImportGroup(c.import_group_id);
      } catch (err) {
        this._busy = false;
        if (window.showToast) window.showToast((err && err.message) || "Couldn't delete those plays", "error");
        return;
      }
      const deleted = (res && res.deleted) || 0;
      this._sheet.close();
      // Every surface that counts plays is now stale.
      if (window.Play && window.Play.invalidateDeps) window.Play.invalidateDeps();
      document.dispatchEvent(new CustomEvent("plays-changed", {
        detail: { deleted, importGroupId: c.import_group_id },
      }));
      if (window.showToast) {
        window.showToast(
          deleted ? `Deleted ${deleted} play${deleted === 1 ? "" : "s"}` : "Nothing to delete",
          deleted ? "success" : "info",
        );
      }
    }
  }

  window.PlayRunSheet = new PlayRunSheet();
})();
