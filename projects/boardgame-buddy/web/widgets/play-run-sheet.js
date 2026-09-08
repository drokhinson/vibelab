// @ts-check
// widgets/play-run-sheet.js — what a run of identical imported plays can do.
//
// A run card (ui/play-card.js, migration 005) stands for N plays that are
// indistinguishable from one another. It does not flip, because a flip
// promises a scorecard and there is no single play here to show one for.
// Tapping opens this instead.
//
// It has one job — say plainly what the card is — and, ON THE VIEWER'S OWN
// RUNS ONLY, one action: delete the run. "58 plays" on a tile is the kind of
// thing a person wants confirmed before they remove it.
//
// THE RUN MAY NOT BE THE VIEWER'S. The feed carries plays logged by buddies
// (and imports a buddy ran that sat the viewer at the table), so a run card on
// your timeline can belong to someone else's log. Deleting by import group is
// owner-scoped server-side — bgb_delete_import_group takes p_user — so the
// button on a borrowed run was a dead control that reported "Nothing to
// delete". It is not drawn at all now; a non-owner's sheet is the roster
// instead, and says whose import it is.
//
// The "what the card is" job grew when grouping moved onto the row identity: a
// run holds plays that are INDISTINGUISHABLE, which is not the same as
// featureless, so it can carry a note or a scoreline as long as every play in
// it carries the same one. Those have nowhere else to appear — so this sheet
// is where they belong. The note rides on the card; so does the roster, since
// migration 015 put the whole play on the feed card, and the fetch below is
// only the fallback for a card that predates it.
//
// That used to read "the stack's front shows no note, exactly as an ordinary
// card shows one only on its back", and the second half of it is no longer
// true: an ordinary card now previews its note on a paper plate across the
// bottom of its photo. The run card still doesn't, for its own reason — it has
// no photograph. Its frame is a big centred count over a dimmed thumbnail on
// --polaroid-bg-soft, which is a chrome surface, and the band's
// --photo-plate / --on-photo pair is only correct on top of an actual photo.
// A note preview on a run card would be a different treatment on a different
// surface, not this one moved across.
//
// Deleting a whole IMPORT (every play one paste wrote, one-offs included) is a
// different act and lives in Settings; this sheet is only ever the run.
//
// The shell is ui/bottom-sheet.js and the panel chrome is the shared
// .bgb-sheet__* family; only the .run-sheet__* bits are ours.

(function () {
  const DETAIL_SEL = "[data-run-detail]";

  class PlayRunSheet {
    constructor() {
      this._card = null;
      this._busy = false;
      /** The representative play, once fetched — the run's shared roster. */
      this._detail = null;
      this._detailBusy = false;
      // Monotonic, so a fetch the user has already closed past cannot paint
      // into the next run's sheet (.claude/rules/web-frontend.md § Async).
      this._detailSeq = 0;
      this._sheet = new window.BgbBottomSheet({
        id: "bgb-play-run-sheet",
        className: "play-run-sheet",
        label: "Imported plays",
      });
    }

    /** @param {any} card A feed play card with group_count > 1. */
    open(card) {
      if (!card) return;
      // A run card the server sent no group id for cannot be deleted by group.
      // That is only fatal for the OWNER's sheet, whose action it is; someone
      // else's run has no delete to offer either way, so it opens and reads as
      // the roster it is.
      const mine = isOwn(card);
      if (mine && !card.import_group_id) {
        if (window.showToast) window.showToast("Can't open that run right now", "error");
        return;
      }
      this._card = card;
      this._busy = false;
      this._detail = null;
      this._sheet.open({
        html: this._panel(),
        returnFocus: document.activeElement,
        onClick: (e) => {
          if (e.target.closest("[data-run-delete]")) this._confirmDelete();
        },
        onClose: () => {
          this._card = null;
          this._busy = false;
          this._detail = null;
          this._detailBusy = false;
          this._detailSeq++;
        },
      });
      // Not awaited: the sheet's own answer — what this card is — is already on
      // screen, and on any card since migration 015 the roster is too.
      this._loadDetail();
    }

    /**
     * Fetch the play the card stands for, purely for its roster. Every play in
     * the run carries the same seats and scores by construction, so the
     * representative's are the run's. Skipped outright when the card already
     * carries `players` (migration 015), which is every card the current feed
     * draws. Failure is silent: the sheet's actual job is unaffected, and an
     * error banner over a delete button would read as though the delete were
     * the thing that failed.
     */
    async _loadDetail() {
      const card = this._card;
      if (!card || !card.play_id || !window.Play || !window.Play.get) return;
      if (Array.isArray(card.players) && card.players.length) return;
      const seq = ++this._detailSeq;
      this._detailBusy = true;
      this._paintDetail();
      let play = null;
      try {
        play = await window.Play.get(card.play_id);
      } catch (_) {
        play = null;
      }
      if (seq !== this._detailSeq || !this._sheet.isOpen) return;
      this._detailBusy = false;
      this._detail = play;
      this._paintDetail();
    }

    /** Patch the one host the fetch owns, never the panel around it. */
    _paintDetail() {
      const root = this._sheet.el;
      const host = root && root.querySelector(DETAIL_SEL);
      if (!host) return;
      host.innerHTML = this._detailBlock();
      if (window.BgbIcons) window.BgbIcons.render(host);
    }

    /** The run's shared roster — the card's own copy, or the fetched one. */
    _players() {
      const c = this._card;
      if (c && Array.isArray(c.players) && c.players.length) return c.players;
      return (this._detail && this._detail.players) || [];
    }

    /**
     * Who played, who won, and what they scored — the same three facts the
     * ordinary card's back face carries, which a run has nowhere else to show.
     * Ranked by score when the run has any, so the winner leads; silent while
     * loading and silent when there is no roster at all, since a "no players
     * recorded" line would be noise under a sentence that already named the
     * winner.
     */
    _detailBlock() {
      const players = this._players();
      if (!players.length) return "";
      const me = window.store && window.store.get && window.store.get("user");
      const anyScore = players.some((p) => p && p.score !== null && p.score !== undefined);
      // Score descending; unscored seats keep their order behind the scored
      // ones. Untouched when nothing is scored — then the roster is the seating
      // order the play was logged in, which is the only order it has.
      const ranked = anyScore
        ? players.slice().sort((a, b) => {
            const sa = a.score == null ? -Infinity : Number(a.score);
            const sb = b.score == null ? -Infinity : Number(b.score);
            return sb - sa;
          })
        : players.slice();
      const seats = ranked.map((p) => {
        const isSelf = !!(me && p.user_id && p.user_id === me.id);
        // Under the viewer's private alias when they set one, exactly as the
        // card's scoreboard reads it. Nothing here writes a name.
        const real = window.Buddy ? window.Buddy.nameFor(p.user_id, p.name) : (p.name || "");
        const label = isSelf ? "You" : (real || "Unknown");
        const badge = window.BgbBadge
          ? window.BgbBadge.render({
              avatar: p.user_id ? (p.avatar || null) : null,
              displayName: label,
              size: "xs",
              isMe: isSelf,
              isGhost: !p.user_id,
              extraClass: "run-sheet__seat-badge",
            })
          : "";
        return `
          <li class="run-sheet__seat${p.is_winner ? " is-winner" : ""}">
            ${badge}
            <span class="run-sheet__seat-name">${escapeHtml(label)}</span>
            ${anyScore
              ? `<span class="run-sheet__seat-score">${
                  p.score === null || p.score === undefined ? "—" : escapeHtml(String(p.score))
                }</span>`
              : ""}
            ${p.is_winner
              ? `<span class="run-sheet__seat-win" title="Won"><i data-icon="trophy" class="w-3.5 h-3.5"></i></span>`
              : ""}
          </li>
        `;
      }).join("");
      return `<ul class="run-sheet__seats">${seats}</ul>`;
    }

    _panel() {
      const c = this._card || {};
      const n = c.group_count || 1;
      const game = (c.game && c.game.name) || "Unknown game";
      const me = window.store && window.store.get && window.store.get("user");
      const mine = isOwn(c);
      const isSelf = !!(me && me.display_name && c.winner_display_name === me.display_name);
      const winner = c.winner_display_name
        ? (isSelf ? "You" : c.winner_display_name)
        : null;
      const owner = c.user
        ? (window.Buddy ? window.Buddy.nameFor(c.user.id, c.user.display_name) : c.user.display_name)
        : null;
      // "They count as a play in YOUR stats" is only true when the viewer is at
      // the table — every play-derived surface counts a play for the person who
      // logged it or who sits in play_players (migration 045).
      const iPlayed = !!(me && this._players().some((p) => p && p.user_id === me.id));
      return `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">${n} identical plays</h3>
          <p class="bgb-sheet__sub">${escapeHtml(game)}${
            c.played_at ? ` · ${escapeHtml(formatDate(c.played_at))}` : ""
          }</p>
          ${!mine && owner
            ? `<p class="run-sheet__by">Imported by <b>${escapeHtml(owner)}</b></p>`
            : ""}
          <div class="bgb-sheet__list run-sheet__body">
            <p class="run-sheet__line">
              ${winner
                ? `<b>${escapeHtml(winner)}</b> won all ${n} of them.`
                : `No winner was recorded for these.`}
            </p>
            ${c.notes ? `
              <p class="run-sheet__quote">${escapeHtml(c.notes)}</p>
            ` : ""}
            <div data-run-detail>${this._detailBlock()}</div>
            <p class="run-sheet__note">
              ${mine
                ? `These came in from an import with nothing to tell them apart —
                   same game, same day, same players, same result${c.notes
                     ? `, and the one line above for all of them`
                     : ""} — which is why they're one card. They each count as a
                   play in your stats.`
                : `${owner ? `<b>${escapeHtml(owner)}</b> imported these` : "These came in from someone else's import"}
                   with nothing to tell them apart — same game, same day, same
                   players, same result${c.notes
                     ? `, and the one line above for all of them`
                     : ""} — which is why they're one card.${iPlayed
                     ? ` They each count as a play in your stats.`
                     : ""} Only ${owner ? escapeHtml(owner) : "the person who imported them"} can change or remove them.`}
            </p>
            ${mine ? `
              <button class="run-sheet__delete" type="button" data-run-delete>
                <i data-icon="trash-2" class="w-4 h-4"></i>
                <span>Delete ${n === 1 ? "this play" : `these ${n} plays`}</span>
              </button>
            ` : ""}
          </div>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Close</button>
        </div>
      `;
    }

    async _confirmDelete() {
      if (this._busy) return;
      const c = this._card;
      if (!c) return;
      // The button isn't drawn on someone else's run; this is the belt to that
      // brace, since the delete would come back deleted=0 and read as a bug.
      if (!isOwn(c) || !c.import_group_id) return;
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

  /**
   * Whose log the run sits on. The feed card names its logger (`user`), and
   * that is the only ownership signal the sheet gets — the run has no single
   * play to ask for an `is_own`. A card with no logger is treated as not the
   * viewer's, so an unknown owner never gets offered a delete.
   * @param {any} card
   */
  function isOwn(card) {
    const me = window.store && window.store.get && window.store.get("user");
    return !!(card && me && me.id && card.user && card.user.id === me.id);
  }

  window.PlayRunSheet = new PlayRunSheet();
})();
