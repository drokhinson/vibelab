// widgets/import-notes-branch.js — the note reader's half of the wizard.
//
// Everything about reading a written record into plays: the source step, the
// shorthand hint, the parse, and the two resolution steps that follow it —
// every distinct name onto a person, every distinct game onto the catalog.
//
// It owns no chrome. views/import-wizard-view.js draws the header, the step
// bar, the nav and the shared review; this answers the branch contract
// (`steps`, `renderStep`, `continueBlocker`, `stepNext`, `stepBack`,
// `navLabel`, `onEnter`, `resetFormState`) and holds the handlers its own step
// bodies call by name.
//
// Was views/import-plays-view.js, whose route is now one of the wizard's two
// branches. The handlers are unchanged; what left is the shell around them.
//
// RESOLVING A NAME ONCE is why this branch keeps two steps the photo branch has
// no equivalent of. A note that says "Jas" in one line and "Jasmine" in another
// wrote one person twice, and a 106-play tally names maybe eight people — doing
// that per row in the review would be forty corrections instead of eight.

(function () {
  class ImportNotesBranch {
    constructor() {
      this.draft = new window.PlayImport();
      this.resetFormState();
    }

    /** The shell. Held by name rather than by reference: init.js builds the
     *  branch first, and an inline handler resolves it at click time anyway. */
    get view() { return window.importWizardView; }

    /** @returns {"notes"} */
    get sourceKey() { return "notes"; }

    /**
     * This branch's own steps, between the source picker and the shared
     * review. `source` keeps its name from when it WAS the first screen; it is
     * the paste box, and the picker above it is what "source" now means to the
     * user.
     */
    get steps() { return ["source", "details", "players", "games"]; }

    /** @param {string} name @param {any} opts */
    renderStep(name, opts) {
      return window.ImportNotesSteps[name](this.draft, opts);
    }

    /** Fired when the wizard enters this branch, and on every mount. */
    onEnter() {
      // Not awaited: the Players step paints its rows unmatched and settles
      // when this lands.
      this._loadPartners();
    }

    /**
     * The label on the wizard's Continue button for one of this branch's
     * steps, or null for the default.
     *
     * "Read my notes" rather than "Continue" on the step that fires the parse:
     * it is the one press here that costs real time and money, and a button
     * that says what it is about to do is the difference between waiting and
     * wondering.
     */
    navLabel(stepName) {
      if (this._parsing) return "Reading your notes…";
      if (stepName !== "details") return null;
      return this.draft.photos.length ? "Read my photos" : "Read my notes";
    }

    /**
     * Advance within the branch. Returns true when this branch handled the
     * step change itself — the parse jumps straight to Players — and false to
     * let the shell move on by one.
     * @param {string} stepName
     */
    async stepNext(stepName) {
      if (stepName === "details") {
        await this._parse();
        return true;
      }
      if (stepName === "games" && this.draft.unresolvedGames().length) {
        const cost = this.draft.unresolvedGames()
          .reduce((n, g) => n + g.plays, 0);
        const ok = await window.PolaroidPopup.confirm({
          title: `Leave ${cost} play${cost === 1 ? "" : "s"} out?`,
          body: "A play with no game matched can't be imported. You can match "
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
     * singletons, so a previous run's parse state would otherwise paint under
     * the next one.
     *
     * The shell owns the review's open rows, the import flags and the error
     * banner — they are the same for every source. The draft itself is not
     * reset here either: the shell decides whether to restore or start over,
     * and it needs the saved one intact to make that call.
     */
    resetFormState() {
      this._parsing = false;
      // Compressing and encoding a few phone photos takes a visible moment, so
      // Continue is blocked and the strip shows a placeholder while it runs.
      this._preparingPhotos = false;
      this._partners = null;
      this._loadingPartners = false;
      // Monotonic. Captured before every await, checked in both the success and
      // the error path, so a slow parse the user has already navigated away
      // from can't paint over whatever they moved on to. It ADVANCES on reset
      // rather than restarting, so a parse still in flight from the previous
      // mount never matches again — restarting it at 0 is the bug the photo
      // branch used to carry.
      this._parseSeq = (this._parseSeq || 0) + 1;
      /** The parsed name the player sheet is currently asking about. */
      this._sheetName = null;
    }

    /**
     * Why Continue is unavailable on one of this branch's steps, or null.
     * One place, so the nav's `disabled` and the shell's own guard cannot
     * disagree about it.
     * @param {string} stepName
     */
    continueBlocker(stepName) {
      if (stepName === "source") {
        if (this._preparingPhotos) return "Still reading your photos…";
        if (this.draft.text.length > window.PlayImport.maxChars) {
          return "That note is too long — trim it a little.";
        }
        if (!this.draft.text.trim().length && !this.draft.photos.length) {
          return "Paste a note, or add a photo of one.";
        }
      }
      return null;
    }


    // ── Step 1 & 2 ────────────────────────────────────────────────────────────

    _onSourceInput(value) {
      this.draft.text = value;
      // No re-render: the textarea is the source of truth while it has focus,
      // and repainting it would drop the caret mid-paste. Patch the two things
      // that must stay live instead — Continue's disabled state and the
      // character count, which is the only warning before the cap bites.
      this._syncNext();
      this._syncCount();
    }


    _onHintInput(value) { this.draft.hint = value; }


    _useHint(text) {
      this.draft.hint = text;
      this.view.render();
    }


    /** Patch the Continue button in place rather than repainting the step. */
    _syncNext() {
      const btn = this.view.container.querySelector(".imp-nav__next");
      if (btn) {
        /** @type {HTMLButtonElement} */ (btn).disabled =
          !!this.continueBlocker(this.draft.stepName);
      }
    }


    /** Same, for the character counter under the paste box. */
    _syncCount() {
      const el = this.view.container.querySelector(".imp-count");
      if (!el) return;
      const used = this.draft.text.length;
      const max = window.PlayImport.maxChars;
      el.textContent = `${used.toLocaleString()} / ${max.toLocaleString()}`;
      el.classList.toggle("is-over", used > max);
    }


    /**
     * Read a .txt/.md/.csv into the textarea. Nothing is uploaded — the same
     * client-side read the chapter editor's "Import .md" does.
     */
    /**
     * Photograph the note instead of typing it. Each file is downscaled and
     * re-encoded in the browser before it becomes base64: a 12MP phone shot is
     * 6-10 MB, and four of those inline in one JSON body is a request no
     * amount of patience gets through.
     *
     * Prepared one at a time rather than in parallel. Each one decodes a full-
     * size bitmap and paints it into a canvas, and four of those at once on a
     * phone is where the tab gets killed for memory — a couple of seconds
     * against a progress line is the better trade.
     */
    async _onPhotoPick(event) {
      const input = event && event.target;
      const files = Array.from((input && input.files) || []);
      // Reset first, so picking the same photo twice fires onchange again —
      // and so an early return below can't leave the input holding a file.
      if (input) input.value = "";
      if (!files.length || this._preparingPhotos) return;

      const room = this.draft.photoRoom;
      if (!room) {
        showToast(`That's the most photos one import can take (${window.PlayImport.maxPhotos}).`, "info");
        return;
      }
      if (files.length > room) {
        showToast(`Taking the first ${room} — ${window.PlayImport.maxPhotos} photos is the most one import can read.`, "info");
      }

      this._preparingPhotos = true;
      this.view.render();
      let failed = 0;
      for (const file of files.slice(0, room)) {
        let prepared;
        try {
          prepared = await window.preparePhotoForUpload(file, window.IMPORT_PHOTO_OPTS);
        } catch (_) {
          prepared = { ok: false, error: "Couldn't read that photo." };
        }
        if (!prepared.ok) { failed++; showToast(prepared.error, "error"); continue; }
        let data;
        try {
          data = await window.fileToBase64(prepared.file);
        } catch (err) {
          failed++;
          showToast((err && err.message) || "Couldn't read that photo.", "error");
          continue;
        }
        // The draft is a singleton and the user can close the importer
        // mid-encode; adding to a draft they have already discarded would
        // resurrect it on the next open.
        if (this.draft.stepName !== "source") break;
        this.draft.addPhoto({
          id: `ph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          mime: prepared.file.type,
          data,
          url: URL.createObjectURL(prepared.file),
          bytes: prepared.file.size,
        });
      }
      this._preparingPhotos = false;
      if (!failed) this.draft.save();
      this.view.render();
    }


    /** @param {string} id */
    _removePhoto(id) {
      this.draft.removePhoto(id);
      this.view.render();
    }


    _onFilePick(event) {
      const input = event && event.target;
      const file = input && input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "")
          .replace(/^﻿/, "")
          .replace(/\r\n?/g, "\n");
        this.draft.text = text.slice(0, window.PlayImport.maxChars);
        if (text.length > window.PlayImport.maxChars) {
          showToast("That file was too long — I kept the first part.", "info");
        }
        this.view.render();
      };
      reader.onerror = () => showToast("Couldn't read that file", "error");
      reader.readAsText(file);
      // Reset so picking the same file twice fires onchange the second time.
      input.value = "";
    }


    // ── The parse ─────────────────────────────────────────────────────────────

    async _parse() {
      const seq = ++this._parseSeq;
      this._parsing = true;
      this.view.clearError();
      this.view.render();
      try {
        await this.draft.parse();
      } catch (err) {
        if (seq !== this._parseSeq) return;
        this._parsing = false;
        this.view.setError((err && err.message) || "Couldn't read that note.");
        return;
      }
      if (seq !== this._parseSeq) return;
      this._parsing = false;
      // Suggestions run against whatever the partner load has by now. When it
      // hasn't landed, _loadPartners re-runs them on arrival — a name the user
      // has since decided about is never re-suggested.
      this.draft.suggestPlayers(this._partners || {});
      this.draft.step = window.PlayImport.steps.indexOf("players");
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


    // ── Players step ──────────────────────────────────────────────────────────

    _openPlayerSheet(name) {
      // Held so a buddy list that lands while the sheet is open can re-rank
      // and refill it, rather than leaving the user staring at the ghosts-only
      // list this whole change exists to fix.
      this._sheetName = name;
      const candidates = window.ImportPeople.candidates(this._partners);
      // Ranked by the same score that pre-filled the row behind the sheet
      // (domain/name-match.js), so the model's answer is the first row and its
      // runners-up are the next few — a note that says "Jas" opens on Jasmine
      // and Jason rather than on an alphabetical list of ghosts.
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
        // Everyone the buddy list doesn't hold. The local list above is cached
        // (domain/buddy.js SWRs it for a day) and answers the keystroke; the
        // sheet runs this debounced behind it and appends what it finds.
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

  window.ImportNotesBranch = ImportNotesBranch;
})();
