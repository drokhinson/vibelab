// views/import-wizard-view.js — one importer, several sources.
//
// The screen behind Settings → Play importer. It asks where the plays came
// from, runs that source's own steps, and lands every one of them on the same
// review and the same summary.
//
// There used to be two of these, at /settings/import-plays and
// /settings/import-photos, and they had already converged on most of a shared
// implementation: the same `.imp-*` chrome, the same progress bar, the same
// POST /plays/import write behind a client-minted import_batch_id, the same
// pickers. What they had NOT converged on was the part the user sees last —
// two summaries that differed in one tile and two sentences, and a review that
// only one of them had.
//
// ─── The split ───────────────────────────────────────────────────────────────
//
// This file owns the LIFECYCLE and nothing about how a source's own steps look
// (.claude/rules/ui-object-design.md §4): the header, the step bar, the nav and
// its blocker, the step arithmetic, the error banner, the review's open rows,
// the write, and close-and-discard. Each branch
// (widgets/import-notes-branch.js, widgets/import-photos-branch.js,
// widgets/import-bga-branch.js) owns its own markup, its own handlers and its
// own draft model, and answers a small contract: `steps`, `renderStep`,
// `continueBlocker`, `stepNext`, `stepBack`, `navLabel`, `onEnter`,
// `resetFormState`, `sourceKey`, `draft`.
//
// The three drafts stay three models on purpose — a parse → name-map →
// run-collapse machine, an EXIF → per-file upload machine, and a
// sign-in → sweep → handle-map machine — and what makes one review render all
// of them is that they answer one interface (domain/import-draft.js,
// `@typedef ImportSource`).
//
// ─── Two things that look odd and are not ────────────────────────────────────
//
// 1. THE SOURCE PICKER SHOWS NO PROGRESS BAR. The branches are different
//    lengths (6 steps for a note, 4 for a camera roll, 5 for Board Game
//    Arena), so a counter before the branch is known would have to promise a
//    number nobody can know yet.
//    Once a source is picked the bar counts that branch's real path, and a user
//    only ever walks one, so the lengths differing is invisible.
//
// 2. NO BgbBackGuard. This is a routed screen with a history entry of its own,
//    and arming a guard over one is the bug `.claude/rules/overlays.md` §8b
//    describes: two entries on one url, unwound by two mechanisms, and whichever
//    timer wins decides where the user lands. The sheets this opens arm their
//    own.

(function () {
  // How much of the review list is revealed at a time, in GAME GROUPS rather
  // than rows: a group is a whole game's worth, so this fills a comparable
  // amount of screen whether the import holds two games or twenty.
  const GROUP_BATCH = 4;

  class ImportWizardView extends window.View {
    constructor() {
      super("import-wizard");
      this._scroller = new window.InfiniteScroll({
        onLoadMore: () => this._revealMore(),
      });
      /** The shared review's handler half — see widgets/import-review-host.js. */
      this.review = new window.ImportReviewHost(this);
      this._resetFormState();
    }

    /**
     * Everything transient this SHELL owns. Called from the constructor and
     * the top of onMount — the view is a singleton, so a previous import's
     * half-expanded review list would otherwise paint under the next one.
     *
     * Each branch resets its own alongside this; the draft is not reset here,
     * because onMount has to decide whether to restore it first.
     */
    _resetFormState() {
      /** @type {"notes"|"photos"|"bga"|null} null until a source is picked. */
      this._source = null;
      /** @type {any} The live branch, or null on the picker. */
      this._branch = null;
      this._importing = false;
      this._error = null;
      /** @type {Object<string, boolean>} Review rows the user has opened. */
      this._expanded = {};
      this._shownGroups = GROUP_BATCH;
      // Monotonic, and ADVANCING rather than restarting: a write still in
      // flight from a previous mount must never match again and repaint over
      // whatever the next one is doing.
      this._importSeq = (this._importSeq || 0) + 1;
      for (const b of this._branches()) b.resetFormState();
    }

    /** Every branch, whether or not one is live. */
    _branches() {
      return [
        window.importNotesBranch,
        window.importPhotosBranch,
        window.importBgaBranch,
      ].filter(Boolean);
    }

    /**
     * A lookup rather than a ternary: with three sources a chain of them is
     * one edit away from silently resolving an unknown key to the last arm.
     * @param {"notes"|"photos"|"bga"} source
     */
    _branchFor(source) {
      return {
        notes: window.importNotesBranch,
        photos: window.importPhotosBranch,
        bga: window.importBgaBranch,
      }[source] || null;
    }

    /** The live draft, or null on the picker. */
    get _draft() { return this._branch ? this._branch.draft : null; }

    renderLoading() {
      this.container.innerHTML = this._chrome(
        `<div class="imp-step imp-step--empty">${window.buddyLoader()}</div>`,
        { hideNav: true });
      this.refreshIcons();
    }

    async onMount() {
      this._resetFormState();

      // An unfinished import outranks the ?source= a link carried: a draft is
      // worth more than a URL, and the picker offers it as a row rather than
      // resuming it behind the user's back.
      const saved = window.ImportDraft.restore();
      this._resume = saved;

      const asked = this.params && this.params.source;
      if (!saved && asked && window.ImportDraft.SOURCES.indexOf(asked) !== -1) {
        this._enter(asked, { skipRender: true });
        // The two retired paths resolve here through route aliases, so the
        // address bar still says /settings/import-plays. replaceUrl rather
        // than history.replaceState, because it stamps the back guard.
        window.router.replaceUrl("import-wizard", {});
      }
      this.render();
    }

    async onUnmount() {
      this._scroller.disconnect();
      const d = this._draft;
      // A finished run is cleared rather than saved: its plays are in the
      // database now, and resuming it would offer to write them again.
      if (d && d.progress && d.progress.total && d.progress.done >= d.progress.total) {
        window.ImportDraft.clear();
      } else if (d && d.isDirty) {
        d.save();
      }
      this._resetFormState();
    }

    // ── Chrome ────────────────────────────────────────────────────────────────

    _chrome(body, opts) {
      const d = this._draft;
      return `
        <header class="spoke-head">
          <h2 class="spoke-head__title font-display">Import plays</h2>
          <button class="spoke-head__close" type="button" aria-label="Close"
                  onclick="window.importWizardView._close()">
            <i data-icon="x" class="w-5 h-5"></i>
          </button>
        </header>
        ${d ? window.BgbWizardProgress.render({
          step: d.step,
          total: this._branch.draft.constructor.steps.length,
        }) : ""}
        <div class="imp-body" data-imp-body>
          ${this._error ? this._renderError() : ""}
          ${body}
        </div>
        ${opts && opts.hideNav ? "" : this._renderNav()}
      `;
    }

    /**
     * Back and Continue.
     *
     * The picker has neither: its rows ARE the forward move, and the × is the
     * way out. The last step has only Back, because the CTA that writes lives
     * inside the summary where the numbers it is about to act on are.
     */
    _renderNav() {
      const d = this._draft;
      if (!d) return "";
      const steps = d.constructor.steps;
      const name = d.stepName;
      const last = d.step >= steps.length - 1;
      const blocker = this._continueBlocker();
      const label = this._branch.navLabel(name) || "Continue";
      return `
        <div class="imp-nav">
          <button class="imp-nav__back" type="button"
                  onclick="window.importWizardView._back()">Back</button>
          ${last ? "" : `
            <button class="imp-nav__next" type="button" ${blocker ? "disabled" : ""}
                    ${blocker ? `title="${escapeAttr(blocker)}"` : ""}
                    onclick="window.importWizardView._next()">${escapeHtml(label)}</button>
          `}
        </div>
      `;
    }

    /**
     * Why Continue is unavailable, or null. One place, read by both the
     * button's `disabled` and _next()'s early return, so the two cannot
     * disagree about whether a step is passable.
     */
    _continueBlocker() {
      const d = this._draft;
      if (!d || this._importing) return null;
      if (d.stepName === "review" && !d.importable().length) {
        return "Nothing here can be imported yet.";
      }
      return this._branch.continueBlocker(d.stepName);
    }

    render() {
      const d = this._draft;
      if (!d) {
        this.container.innerHTML = this._chrome(
          window.ImportSourceStep.render({ resume: this._resumeOffer() }),
          { hideNav: true });
        this.refreshIcons();
        this._scroller.observe(null);
        return;
      }

      const name = d.stepName;
      const opts = {
        host: "window.importWizardView.review",
        expanded: this._expanded,
        shownGroups: this._shownGroups,
        importing: this._importing,
        // Branch steps read their own flags off their own branch; these two are
        // the shell's and are passed through because both branches' step
        // bodies already took them.
        preparingPhotos: this._branch._preparingPhotos,
        loadingPartners: this._branch._loadingPartners,
        reading: this._branch._reading,
        readProgress: this._branch._readProgress,
      };

      let body;
      if (name === "review") body = window.ImportReviewStep.review(d, opts);
      else if (name === "import") body = window.ImportReviewStep.summary(d, opts);
      else body = this._branch.renderStep(name, opts);

      // The progress screen replaces the nav with its own buttons: a Back that
      // walks into a half-written import is not a thing to offer.
      const running = name === "import" && (this._importing || !!d.progress);
      this.container.innerHTML = this._chrome(body, { hideNav: running });
      this.refreshIcons();
      this._armScroller();
    }

    _renderError() {
      return `
        <div class="imp-warn" role="alert">
          ${escapeHtml(this._error)}
          <button class="btn btn-ghost btn-xs" type="button"
                  onclick="window.importWizardView._dismissError()">Dismiss</button>
        </div>
      `;
    }

    /** Branches report failures here rather than each drawing their own. */
    setError(message) { this._error = message; this.render(); }
    clearError() { this._error = null; }
    _dismissError() { this._error = null; this.render(); }

    // ── The review list's window ──────────────────────────────────────────────

    /**
     * Re-point the sentinel after EVERY paint. An observer whose target stays
     * intersecting never fires again on its own, so a batch too short to push
     * the sentinel past the margin would stall the list; a fresh observe()
     * always delivers one callback with the current state.
     */
    _armScroller() {
      const d = this._draft;
      if (!d || d.stepName !== "review") { this._scroller.observe(null); return; }
      this._scroller.observe(this.container.querySelector("[data-imp-sentinel]"));
    }

    _revealMore() {
      const d = this._draft;
      if (!d) return;
      if (this._shownGroups >= d.reviewGroups().length) return;
      this._shownGroups += GROUP_BATCH;
      this.render();
    }

    // ── Picking a source ──────────────────────────────────────────────────────

    /**
     * The Resume row's label, or null when there is nothing to resume.
     *
     * A switch rather than a ternary chain, for the same reason _branchFor is
     * a lookup: with three sources, "the last arm catches everything" stops
     * being obviously right.
     */
    _resumeOffer() {
      if (!this._resume) return null;
      const m = this._resume.model;
      let label;
      if (m.sourceKey === "notes") {
        const n = m.liveCount;
        label = `A note with ${n} play${n === 1 ? "" : "s"} read out of it`;
      } else if (m.sourceKey === "photos") {
        const n = m.shots.length;
        label = `${n} photo${n === 1 ? "" : "s"} you were still assigning`;
      } else {
        const n = m.liveCount;
        label = `${n} Board Game Arena table${n === 1 ? "" : "s"} you were still assigning`;
      }
      return { source: this._resume.source, label };
    }

    /** @param {"notes"|"photos"|"bga"} source */
    _pickSource(source) {
      // Picking a source discards any OTHER source's unfinished draft — there
      // is one import at a time, and two half-finished ones in localStorage is
      // how a resume offers the wrong thing.
      if (this._resume && this._resume.source !== source) window.ImportDraft.clear();
      this._resume = null;
      this._enter(source);
    }

    _resumeDraft() {
      if (!this._resume) return;
      const { source, model } = this._resume;
      this._resume = null;
      this._source = source;
      this._branch = this._branchFor(source);
      this._branch.draft = model;
      this._branch.onEnter();
      this.render();
    }

    /** @param {"notes"|"photos"|"bga"} source */
    _enter(source, opts) {
      this._source = source;
      this._branch = this._branchFor(source);
      this._branch.draft.reset();
      this._expanded = {};
      this._shownGroups = GROUP_BATCH;
      window.ImportDraft.remember(source);
      this._branch.onEnter();
      if (!(opts && opts.skipRender)) this.render();
    }

    /**
     * Leave the branch and go back to the picker.
     *
     * Confirmed when there is anything to lose. Backing out of "pick photos"
     * with thirty files read, and silently dropping them, is the bug; a clean
     * draft goes back for free.
     */
    async _unpickSource() {
      const d = this._draft;
      if (d && d.isDirty) {
        const ok = await window.PolaroidPopup.confirm({
          title: "Start from a different source?",
          body: "What you've done here so far won't be kept.",
          confirmLabel: "Start over",
          cancelLabel: "Keep going",
          destructive: true,
        });
        if (!ok) return;
      }
      window.ImportDraft.clear();
      if (d) d.reset();
      this._source = null;
      this._branch = null;
      this._error = null;
      this.render();
    }

    // ── Moving between steps ──────────────────────────────────────────────────

    async _next() {
      const d = this._draft;
      if (!d || this._importing) return;
      if (this._continueBlocker()) return;
      // The branch gets first refusal: the note's parse jumps straight to
      // Players, and the photo pager's Continue means "the next photo" until
      // the last one.
      if (await this._branch.stepNext(d.stepName)) return;
      d.step = Math.min(d.step + 1, d.constructor.steps.length - 1);
      this._expanded = {};
      this._shownGroups = GROUP_BATCH;
      d.save();
      this.render();
    }

    async _back() {
      const d = this._draft;
      if (!d || this._importing) return;
      if (this._branch.stepBack(d.stepName)) return;
      if (d.step <= 0) { await this._unpickSource(); return; }
      d.step -= 1;
      d.save();
      this.render();
    }

    /**
     * Dismiss the whole wizard.
     *
     * A close ×, not a back arrow: Settings is reachable from the gear on any
     * screen, so this returns to wherever it was opened from rather than
     * routing somewhere fixed (.claude/rules/web-frontend.md, Close vs back).
     */
    async _close() {
      const d = this._draft;
      if (d && d.isDirty && !d.progress) {
        const ok = await window.PolaroidPopup.confirm({
          title: "Discard this import?",
          body: "Nothing has been saved yet, and this won't be kept.",
          confirmLabel: "Discard",
          cancelLabel: "Keep going",
          destructive: true,
        });
        if (!ok) return;
      }
      window.ImportDraft.clear();
      if (d) d.reset();
      this._resetFormState();
      window.router.back("settings");
    }

    // ── The write ─────────────────────────────────────────────────────────────

    async _startImport() {
      if (this._importing) return;
      const d = this._draft;
      const seq = ++this._importSeq;
      this._importing = true;
      this.render();
      try {
        await d.run(() => {
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
      // Every counter that reads plays is now stale, and a newly-seated ghost
      // is a new buddy candidate.
      window.Play.invalidateDeps();
      window.Buddy.invalidate();
      this.render();
    }

    _finish() {
      const d = this._draft;
      const imported = (d && d.progress && d.progress.imported) || 0;
      window.ImportDraft.clear();
      if (d) d.reset();
      this._resetFormState();
      window.router.go("plays");
      if (imported) {
        showToast(`Imported ${imported} play${imported === 1 ? "" : "s"}`, "success");
      }
    }
  }

  window.ImportWizardView = ImportWizardView;
})();
