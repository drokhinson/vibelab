// @ts-check
// widgets/import-bga-branch.js — the Board Game Arena source's half of the wizard.
//
// Owns this source's markup (via widgets/import-bga-steps.js), its handlers
// and its draft model (domain/bga-import.js), and answers the shell's contract:
// `steps`, `renderStep`, `continueBlocker`, `stepNext`, `stepBack`, `navLabel`,
// `onEnter`, `resetFormState`, `sourceKey`, `draft`. The shell
// (views/import-wizard-view.js) owns the lifecycle and nothing about how these
// steps look — .claude/rules/ui-object-design.md §4.
//
// THE PASSWORD LIVES HERE AND NOWHERE ELSE, for as long as one request takes.
// `_password` is a field on this branch, cleared the moment the link call
// returns either way, and it never reaches the draft model — which is what
// keeps it out of localStorage, since the model is the only thing that saves.
// `resetFormState` clears it too, so a remount cannot inherit one.
//
// NO BgbBackGuard. The wizard is a routed screen with a history entry of its
// own; arming a guard over one is the bug .claude/rules/overlays.md §8b
// describes. The sheets this opens arm their own.

(function () {
  class ImportBgaBranch {
    constructor() {
      this.draft = new window.BgaImport();
      this.resetFormState();
    }

    /** The shell. Held by name rather than by reference: init.js builds the
     *  branch first, and an inline handler resolves it at click time anyway. */
    get view() { return window.importWizardView; }

    /** @returns {"bga"} */
    get sourceKey() { return "bga"; }

    /**
     * This branch's own steps, between the source picker and the shared review.
     * Five counted steps with the shared tail, against Notes' six and Photos'
     * four — which is why the source picker shows no progress bar.
     */
    get steps() { return ["account", "fetch", "players", "games"]; }

    /** @param {string} name @param {any} opts */
    renderStep(name, opts) {
      return window.ImportBgaSteps[name](this.draft, {
        ...opts,
        linking: this._linking,
        fetching: this._fetching,
        fetchProgress: this._fetchProgress,
        agreed: this._agreed,
        username: this._username,
      });
    }

    /** Fired when the wizard enters this branch, and on every mount. */
    onEnter() {
      // Neither awaited: the account step paints from the draft and settles
      // when these land.
      this._loadLink();
      this._loadPartners();
    }

    /**
     * The label on the wizard's Continue button, or null for the default.
     *
     * The two steps that cost real time say what they are about to do, the
     * same reasoning as the note importer's "Read my notes": a button that
     * names the work is the difference between waiting and wondering.
     * @param {string} stepName
     */
    navLabel(stepName) {
      if (stepName === "account") {
        if (this._linking) return "Signing in…";
        return this.draft.link.authState === "linked" ? "Continue" : "Link my account";
      }
      if (stepName === "fetch") {
        if (this._fetching) return "Reading Board Game Arena…";
        return this.draft.tables.length ? "Continue" : "Find my tables";
      }
      return null;
    }

    /**
     * Advance within the branch. Returns true when this branch handled the
     * step change itself, false to let the shell move on by one.
     * @param {string} stepName
     */
    async stepNext(stepName) {
      if (stepName === "account" && this.draft.link.authState !== "linked") {
        await this._link();
        return true;
      }
      if (stepName === "fetch" && !this.draft.tables.length) {
        await this._fetch();
        return true;
      }
      if (stepName === "games" && this.draft.unresolvedGames().length) {
        const cost = this.draft.unresolvedGames().reduce((n, g) => n + g.plays, 0);
        const ok = await window.PolaroidPopup.confirm({
          title: `Leave ${cost} table${cost === 1 ? "" : "s"} out?`,
          body: "A table with no game matched can't be imported. You can match "
              + "them now, or leave them out and import the rest.",
          confirmLabel: "Leave them out",
          cancelLabel: "Match them",
        });
        if (!ok) return true;
      }
      return false;
    }

    /** Nothing in this branch walks back by itself. */
    stepBack() { return false; }

    /**
     * Everything transient this branch owns. Called from the constructor and
     * from the shell's own reset, which runs on every mount: both are
     * singletons, so a previous run's state would otherwise paint under the
     * next one.
     *
     * The draft is not reset here — the shell decides whether to restore or
     * start over, and it needs the saved one intact to make that call.
     */
    resetFormState() {
      this._linking = false;
      this._fetching = false;
      this._fetchProgress = null;
      this._agreed = false;
      this._username = "";
      // Never persisted, never on the draft. See this file's header.
      this._password = "";
      this._partners = null;
      this._loadingPartners = false;
      /** The handle the player sheet is currently asking about. */
      this._sheetHandle = null;
      // Monotonic, and ADVANCING rather than restarting: a call still in
      // flight from the previous mount must never match again and repaint over
      // whatever the next one is doing. Restarting at 0 is the bug the photo
      // branch used to carry.
      this._linkSeq = (this._linkSeq || 0) + 1;
      this._fetchSeq = (this._fetchSeq || 0) + 1;
      this._stopPolling();
    }

    /**
     * Why Continue is unavailable on one of this branch's steps, or null.
     * One place, so the nav's `disabled` and the shell's own guard cannot
     * disagree about it.
     * @param {string} stepName
     */
    continueBlocker(stepName) {
      if (stepName === "account") {
        if (this._linking) return "Signing in to Board Game Arena…";
        if (this.draft.link.authState === "linked") return null;
        if (!this._agreed) return "Tick the box to continue.";
        if (!this._username.trim() || !this._password) {
          return "Enter your Board Game Arena username and password.";
        }
      }
      if (stepName === "fetch" && this._fetching) {
        return "Still reading your tables…";
      }
      return null;
    }

    // ── Account step ──────────────────────────────────────────────────────────

    _onUserInput(value) { this._username = String(value || ""); this._syncNext(); }
    _onPassInput(value) { this._password = String(value || ""); this._syncNext(); }
    _onAgree(checked) { this._agreed = !!checked; this._syncNext(); }

    /**
     * Re-enable Continue without a re-render.
     *
     * Repainting the step on every keystroke would destroy the input the user
     * is typing into along with its focus and caret — the same reason
     * .claude/rules/overlays.md §6 says to repaint surgically. Only the nav
     * button's disabled state actually changes, so only that is touched.
     */
    _syncNext() {
      const root = this.view && this.view.container;
      const btn = root && root.querySelector(".imp-nav__next");
      if (!btn) return;
      const blocker = this.continueBlocker(this.draft.stepName);
      btn.disabled = !!blocker;
      if (blocker) btn.setAttribute("title", blocker);
      else btn.removeAttribute("title");
    }

    async _loadLink() {
      const seq = this._linkSeq;
      try {
        const status = await window.Bga.status();
        if (seq !== this._linkSeq) return;
        this.draft.link = {
          username: status.bga_username || null,
          playerId: status.bga_player_id || null,
          authState: status.auth_state || "unlinked",
          lastImportAt: status.last_import_at || null,
        };
        if (this.draft.stepName === "account") this.view.render();
      } catch (_) {
        if (seq !== this._linkSeq) return;
        // A failed status read is not a failed link: the account step still
        // paints, offering the sign-in it would have offered anyway.
      }
    }

    async _link() {
      if (this._linking) return;
      const seq = ++this._linkSeq;
      this._linking = true;
      this.view.clearError();
      this.view.render();

      const username = this._username.trim();
      const password = this._password;
      try {
        const status = await window.Bga.link(username, password);
        if (seq !== this._linkSeq) return;
        this.draft.link = {
          username: status.bga_username || username,
          playerId: status.bga_player_id || null,
          authState: status.auth_state || "linked",
          lastImportAt: status.last_import_at || null,
        };
        this.draft.step = 1; // fetch
        this.draft.save();
      } catch (err) {
        if (seq !== this._linkSeq) return;
        this._linking = false;
        this.view.setError((err && err.message) || "Couldn't sign in to Board Game Arena.");
        return;
      } finally {
        // Whatever happened, the password stops existing here. Cleared in
        // `finally` so a thrown error cannot leave it on the branch.
        this._password = "";
      }
      this._linking = false;
      this.view.render();
    }

    async _unlink() {
      const ok = await window.PolaroidPopup.confirm({
        title: "Unlink Board Game Arena?",
        body: "This deletes the password we stored and signs the importer out. "
            + "Plays you've already imported stay where they are.",
        confirmLabel: "Unlink",
        cancelLabel: "Keep it",
        destructive: true,
      });
      if (!ok) return;
      try {
        await window.Bga.unlink();
      } catch (err) {
        this.view.setError((err && err.message) || "Couldn't unlink.");
        return;
      }
      this.draft.link = {
        username: null, playerId: null, authState: "unlinked", lastImportAt: null,
      };
      this._agreed = false;
      this._username = "";
      this._password = "";
      this.draft.save();
      this.view.render();
    }

    // ── Fetch step ────────────────────────────────────────────────────────────

    async _fetch() {
      if (this._fetching) return;
      const seq = ++this._fetchSeq;
      this._fetching = true;
      this._fetchProgress = null;
      this.view.clearError();
      this.view.render();
      this._startPolling(seq);

      try {
        const res = await window.Bga.fetchTables();
        if (seq !== this._fetchSeq) return;
        this.draft.ingest(res);
        // The buddy list may have landed while the sweep ran; suggest against
        // whatever is in hand now, and again when it arrives if it has not.
        if (this._partners) this.draft.suggestPlayers(this._partners);
        this.draft.step = 2; // players
        this.draft.save();
      } catch (err) {
        if (seq !== this._fetchSeq) return;
        this._fetching = false;
        this._stopPolling();
        this.view.setError(
          (err && err.message) || "Couldn't read your Board Game Arena history.",
        );
        return;
      } finally {
        this._stopPolling();
      }
      if (seq !== this._fetchSeq) return;
      this._fetching = false;
      this._fetchProgress = null;
      this.view.render();
    }

    /**
     * Poll the sweep's ledger while it runs.
     *
     * Seq-guarded like the fetch itself, and stood down on every exit path
     * including `resetFormState` — a timer left running against a view nobody
     * is looking at is the leak, and it would also keep re-rendering over
     * whatever the user moved on to.
     */
    _startPolling(seq) {
      this._stopPolling();
      this._pollTimer = setInterval(async () => {
        if (seq !== this._fetchSeq || !this._fetching) { this._stopPolling(); return; }
        try {
          const snap = await window.Bga.progress();
          if (seq !== this._fetchSeq || !this._fetching) return;
          this._fetchProgress = snap;
          if (this.draft.stepName === "fetch") this.view.render();
        } catch (_) {
          // A missed poll is a missed frame of narration, never an error the
          // user should see — the sweep itself is still running.
        }
      }, window.BgaImport.pollMs);
    }

    _stopPolling() {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    }

    // ── Players step ──────────────────────────────────────────────────────────

    async _loadPartners() {
      this._loadingPartners = true;
      this._partners = await window.ImportPeople.loadPartners();
      this._loadingPartners = false;
      if (this.draft.handles.length) {
        this.draft.suggestPlayers(this._partners);
        this.draft.save();
      }
      // A sheet opened before this landed is showing ghosts and nothing else.
      if (this._sheetHandle && window.PlayerPickerSheet.isOpen()) {
        const candidates = window.ImportPeople.candidates(this._partners);
        window.PlayerPickerSheet.setCandidates(
          candidates, null, this._closest(this._sheetHandle, candidates));
      }
      if (this.draft.stepName === "players") this.view.render();
    }

    /**
     * The candidates closest to a BGA handle, ranked USERNAME-FIRST.
     *
     * domain/name-match.js docks a penalty off every field after the first, so
     * the field order is the whole signal. A note writes people the way you
     * say them out loud, which is why the default ranks display names first; a
     * BGA handle IS a username, so this flips it. Without the flip, "tiggy42"
     * is scored against "Sarah Bell" before it is scored against "tiggy42".
     */
    _closest(handle, candidates) {
      return window.ImportPeople.closestTo(handle, candidates, 5,
        (c) => [c.username, c.name]);
    }

    _openPlayerSheet(handle) {
      // Held so a buddy list that lands while the sheet is open can re-rank
      // and refill it.
      this._sheetHandle = handle;
      const candidates = window.ImportPeople.candidates(this._partners);
      const close = this._closest(handle, candidates);
      const current = this.draft.playerMapping(handle);

      window.PlayerPickerSheet.open({
        candidates,
        suggestions: close,
        suggestionsLabel: `Closest to “${handle}”`,
        restLabel: "Everyone you play with",
        singleSelect: true,
        title: `Who is “${handle}”?`,
        sub: "Match an account, or keep them as a ghost player.",
        selectedName: current.label,
        guestName: current.kind === "ghost" ? current.label : handle,
        guestTitle: `Keep “${current.kind === "ghost" ? current.label : handle}” as a ghost player`,
        guestHint: "No account — they can claim these plays later",
        searchAll: (q) => window.ImportPeople.searchEveryone(q),
        searchAllLabel: "Search all of BoardgameBuddy",
        returnFocus: document.activeElement,
        onConfirm: (picks) => {
          const pick = picks && picks[0];
          if (!pick) return;
          // ByHand, so the row stops claiming "matched before" about an answer
          // the user has just corrected.
          this.draft.setPlayerByHand(handle, pick.user_id
            ? { kind: "buddy", userId: pick.user_id, label: pick.name }
            : { kind: "ghost", userId: null, label: pick.name });
          this.draft.save();
          this.view.render();
        },
      });
    }

    // ── Games step ────────────────────────────────────────────────────────────

    _openGameSheet(gameName) {
      window.GameSearchSheet.open({
        title: `Which game is “${gameName}”?`,
        placeholder: "Search for a game…",
        returnFocus: document.activeElement,
        onPick: (game) => {
          this.draft.setGame(gameName, game);
          this.draft.save();
          this.view.render();
        },
        onError: (err) => showToast((err && err.message) || "Search failed", "error"),
      });
    }
  }

  window.ImportBgaBranch = ImportBgaBranch;
})();
