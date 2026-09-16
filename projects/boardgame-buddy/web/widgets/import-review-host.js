// widgets/import-review-host.js — the shared review step's handler half.
//
// widgets/import-review-step.js draws the review; this answers its taps. It is
// a separate object from views/import-wizard-view.js for the same reason the
// two are separate from each other: the shell owns the wizard's LIFECYCLE and
// this owns one screen's interactions, and folding them together would make
// the shell's own header ("owns the lifecycle and nothing about how a source's
// steps look") a lie.
//
// Every handler resolves the row through the draft's review adapter, so
// nothing here knows whether it is editing a line somebody's AI read out of a
// notebook or a photograph off a camera roll.
//
// EVERY EDIT APPLIES TO THE WHOLE ROW. That is what this screen already did
// for dates and per-row game overrides, and the row's own copy says so. The
// consequence that needs handling rather than merely knowing is that two rows
// can MERGE when an edit makes their identities equal — correct, they are now
// indistinguishable — which orphans one of the two anchor ids. `_reanchor` is
// that, and without it the row the user is typing in closes under them.
//
// Inline handlers address it as `window.importWizardView.review`, which is
// what the step is handed as `opts.host`.

(function () {
  class ImportReviewHost {
    /** @param {any} view The wizard shell. */
    constructor(view) { this.view = view; }

    get _draft() { return this.view._draft; }
    get _branch() { return this.view._branch; }
    get _expanded() { return this.view._expanded; }
    render() { this.view.render(); }

    // ── The shared review's handlers ──────────────────────────────────────────
    //
    // One set, for every source. Each resolves the row through the draft's
    // adapter, so nothing here knows whether it is editing a parsed line or a
    // photograph.
    //
    // EVERY EDIT APPLIES TO THE WHOLE ROW, which is what this screen already
    // did for dates and per-row games. Two rows can therefore merge, which
    // orphans one of the two anchor ids — hence _reanchor below.

    _toggleRow(rowId) {
      this.view._expanded[rowId] = !this.view._expanded[rowId];
      this.render();
    }

    /**
     * Keep the open row open across an edit that merged it with another.
     *
     * `_expanded` is keyed on the row's anchor — its first item's id — and a
     * merge leaves one of the two anchors inside a row that now answers to the
     * other. Without this the row the user was typing in closes under them.
     * @param {string} rowId
     */
    _reanchor(rowId) {
      if (!this.view._expanded[rowId]) return;
      const d = this._draft;
      for (const group of d.reviewGroups()) {
        for (const row of group.rows) {
          if (row.id === rowId) return;   // still the anchor, nothing to do
        }
      }
      // The id is no longer an anchor: find the row that swallowed it.
      const row = d.rowFor ? d.rowFor(rowId) : null;
      const anchor = row && row.plays && row.plays[0] && row.plays[0].id;
      delete this.view._expanded[rowId];
      if (anchor) this.view._expanded[anchor] = true;
    }

    /** @param {string} rowId */
    async _dropRow(rowId) {
      const d = this._draft;
      const ok = await window.PolaroidPopup.confirm({
        title: "Leave this out?",
        body: "It won't be imported. You can start the import over if you "
            + "change your mind.",
        confirmLabel: "Leave it out",
        cancelLabel: "Keep it",
        destructive: true,
      });
      if (!ok) return;
      d.dropRow(rowId);
      delete this.view._expanded[rowId];
      d.save();
      this.render();
    }

    _onBulkDate(value) {
      const d = this._draft;
      d.bulkDate = value || null;
      d.save();
      this.render();
    }

    /** @param {string} rowId @param {string} value */
    _onRowDate(rowId, value) {
      const d = this._draft;
      d.setRowDate(rowId, value);
      this._reanchor(rowId);
      d.save();
      this.render();
    }

    /** @param {string} rowId @param {string} value */
    _onRowCount(rowId, value) {
      const d = this._draft;
      d.setRowCount(rowId, value);
      d.save();
      this.render();
    }

    /** @param {string} rowId */
    _openRowGameSheet(rowId) {
      const d = this._draft;
      window.GameSearchSheet.open({
        title: "Which game is this?",
        placeholder: "Search games",
        returnFocus: document.activeElement,
        onPick: (game) => {
          d.setRowGame(rowId, game);
          this._reanchor(rowId);
          d.save();
          this.render();
        },
        onError: (err) => showToast((err && err.message) || "Search failed", "error"),
      });
    }

    /** @param {string} rowId */
    _openRowPlayerSheet(rowId) {
      const d = this._draft;
      const row = this._reviewRow(rowId);
      if (!row) return;
      const seatedAccounts = new Set(row.seats.map((s) => s.user_id).filter(Boolean));
      const seatedNames = new Set(row.seats.map((s) => String(s.name).toLowerCase()));
      // Ghosts this import has already invented, so a name typed on one row is
      // reachable on the next rather than being typed — and misspelled — twice.
      const runGhosts = window.ImportPeople.ghostsIn(
        this._allSeats().map((seats) => seats.map((s) => ({
          name: s.name, userId: s.user_id,
        }))));
      const candidates = window.ImportPeople
        .candidates(this._branch._partners, runGhosts)
        .filter((c) => (c.user_id
          ? !seatedAccounts.has(c.user_id)
          : !seatedNames.has(String(c.name).toLowerCase())));

      window.PlayerPickerSheet.open({
        candidates,
        seatedNames: Array.from(seatedNames),
        recent: window.ImportPeople.recent(
          this._branch._partners, runGhosts, candidates, seatedNames, seatedAccounts),
        seated: row.seats.length,
        title: "Who played?",
        sub: "Anyone without an account comes in as a ghost player, and can "
           + "claim these plays later.",
        searchAll: (q) => window.ImportPeople.searchEveryone(q),
        searchAllLabel: "Search all of BoardgameBuddy",
        returnFocus: document.activeElement,
        onConfirm: (picks) => {
          d.addSeats(rowId, picks || []);
          this._reanchor(rowId);
          d.save();
          this.render();
        },
      });
    }

    /** @param {string} rowId @param {string} who */
    _toggleRowWinner(rowId, who) {
      const d = this._draft;
      d.toggleWinner(rowId, who);
      this._reanchor(rowId);
      d.save();
      this.render();
    }

    /** @param {string} rowId @param {string} who */
    _removeRowSeat(rowId, who) {
      const d = this._draft;
      d.removeSeat(rowId, who);
      this._reanchor(rowId);
      d.save();
      this.render();
    }

    /** @param {string} rowId @param {string} who @param {string} value */
    _onSeatScore(rowId, who, value) {
      const d = this._draft;
      d.setScore(rowId, who, value);
      this._reanchor(rowId);
      d.save();
      this.render();
    }

    /** One review row by its anchor id, across every group. */
    _reviewRow(rowId) {
      for (const group of this._draft.reviewGroups()) {
        for (const row of group.rows) if (row.id === rowId) return row;
      }
      return null;
    }

    /** Every table in the import, for the ghost candidates. */
    _allSeats() {
      const out = [];
      for (const group of this._draft.reviewGroups()) {
        for (const row of group.rows) out.push(row.seats);
      }
      return out;
    }
  }

  window.ImportReviewHost = ImportReviewHost;
})();
