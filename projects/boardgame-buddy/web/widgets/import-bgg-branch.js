// widgets/import-bgg-branch.js — the BoardGameGeek half of the wizard.
//
// Everything about bringing a BoardGameGeek play history over: the read, the
// two resolution steps that follow it, and the one thing this branch has that
// neither of the others does — a step that can go and FETCH what it is missing,
// because a BGG play names its game by an id the catalog understands.
//
// It owns no chrome. views/import-wizard-view.js draws the header, the step
// bar, the nav and the shared review; this answers the branch contract
// (`steps`, `renderStep`, `continueBlocker`, `stepNext`, `stepBack`,
// `navLabel`, `onEnter`, `resetFormState`) and holds the handlers its own step
// bodies call by name.
//
// TWO GUARDS WORTH READING BEFORE CHANGING ANYTHING HERE:
//
//   • onEnter runs on EVERY MOUNT, including a resume. So _loadPlays refuses to
//     run over a draft that already has plays unless it is asked to force —
//     otherwise coming back to a half-reviewed import would silently throw the
//     review away and re-read BoardGameGeek.
//   • The sequence guard ADVANCES on reset rather than restarting at 0. A read
//     still in flight from a previous mount must never match again and paint
//     over whatever the next one is doing. Restarting it at zero is the bug the
//     photo branch used to carry.

(function () {
  class ImportBggBranch {
    constructor() {
      this.draft = new window.BggPlayImport();
      this.resetFormState();
    }

    /** The shell. Held by name rather than by reference: init.js builds the
     *  branch first, and an inline handler resolves it at click time anyway. */
    get view() { return window.importWizardView; }

    /** @returns {"bgg"} */
    get sourceKey() { return "bgg"; }

    /**
     * This branch's own steps, between the source picker and the shared
     * review. `plays` is the read — the branch's equivalent of the note's
     * paste box, and the only step in the wizard whose content arrives rather
     * than being typed.
     */
    get steps() { return ["plays", "players", "games"]; }

    /** @param {string} name @param {any} opts */
    renderStep(name, opts) {
      // The branch's own flags are merged in here rather than being passed
      // down by the shell: the shell's opts are the ones every source shares,
      // and a third source's loading state is not one of them.
      return window.ImportBggSteps[name](this.draft, Object.assign({}, opts, {
        loading: this._loadingPlays,
        error: this._playsError,
        linkError: this._linkError,
        importingGames: this._importingGames,
      }));
    }

    /** Fired when the wizard enters this branch, and on every mount. */
    onEnter() {
      // Neither awaited: the steps paint and settle when these land.
      this._loadPartners();
      this._loadPlays();
    }

    /**
     * Everything transient this branch owns. Called from the constructor and
     * from the shell's own reset, which runs on every mount.
     *
     * The shell owns the review's open rows, the import flags and the error
     * banner — they are the same for every source. The draft is not reset here
     * either: the shell decides whether to restore or start over, and it needs
     * the saved one intact to make that call.
     */
    resetFormState() {
      this._loadingPlays = false;
      this._playsError = null;
      /** Set when the account is not linked, or the link has expired. Kept
       *  apart from _playsError because the fix is a different screen. */
      this._linkError = null;
      this._partners = null;
      this._loadingPartners = false;
      /** @type {Object<string, boolean>} BGG game ids with a fetch in flight. */
      this._importingGames = {};
      // Monotonic, and ADVANCING rather than restarting — see the header.
      this._readSeq = (this._readSeq || 0) + 1;
      /** The BGG name the player sheet is currently asking about. */
      this._sheetName = null;
    }

    /**
     * The label on the wizard's Continue button for one of this branch's
     * steps, or null for the default.
     */
    navLabel(stepName) {
      if (this._loadingPlays) return "Reading your plays…";
      if (stepName === "plays" && !this.draft.plays.length) return null;
      return null;
    }

    /**
     * Why Continue is unavailable on one of this branch's steps, or null. One
     * place, so the nav's `disabled` and the shell's own guard cannot disagree.
     * @param {string} stepName
     */
    continueBlocker(stepName) {
      if (stepName === "plays") {
        if (this._loadingPlays) return "Still reading your BoardGameGeek plays…";
        if (this._linkError) return this._linkError;
        if (this._playsError) return "That read didn't finish — try again.";
        if (!this.draft.plays.length) return "Nothing new to import.";
      }
      return null;
    }

    /**
     * Advance within the branch. Returns true when this branch handled the
     * step change itself, false to let the shell move on by one.
     * @param {string} stepName
     */
    async stepNext(stepName) {
      if (stepName === "games" && this.draft.unresolvedGames().length) {
        const unresolved = this.draft.unresolvedGames();
        const cost = unresolved.reduce((n, g) => n + g.plays, 0);
        const ok = await window.PolaroidPopup.confirm({
          title: `Leave ${cost} play${cost === 1 ? "" : "s"} out?`,
          body: `BoardgameBuddy doesn't have ${unresolved.length === 1 ? "that game" : "those games"} `
              + `yet, and a play with no game can't be imported. You can bring `
              + `${unresolved.length === 1 ? "it" : "them"} over now, or leave `
              + `${unresolved.length === 1 ? "it" : "them"} and import the rest.`,
          confirmLabel: "Leave them out",
          cancelLabel: "Bring them over",
        });
        if (!ok) return true;
      }
      return false;
    }

    /** Nothing in this branch walks back by itself. */
    stepBack() { return false; }

    // ── The read ──────────────────────────────────────────────────────────────

    /**
     * Fetch the plays BgB has not got.
     *
     * @param {{force?: boolean}} [opts] `force` is the Read-again button. The
     *   default refuses to run over a draft that already holds plays — see the
     *   header, onEnter runs on every mount including a resume.
     */
    async _loadPlays(opts) {
      const force = !!(opts && opts.force);
      if (this._loadingPlays) return;
      if (!force && this.draft.plays.length) return;

      const seq = ++this._readSeq;
      this._loadingPlays = true;
      this._playsError = null;
      this._linkError = null;
      this.view.clearError();
      this.view.render();

      let res;
      try {
        res = await window.BggPlayImport.fetchPending();
      } catch (err) {
        if (seq !== this._readSeq) return;
        this._loadingPlays = false;
        // 400 and 409 from this endpoint mean "your BoardGameGeek link is the
        // problem", and the fix is a different screen rather than a retry. A
        // Try again button in front of a missing account is a dead end.
        const status = (err && err.status) || 0;
        if (status === 400 || status === 409) {
          this._linkError = (err && err.message)
            || "Link your BoardGameGeek account in Settings → Connections first.";
        } else {
          this._playsError = (err && err.message)
            || "Couldn't read your plays from BoardGameGeek.";
        }
        this.view.render();
        return;
      }
      if (seq !== this._readSeq) return;
      this._loadingPlays = false;

      if (res && res.read_failed) {
        this._playsError = "BoardGameGeek is still preparing your plays. "
                         + "Try again in a moment.";
        this.view.render();
        return;
      }

      this.draft.adopt(res);
      // Against whatever the partner load has by now. When it hasn't landed,
      // _loadPartners re-runs them on arrival — a name the user has since
      // decided about is never re-suggested.
      this.draft.suggestPlayers(this._partners || {});
      this.draft.save();
      this.view.render();
    }

    async _loadPartners() {
      this._loadingPartners = true;
      this._partners = await window.ImportPeople.loadPartners();
      this._loadingPartners = false;
      if (this.draft.playerNames.length) {
        this.draft.suggestPlayers(this._partners);
        this.draft.save();
      }
      // A sheet opened before this landed is showing ghosts and nothing else.
      if (this._sheetName && window.PlayerPickerSheet.isOpen()) {
        const candidates = window.ImportPeople.candidates(this._partners);
        window.PlayerPickerSheet.setCandidates(
          candidates, null, window.ImportPeople.closestTo(this._sheetName, candidates));
      }
      if (this.draft.stepName === "players") this.view.render();
    }

    /** The link step's way out. A close, so it lands back where it came from. */
    _goToConnections() {
      window.router.go("settings");
    }

    // ── Players step ──────────────────────────────────────────────────────────

    _openPlayerSheet(name) {
      // Held so a buddy list that lands while the sheet is open can re-rank
      // and refill it, rather than leaving the user staring at a ghosts-only
      // list.
      this._sheetName = name;
      const candidates = window.ImportPeople.candidates(this._partners);
      const close = window.ImportPeople.closestTo(name, candidates);
      const current = this.draft.playerMapping(name);

      window.PlayerPickerSheet.open({
        candidates,
        suggestions: close,
        suggestionsLabel: `Closest to “${name}”`,
        restLabel: "Everyone you play with",
        singleSelect: true,
        title: `Who is “${name}”?`,
        sub: "Match an account, or keep them as a ghost player.",
        selectedName: current.label,
        guestName: current.kind === "ghost" ? current.label : name,
        guestTitle: `Keep “${current.kind === "ghost" ? current.label : name}” as a ghost player`,
        guestHint: "No account — they can claim these plays later",
        searchAll: (q) => window.ImportPeople.searchEveryone(q),
        searchAllLabel: "Search all of BoardgameBuddy",
        returnFocus: document.activeElement,
        onConfirm: (picks) => {
          const pick = picks && picks[0];
          if (!pick) return;
          this.draft.setPlayer(name, pick.user_id
            ? { kind: "buddy", userId: pick.user_id, label: pick.name }
            : { kind: "ghost", userId: null, label: pick.name });
          this.draft.save();
          this.view.render();
        },
      });
    }

    // ── Games step ────────────────────────────────────────────────────────────

    /**
     * Bring one game over from BoardGameGeek.
     *
     * The primary action, and the thing this branch can do that the notes one
     * cannot: a BGG play names its game by the very id the catalog stores in
     * `bgg_id`, so there is nothing to search for.
     *
     * `silent` because the toast belongs to the Add Games flow — here the
     * import is in service of a play import, the row updates in place to say
     * so, and a batch would otherwise stack a toast per game over the step the
     * user is working on. The catalog invalidation it skips is done once, by
     * the caller, through BggImport.catalogChanged().
     * @param {number} bggGameId
     * @returns {Promise<boolean>} true when the catalog now has it.
     */
    async _importGame(bggGameId) {
      const id = Number(bggGameId);
      if (!id || this._importingGames[id]) return false;
      const row = this.draft.unresolvedGames().find((g) => g.bggId === id);
      const name = row ? row.name : "This game";

      this._importingGames[id] = true;
      this.view.render();
      let job;
      try {
        job = await window.BggImport.start({ bgg_id: id, name }, { silent: true });
      } catch (err) {
        delete this._importingGames[id];
        this.view.setError((err && err.message) || `Couldn't bring over ${name}.`);
        return false;
      }
      delete this._importingGames[id];

      if (!job || job.state !== "done" || !job.game) {
        this.view.setError((job && job.error) || `Couldn't bring over ${name}.`);
        this.view.render();
        return false;
      }
      this.draft.setGame(id, job.game);
      this.draft.save();
      return true;
    }

    /** One game, from its own row. */
    async _importOne(bggGameId) {
      const ok = await this._importGame(bggGameId);
      if (ok) window.BggImport.catalogChanged();
      this.view.render();
    }

    /**
     * Every missing game, one at a time.
     *
     * Sequential rather than parallel on purpose: each one is a throttled
     * BoardGameGeek read on the server, and firing thirty at once is how a
     * user gets rate-limited out of their own import. One catalog
     * invalidation at the end rather than one per game.
     */
    async _importAllGames() {
      const pending = this.draft.unresolvedGames().map((g) => g.bggId);
      if (!pending.length) return;
      let landed = 0;
      for (const id of pending) {
        // eslint-disable-next-line no-await-in-loop -- sequential is the point.
        if (await this._importGame(id)) landed++;
      }
      if (landed) window.BggImport.catalogChanged();
      this.view.render();
      if (landed) {
        showToast(`Brought over ${landed} game${landed === 1 ? "" : "s"}`, "success");
      }
    }

    /**
     * Match a game BgB already has under a different BGG id — an edition, a
     * re-release, a row imported before the catalog knew its BGG id. The
     * fallback, not the primary action.
     * @param {string} bggGameId
     */
    _openGameSheet(bggGameId) {
      const id = Number(bggGameId);
      const row = this.draft.unresolvedGames().find((g) => g.bggId === id);
      window.GameSearchSheet.open({
        title: `Which game is “${row ? row.name : "this"}”?`,
        placeholder: "Search for a game…",
        returnFocus: document.activeElement,
        onPick: (game) => {
          this.draft.setGame(id, game);
          this.draft.save();
          this.view.render();
        },
        onError: (err) => showToast((err && err.message) || "Search failed", "error"),
      });
    }
  }

  window.ImportBggBranch = ImportBggBranch;
})();
