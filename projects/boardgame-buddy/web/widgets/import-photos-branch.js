// widgets/import-photos-branch.js — the camera roll's half of the wizard.
//
// Picking photos, reading each one's date and country off its own EXIF, and
// the pager that assigns a game and a table to each — one shot on screen with
// a filmstrip above it, because a camera roll from one evening is the same six
// people twice and thirty trips through a list is not the way to say that.
//
// It owns no chrome. views/import-wizard-view.js draws the header, the step
// bar, the nav and the shared review; this answers the branch contract
// (`steps`, `renderStep`, `continueBlocker`, `stepNext`, `stepBack`,
// `navLabel`, `onEnter`, `resetFormState`) and holds the handlers its own step
// bodies call by name.
//
// Was views/photo-import-view.js. The pager is unchanged — it is the fast path
// through a bulk assign, and the shared review after it is the considered one.

(function () {
  class ImportPhotosBranch {
    constructor() {
      this.draft = new window.PhotoImport();
      this.resetFormState();
    }

    /** The shell. */
    get view() { return window.importWizardView; }

    /** @returns {"photos"} */
    get sourceKey() { return "photos"; }

    /** Pick, then assign. The review after them is the shell's. */
    get steps() { return ["photos", "assign"]; }

    /** @param {string} name @param {any} opts */
    renderStep(name, opts) {
      return window.ImportPhotosSteps[name](this.draft, opts);
    }

    onEnter() {
      // Neither awaited: the pager paints without them and settles when they
      // land. The border raster is 162 KB and only this branch ever needs it.
      this._loadPartners();
      this._warmGeo();
    }

    /**
     * Everything transient this branch owns — see the notes branch for the
     * split. The shell holds the review's open rows, the import flags and the
     * error banner.
     */
    resetFormState() {
      this._reading = false;
      /** @type {{done: number, total: number}|null} */
      this._readProgress = null;
      this._partners = null;
      this._loadingPartners = false;
      // Monotonic, and ADVANCING rather than restarting. It used to be set
      // back to 0 here while the notes importer's equivalent advanced, so a
      // read still in flight from a previous mount matched the new mount's
      // first seq and painted its photos over it.
      this._readSeq = (this._readSeq || 0) + 1;
    }

    /**
     * Why Continue is unavailable, or null.
     *
     * The assign step never blocks: a photo can be left unassigned and is
     * simply left out, which the review and the summary both count.
     * @param {string} stepName
     */
    continueBlocker(stepName) {
      if (stepName !== "photos") return null;
      if (this._reading) return "Still reading your photos…";
      if (!this.draft.shots.length) return "Pick at least one photo.";
      return null;
    }

    /**
     * The pager IS the step: Continue means "the next photo" until the last
     * one, and only then means "on to the review".
     */
    navLabel(stepName) {
      if (this._reading) return "Reading your photos…";
      if (stepName === "photos") return "Start assigning";
      if (stepName !== "assign") return null;
      return this.draft.cursor >= this.draft.shots.length - 1 ? "Review" : "Next photo";
    }

    /** @param {string} stepName */
    stepNext(stepName) {
      if (stepName !== "assign") return false;
      if (this.draft.cursor >= this.draft.shots.length - 1) return false;
      this.draft.cursor++;
      this.draft.save();
      this.view.render();
      return true;
    }

    /** Back walks the pager before it walks the wizard. */
    stepBack(stepName) {
      if (stepName === "assign" && this.draft.cursor > 0) {
        this.draft.cursor--;
        this.draft.save();
        this.view.render();
        return true;
      }
      // Coming back from the review lands on the LAST photo, not the first:
      // the review is what follows the last one, so that is where the user was.
      if (stepName === "review" && this.draft.shots.length) {
        this.draft.cursor = this.draft.shots.length - 1;
      }
      return false;
    }


    _warmGeo() {
      try { window.BgbGeoGrid.load(); } catch (_) { /* resolved again in _onPick */ }
    }


    /** Keep the current thumbnail in view when the pager moves by button. */
    _scrollStripToCursor() {
      const strip = this.view.container.querySelector("[data-pimp-strip]");
      if (!strip) return;
      const current = strip.querySelector(".pimp-film.is-current");
      if (!current) return;
      // Manual arithmetic rather than scrollIntoView: that scrolls every
      // ancestor, which on this screen means yanking the page down to a
      // filmstrip the user can already see.
      const left = /** @type {HTMLElement} */ (current).offsetLeft
        - (strip.clientWidth - /** @type {HTMLElement} */ (current).offsetWidth) / 2;
      strip.scrollTo({ left: Math.max(0, left), behavior: "auto" });
    }


    // ── Step 1: picking ───────────────────────────────────────────────────────

    /**
     * Read a batch of picked files.
     *
     * One at a time, not in parallel: preparePhotoForUpload decodes a
     * full-size bitmap and paints it into a canvas, and a handful of those at
     * once on a phone is where the tab gets killed for memory. A counter
     * against a disabled Continue is the better trade.
     */
    async _onPick(event) {
      const input = event && event.target;
      const files = Array.from((input && input.files) || []);
      // Reset first, so picking the same photo twice fires onchange again —
      // and so an early return can't leave the input holding a file.
      if (input) input.value = "";
      if (!files.length || this._reading) return;

      const room = this.draft.room;
      if (!room) {
        showToast(`That's the most photos one run can take (${window.PhotoImport.maxShots}).`, "info");
        return;
      }
      if (files.length > room) {
        showToast(`Taking the first ${room} — ${window.PhotoImport.maxShots} photos is the most one run can take.`, "info");
      }

      const batch = files.slice(0, room);
      const seq = ++this._readSeq;
      this._reading = true;
      this._readProgress = { done: 0, total: batch.length };
      this.view.render();

      // Once, before the loop: the raster answers every photo in the batch and
      // a coordinate with no map is the same as no coordinate at all.
      let haveGeo = false;
      try { haveGeo = await window.BgbGeoGrid.load(); } catch (_) { haveGeo = false; }

      let failed = 0;
      for (const file of batch) {
        // EXIF comes off the ORIGINAL file: preparing it for upload re-encodes
        // through a canvas, which is exactly what strips the tags.
        let exif = { takenAt: null, lat: null, lon: null };
        try { exif = await window.BgbExif.read(file); } catch (_) { /* unreadable: defaults */ }

        let prepared;
        try {
          prepared = await window.preparePhotoForUpload(file, window.PHOTO_IMPORT_OPTS);
        } catch (_) {
          prepared = { ok: false, error: "Couldn't read that photo." };
        }
        if (seq !== this._readSeq) return; // the user left, or started over
        if (!prepared.ok) {
          failed++;
          showToast(prepared.error, "error");
          this._readProgress.done++;
          continue;
        }

        const when = window.BgbExif.dateFor(exif, file);
        const country = (haveGeo && exif.lat != null && exif.lon != null)
          ? window.BgbGeoGrid.countryAt(exif.lat, exif.lon)
          : null;

        this.draft.addShot({
          id: window.PhotoImport.newId(),
          label: file.name || "",
          file: prepared.file,
          url: URL.createObjectURL(prepared.file),
          playedAt: when.date,
          dateSource: when.source,
          countryCode: country,
          countrySource: country ? "photo" : null,
          game: null,
          players: window.ImportPeople.viewerSeat(),
          notes: null,
          photoUrl: null,
        });
        this._readProgress.done++;
        this.view.render();
      }

      if (seq !== this._readSeq) return;
      // A photo taken indoors after the GPS lock dropped borrows the country
      // from another photo of the same day. See PhotoImport#inferMissingCountries.
      this.draft.inferMissingCountries();
      this._reading = false;
      this._readProgress = null;
      if (!failed) this.draft.save();
      this.view.render();
    }


    _removeShot(id) {
      this.draft.removeShot(id);
      this.draft.save();
      this.view.render();
    }


    /** @param {number} n Filmstrip jump. */
    _goTo(n) {
      const d = this.draft;
      if (n < 0 || n >= d.shots.length) return;
      d.cursor = n;
      d.save();
      this.view.render();
    }


    // ── Step 2: the one photo in front of you ─────────────────────────────────

    _onDate(value) {
      const shot = this.draft.current;
      if (!shot) return;
      this.draft.setDate(shot.id, value);
      this.draft.save();
      this.view.render();
    }


    _onNotes(value) {
      const shot = this.draft.current;
      if (!shot) return;
      this.draft.setNotes(shot.id, value);
      this.draft.save();
      // No re-render: the textarea is the source of truth while it has focus,
      // and repainting it would drop the caret.
    }


    _removeSeat(who) {
      const shot = this.draft.current;
      if (!shot) return;
      this.draft.removeSeat(shot.id, who);
      this.draft.save();
      this.view.render();
    }


    _toggleWinner(who) {
      const shot = this.draft.current;
      if (!shot) return;
      this.draft.toggleWinner(shot.id, who);
      this.draft.save();
      this.view.render();
    }


    _copyPrevious() {
      const shot = this.draft.current;
      if (!shot) return;
      if (!this.draft.copyFromPrevious(shot.id)) return;
      this.draft.save();
      this.view.render();
    }


    async _dropCurrent() {
      const shot = this.draft.current;
      if (!shot) return;
      const ok = await window.PolaroidPopup.confirm({
        title: "Leave this photo out?",
        body: "It won't become a play. Nothing has been saved yet, so you can start the importer again if you change your mind.",
        confirmLabel: "Leave it out",
        cancelLabel: "Keep it",
        destructive: true,
      });
      if (!ok) return;
      const wasLast = this.draft.shots.length === 1;
      this.draft.removeShot(shot.id);
      this.draft.save();
      if (wasLast) {
        // Nothing left to assign. Back to the pick step, or — for a restored
        // draft that has no files to pick — out of the wizard entirely.
        this.draft.step = window.PhotoImport.steps.indexOf("photos");
      }
      this.view.render();
    }


    _openGameSheet() {
      const shot = this.draft.current;
      if (!shot) return;
      window.GameSearchSheet.open({
        title: "Which game is this?",
        placeholder: "Search for a game…",
        returnFocus: document.activeElement,
        onPick: (game) => {
          this.draft.setGame(shot.id, game);
          this.draft.save();
          this.view.render();
        },
        onError: (err) => showToast((err && err.message) || "Search failed", "error"),
      });
    }


    _openCountrySheet() {
      const shot = this.draft.current;
      if (!shot) return;
      window.CountryPickerSheet.open({
        title: "Where was this played?",
        selectedCode: shot.countryCode,
        returnFocus: document.activeElement,
        onPick: (code) => {
          this.draft.setCountry(shot.id, code);
          this.draft.save();
          this.view.render();
        },
      });
    }


    /**
     * Who was at this table. Multi-select, because the answer is a table
     * rather than one person — the same sheet, in the same mode, that Gather
     * seats players with.
     */
    _openPlayerSheet() {
      const shot = this.draft.current;
      if (!shot) return;
      // Seated identity, not seated SPELLING. An account picked off the buddy
      // list carries its display name and the same account found through
      // "search all of BoardgameBuddy" can carry another, so a name-only set
      // let one person be seated twice in one play — which migration 023's
      // unique index now refuses outright, and which nobody should be able to
      // ask for in the first place.
      const alreadySeated = new Set(shot.players.map((p) => p.name));
      const seatedAccounts = new Set(shot.players.map((p) => p.userId).filter(Boolean));
      // `candidates` is "everyone addable, already filtered of people in the
      // roster by the caller" — the sheet's own contract, which this used to
      // leave to the confirm handler, so a seated row was offered and then
      // silently dropped. Now that the importer is seated by default, that row
      // is YOU, on every single open.
      const seatedNames = new Set(Array.from(alreadySeated).map((n) => String(n).toLowerCase()));
      const runGhosts = window.ImportPeople.ghostsIn(
        this.draft.shots.map((sh) => sh.players || []));
      const candidates = window.ImportPeople
        .candidates(this._partners, runGhosts)
        .filter((c) => (
        c.user_id
          ? !seatedAccounts.has(c.user_id)
          : !seatedNames.has(String(c.name).toLowerCase())
        ));
      window.PlayerPickerSheet.open({
        candidates,
        // The names filtered out above, so the guest row can't offer one of
        // them back under a different spelling.
        seatedNames: Array.from(alreadySeated),
        recent: window.ImportPeople.recent(
          this._partners, runGhosts, candidates, alreadySeated, seatedAccounts),
        seated: shot.players.length,
        title: "Who played?",
        sub: "Anyone without an account comes in as a ghost player, and can claim these plays later.",
        searchAll: (q) => window.ImportPeople.searchEveryone(q),
        searchAllLabel: "Search all of BoardgameBuddy",
        returnFocus: document.activeElement,
        onConfirm: (picks) => {
          // Added to the table rather than replacing it: the sheet answers
          // "who else", and someone re-opening it to add a latecomer must not
          // lose the five people already seated.
          const next = shot.players.slice();
          for (const pick of picks || []) {
            if (!pick || !pick.name || alreadySeated.has(pick.name)) continue;
            if (pick.user_id && seatedAccounts.has(pick.user_id)) continue;
            alreadySeated.add(pick.name);
            if (pick.user_id) seatedAccounts.add(pick.user_id);
            next.push({ name: pick.name, userId: pick.user_id || null, isWinner: false });
          }
          this.draft.setPlayers(shot.id, next);
          this.draft.save();
          this.view.render();
        },
      });
    }


    async _loadPartners() {
      this._loadingPartners = true;
      this._partners = await window.ImportPeople.loadPartners();
      this._loadingPartners = false;
    }
  }

  window.ImportPhotosBranch = ImportPhotosBranch;
})();
