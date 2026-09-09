// @ts-check
// views/photo-import-view.js — logging past games from a camera roll.
//
// Reached from Settings, beside the notes importer. The two are deliberately
// separate front doors: that one reads a written record and asks the user to
// check what a model made of it, this one reads a phone's own metadata and
// asks the user for the half no file could ever hold.
//
// Three steps: pick the photos, go through them one at a time, import.
//
//   • THE READ HAPPENS AT PICK TIME, ON THE DEVICE. Each file is opened twice
//     — once by domain/exif.js for its date and coordinate, once by
//     preparePhotoForUpload to become the play's photo. The coordinate is
//     turned into a country by domain/geo-grid.js and then dropped; it never
//     reaches the network and it is never written to the draft.
//
//   • THE PAGER IS THE STEP. "Continue" on the assign step moves to the next
//     photo and only becomes "Review" on the last one, so there is one forward
//     control on screen rather than two competing ones. The filmstrip along
//     the top is how you skip around, and how you see at a glance which photos
//     still have no game.
//
//   • THE ASSIGNMENT SHEETS ARE THE ONES THE REST OF THE APP USES —
//     GameSearchSheet, PlayerPickerSheet, CountryPickerSheet. Picking a game
//     here is the same interaction as picking one in Gather, which is the
//     point: this screen is unfamiliar enough already.

(function () {
  // Close matches offered above the full list on the player sheet. Same
  // number, and the same reasoning, as the notes importer's SUGGEST_MAX.
  const SUGGEST_MAX = 5;

  class PhotoImportView extends window.View {
    constructor() {
      super("photo-import");
      this._draft = new window.PhotoImport();
      this._resetFormState();
    }

    /**
     * Everything transient. Called from the constructor AND the top of
     * onMount: this view is a singleton, so a previous run's error or
     * half-finished read would otherwise paint under the next one.
     * The draft itself is NOT reset here — onMount decides whether to restore.
     */
    _resetFormState() {
      // Reading a batch of photos is seconds of work per file, so Continue is
      // blocked and a counter runs while it happens.
      this._reading = false;
      this._readProgress = null;
      this._importing = false;
      this._error = null;
      this._partners = null;
      this._loadingPartners = false;
      // Monotonic guards. Captured before every await and checked in both the
      // success and the error path, so a slow read the user has navigated away
      // from can't paint over whatever they moved on to.
      this._readSeq = 0;
      this._importSeq = 0;
    }

    renderLoading() {
      // Synchronous, before onMount. The restore below is sync too, so this
      // only shows for a frame — but a step this view can't name yet must not
      // paint as step 1.
      this.container.innerHTML = this._chrome(`
        <div class="imp-step">${buddyLoader({ size: 96, label: "Opening the importer…" })}</div>
      `);
      this.refreshIcons();
    }

    async onMount() {
      this._resetFormState();
      if (!this._draft.restore()) this._draft.reset();
      this.render();
      // Not awaited before the first paint: the player sheet is two taps away
      // and every row renders fine without it, so blocking the screen on a
      // buddy list nobody has asked for yet is a round trip of blank screen.
      this._loadPartners();
      // Nor is this — it is 162 KB of border data, and the first photo can't
      // be picked in the time it takes to arrive. _onPick awaits it properly.
      this._warmGeo();
    }

    async onUnmount() {
      // Save rather than clear: leaving mid-wizard is not abandoning it, and
      // the close button is the path that clears (see _close).
      //
      // A finished run is the exception. Its plays are written, and the only
      // thing a restored copy of it could offer is a wizard full of photos
      // that aren't there any more, standing over an import that already
      // happened. `progress` is cleared by reset(), so the draft the user
      // walked away from mid-assignment is unaffected.
      const p = this._draft.progress;
      if (p && p.total && p.done >= p.total) { this._draft.clearDraft(); return; }
      if (this._draft.isDirty) this._draft.save();
    }

    _warmGeo() {
      try { window.BgbGeoGrid.load(); } catch (_) { /* resolved again in _onPick */ }
    }

    // ── Chrome ────────────────────────────────────────────────────────────────

    _chrome(body, opts) {
      const steps = window.PhotoImport.steps;
      const o = opts || {};
      return `
        <header class="spoke-head">
          <h2 class="spoke-head__title font-display">Import from photos</h2>
          <button class="spoke-head__close" onclick="window.photoImportView._close()"
                  aria-label="Close importer">
            <i data-icon="x" class="w-4 h-4"></i>
          </button>
        </header>
        ${window.BgbWizardProgress.render({ step: this._draft.step, total: steps.length })}
        <div class="imp-body" data-imp-body>${body}</div>
        ${o.hideNav ? "" : this._renderNav()}
      `;
    }

    _renderNav() {
      const d = this._draft;
      if (d.stepName === "import") {
        return `
          <div class="imp-nav">
            <button class="imp-nav__back" type="button" ${this._importing ? "disabled" : ""}
                    onclick="window.photoImportView._back()">Back</button>
          </div>
        `;
      }
      const busy = this._reading;
      const blocked = !!this._continueBlocker();
      const onLast = d.stepName === "assign" && d.cursor >= d.shots.length - 1;
      const label = d.stepName === "photos"
        ? "Start assigning"
        : (onLast ? "Review" : "Next photo");
      return `
        <div class="imp-nav">
          ${d.step > 0 || d.cursor > 0 ? `
            <button class="imp-nav__back" type="button" ${busy ? "disabled" : ""}
                    onclick="window.photoImportView._back()">Back</button>
          ` : ""}
          <button class="imp-nav__next" type="button" ${busy || blocked ? "disabled" : ""}
                  onclick="window.photoImportView._next()">
            ${busy ? "Reading your photos…" : label}
          </button>
        </div>
      `;
    }

    /** Null when Continue is allowed, else why it isn't. */
    _continueBlocker() {
      const d = this._draft;
      if (d.stepName === "photos") {
        if (this._reading) return "reading";
        return d.shots.length ? null : "empty";
      }
      // The assign step never blocks. A photo with no game is left out of the
      // import and said so on the last step — the same rule the notes
      // importer's Games step follows, and the one that lets somebody assign
      // twelve of their thirty photos today.
      return null;
    }

    render() {
      const d = this._draft;
      if (this._error) {
        this.container.innerHTML = this._chrome(this._renderError());
        this.refreshIcons();
        return;
      }
      const body = window.PhotoImportSteps[d.stepName](d, {
        reading: this._reading,
        readProgress: this._readProgress,
        loadingPartners: this._loadingPartners,
        importing: this._importing,
      });
      // The last step hides the nav while a run is in flight: there is nothing
      // to go back to mid-write, and a Back button there invites the one tap
      // that would leave the user unsure what landed.
      this.container.innerHTML = this._chrome(body, {
        hideNav: d.stepName === "import" && (this._importing || !!d.progress),
      });
      this.refreshIcons();
      this._scrollStripToCursor();
    }

    _renderError() {
      return `
        <div class="imp-step imp-step--empty">
          <img class="imp-empty__art" src="assets/illustrations/bgb-loading.svg" alt="" />
          <h3 class="imp-step__title font-display">That didn't work</h3>
          <p class="imp-step__lede">${escapeHtml(this._error)}</p>
          <button class="imp-cta" type="button" onclick="window.photoImportView._dismissError()">
            Back to my photos
          </button>
        </div>
      `;
    }

    _dismissError() {
      this._error = null;
      this.render();
    }

    /** Keep the current thumbnail in view when the pager moves by button. */
    _scrollStripToCursor() {
      const strip = this.container.querySelector("[data-pimp-strip]");
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

      const room = this._draft.room;
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
      this.render();

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

        this._draft.addShot({
          id: window.PhotoImport.newId(),
          label: file.name || "",
          file: prepared.file,
          url: URL.createObjectURL(prepared.file),
          playedAt: when.date,
          dateSource: when.source,
          countryCode: country,
          countrySource: country ? "photo" : null,
          game: null,
          players: [],
          notes: null,
          photoUrl: null,
        });
        this._readProgress.done++;
        this.render();
      }

      if (seq !== this._readSeq) return;
      // A photo taken indoors after the GPS lock dropped borrows the country
      // from another photo of the same day. See PhotoImport#inferMissingCountries.
      this._draft.inferMissingCountries();
      this._reading = false;
      this._readProgress = null;
      if (!failed) this._draft.save();
      this.render();
    }

    _removeShot(id) {
      this._draft.removeShot(id);
      this._draft.save();
      this.render();
    }

    // ── Navigation ────────────────────────────────────────────────────────────

    _next() {
      const d = this._draft;
      if (this._continueBlocker() || this._reading) return;
      if (d.stepName === "photos") {
        d.step = window.PhotoImport.steps.indexOf("assign");
        d.cursor = 0;
      } else if (d.stepName === "assign") {
        if (d.cursor < d.shots.length - 1) d.cursor++;
        else d.step = window.PhotoImport.steps.indexOf("import");
      }
      d.save();
      this.render();
    }

    _back() {
      const d = this._draft;
      if (this._reading || this._importing) return;
      if (d.stepName === "assign" && d.cursor > 0) d.cursor--;
      else if (d.stepName === "import") {
        d.step = window.PhotoImport.steps.indexOf("assign");
        d.cursor = Math.max(0, d.shots.length - 1);
      } else if (d.stepName === "assign") {
        d.step = window.PhotoImport.steps.indexOf("photos");
      }
      d.save();
      this.render();
    }

    /** @param {number} n Filmstrip jump. */
    _goTo(n) {
      const d = this._draft;
      if (n < 0 || n >= d.shots.length) return;
      d.cursor = n;
      d.save();
      this.render();
    }

    async _close() {
      if (this._draft.isDirty && !this._draft.progress) {
        const ok = await window.PolaroidPopup.confirm({
          title: "Discard this import?",
          body: "Your photos and everything you've matched so far will be lost. Nothing has been added to your plays.",
          confirmLabel: "Discard",
          cancelLabel: "Keep going",
          destructive: true,
        });
        if (!ok) return;
      }
      this._draft.clearDraft();
      this._draft.reset();
      this._resetFormState();
      window.router.back("settings");
    }

    // ── Step 2: the one photo in front of you ─────────────────────────────────

    _onDate(value) {
      const shot = this._draft.current;
      if (!shot) return;
      this._draft.setDate(shot.id, value);
      this._draft.save();
      this.render();
    }

    _onNotes(value) {
      const shot = this._draft.current;
      if (!shot) return;
      this._draft.setNotes(shot.id, value);
      this._draft.save();
      // No re-render: the textarea is the source of truth while it has focus,
      // and repainting it would drop the caret.
    }

    _removeSeat(name) {
      const shot = this._draft.current;
      if (!shot) return;
      this._draft.removeSeat(shot.id, name);
      this._draft.save();
      this.render();
    }

    _toggleWinner(name) {
      const shot = this._draft.current;
      if (!shot) return;
      this._draft.toggleWinner(shot.id, name);
      this._draft.save();
      this.render();
    }

    _copyPrevious() {
      const shot = this._draft.current;
      if (!shot) return;
      if (!this._draft.copyFromPrevious(shot.id)) return;
      this._draft.save();
      this.render();
    }

    async _dropCurrent() {
      const shot = this._draft.current;
      if (!shot) return;
      const ok = await window.PolaroidPopup.confirm({
        title: "Leave this photo out?",
        body: "It won't become a play. Nothing has been saved yet, so you can start the importer again if you change your mind.",
        confirmLabel: "Leave it out",
        cancelLabel: "Keep it",
        destructive: true,
      });
      if (!ok) return;
      const wasLast = this._draft.shots.length === 1;
      this._draft.removeShot(shot.id);
      this._draft.save();
      if (wasLast) {
        // Nothing left to assign. Back to the pick step, or — for a restored
        // draft that has no files to pick — out of the wizard entirely.
        this._draft.step = window.PhotoImport.steps.indexOf("photos");
      }
      this.render();
    }

    _openGameSheet() {
      const shot = this._draft.current;
      if (!shot) return;
      window.GameSearchSheet.open({
        title: "Which game is this?",
        placeholder: "Search for a game…",
        returnFocus: document.activeElement,
        onPick: (game) => {
          this._draft.setGame(shot.id, game);
          this._draft.save();
          this.render();
        },
        onError: (err) => showToast((err && err.message) || "Search failed", "error"),
      });
    }

    _openCountrySheet() {
      const shot = this._draft.current;
      if (!shot) return;
      window.CountryPickerSheet.open({
        title: "Where was this played?",
        selectedCode: shot.countryCode,
        returnFocus: document.activeElement,
        onPick: (code) => {
          this._draft.setCountry(shot.id, code);
          this._draft.save();
          this.render();
        },
      });
    }

    /**
     * Who was at this table. Multi-select, because the answer is a table
     * rather than one person — the same sheet, in the same mode, that Gather
     * seats players with.
     */
    _openPlayerSheet() {
      const shot = this._draft.current;
      if (!shot) return;
      const candidates = this._playerCandidates();
      // Seated identity, not seated SPELLING. An account picked off the buddy
      // list carries its display name and the same account found through
      // "search all of BoardgameBuddy" can carry another, so a name-only set
      // let one person be seated twice in one play — which migration 023's
      // unique index now refuses outright, and which nobody should be able to
      // ask for in the first place.
      const alreadySeated = new Set(shot.players.map((p) => p.name));
      const seatedAccounts = new Set(shot.players.map((p) => p.userId).filter(Boolean));
      window.PlayerPickerSheet.open({
        candidates,
        recent: this._recentCandidates(candidates, alreadySeated, seatedAccounts),
        seated: shot.players.length,
        title: "Who played?",
        sub: "Anyone without an account comes in as a ghost player, and can claim these plays later.",
        searchAll: (q) => this._searchEveryone(q),
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
          this._draft.setPlayers(shot.id, next);
          this._draft.save();
          this.render();
        },
      });
    }

    async _loadPartners() {
      this._loadingPartners = true;
      let data = null;
      try {
        data = await window.Buddy.allBuddies();
      } catch (_) {
        // A missing buddy list costs the pre-filled rows, not the import:
        // every name is still typeable and still importable as a ghost.
        data = null;
      }
      this._loadingPartners = false;
      this._partners = data || { accounts: [], ghosts: [], recent: [] };
    }

    /**
     * Everyone the picker can offer without a round trip: the viewer, their
     * buddies, everyone they've shared a table with, and their own ghosts.
     *
     * YOU come first, for the same reason as in the notes importer:
     * /play-partners never returns the viewer, because every other caller has
     * already seated them. Here nobody has, so an importer who leaves
     * themselves out of their own game night loses the plays AND the wins.
     */
    _playerCandidates() {
      const me = window.store.get("user");
      const rows = [
        ...(me ? [{
          source: "account",
          user_id: me.id,
          name: me.display_name || "You",
          username: me.username || null,
          avatar: me.avatar || null,
          isViewer: true,
        }] : []),
        ...window.Buddy.toPlayerCandidates(this._partners),
      ].filter((c) => c.name);
      const seenIds = new Set();
      return rows.filter((c) => {
        if (!c.user_id) return true;
        if (seenIds.has(c.user_id)) return false;
        seenIds.add(c.user_id);
        return true;
      });
    }

    /**
     * The empty-query list: people this account has actually played with, most
     * frequent first (the server orders `recent` by play count). Cross-
     * referenced against the candidates so the unified shape is kept and
     * anyone already at this table is left out — the same shape play-flow's
     * Gather screen hands the sheet, because it is the same sheet.
     * @param {any[]} candidates
     * @param {Set<string>} seated Names already on this shot.
     * @param {Set<string>} seatedAccounts Account ids already on this shot.
     */
    _recentCandidates(candidates, seated, seatedAccounts) {
      const byUserId = new Map(candidates.filter((c) => c.user_id).map((c) => [c.user_id, c]));
      const taken = new Set(Array.from(seated).map((n) => String(n).toLowerCase()));
      const accounts = seatedAccounts || new Set();
      const rows = [];
      for (const r of ((this._partners && this._partners.recent) || [])) {
        if (!r) continue;
        // Offering somebody who is already at this table is offering a seat
        // that cannot be taken — the confirm handler drops it, so the row
        // would just do nothing.
        if (r.user_id && accounts.has(r.user_id)) continue;
        const hit = byUserId.get(r.user_id);
        if (hit) { rows.push(hit); continue; }
        if (r.display_name && !taken.has(String(r.display_name).toLowerCase())) {
          rows.push({
            source: "account",
            user_id: r.user_id,
            name: r.display_name,
            username: null,
            avatar: r.avatar || null,
          });
        }
      }
      return rows;
    }

    /** @param {string} q */
    async _searchEveryone(q) {
      const hits = await window.Buddy.searchProfiles(q);
      const me = window.store.get("user");
      return (hits || [])
        .filter((h) => h && h.id && (!me || h.id !== me.id))
        .map((h) => ({
          source: "account",
          user_id: h.id,
          name: h.display_name || h.username || "",
          username: h.username || null,
          avatar: h.avatar || null,
        }))
        .filter((c) => c.name);
    }

    // ── The write ─────────────────────────────────────────────────────────────

    async _startImport() {
      if (this._importing) return;
      const seq = ++this._importSeq;
      this._importing = true;
      this.render();
      try {
        await this._draft.run(() => {
          if (seq !== this._importSeq) return;
          this.render();
        });
      } catch (err) {
        if (seq !== this._importSeq) return;
        this._importing = false;
        showToast((err && err.message) || "Import stopped", "error");
        this.render();
        return;
      }
      if (seq !== this._importSeq) return;
      this._importing = false;
      // Every screen that counts plays is now stale — the profile bundle, the
      // game bundles, stats and achievements all derive from them.
      if (window.Play && window.Play.invalidateDeps) window.Play.invalidateDeps();
      if (window.Buddy && window.Buddy.invalidate) window.Buddy.invalidate();
      this.render();
    }

    _finish() {
      const imported = (this._draft.progress && this._draft.progress.imported) || 0;
      this._draft.clearDraft();
      this._draft.reset();
      this._resetFormState();
      window.router.go("plays");
      if (imported) {
        showToast(`Imported ${imported} play${imported === 1 ? "" : "s"}`, "success");
      }
    }
  }

  window.PhotoImportView = PhotoImportView;
})();
