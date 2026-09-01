// @ts-check
// views/import-plays-view.js — the play importer, as a six-step screen.
//
// Reached from Settings. Turns a pasted note into plays: paste it, say how it
// is organised, then resolve the three things the model can only guess at —
// who the players are, which catalog game each play is, and what dates to use
// — before anything is written.
//
// The draft lives in domain/play-import.js and the step bodies in
// widgets/import-plays-steps.js; this file is the shell. It owns the step
// chrome, the two sheets, the drafts, and the two calls that block.
//
// Three things worth knowing:
//
//   • THE COUNTER IS PINNED. "Step 3 of 6" plus a segment bar, above every
//     step, borrowed from widgets/onboarding-deck.js. Someone deciding how far
//     they are can see it without scrolling.
//   • CONTINUE BLOCKS ON EXACTLY TWO STEPS. The parse and the import. Unlike
//     the onboarding deck's fire-and-forget writes, these are things the user
//     is explicitly waiting for, so they get a spinner and a disabled button
//     rather than a slide that moves on without them.
//   • THE REVIEW LIST IS WINDOWED. A note can carry hundreds of plays; the
//     list reveals a few game groups at a time through ui/infinite-scroll.js
//     (.claude/rules/ui-object-design.md §3d).

(function () {
  // Game groups revealed per batch on the Plays step. Groups, not plays: a
  // group is a whole game's worth of rows, so this fills a comparable amount
  // of screen whether the note holds two games or twenty.
  const GROUP_BATCH = 4;

  class ImportPlaysView extends window.View {
    constructor() {
      super("import-plays");
      this._draft = new window.PlayImport();
      this._scroller = new window.InfiniteScroll({
        onLoadMore: () => this._revealMore(),
      });
      this._resetFormState();
    }

    /**
     * Everything transient. Called from the constructor AND the top of
     * onMount: this view is a singleton, so a previous run's parse error or
     * half-expanded review list would otherwise paint under the next one.
     * The draft itself is NOT reset here — onMount decides whether to restore
     * or start over, and it needs the saved one intact to make that call.
     */
    _resetFormState() {
      this._parsing = false;
      this._importing = false;
      this._error = null;
      this._partners = null;
      this._loadingPartners = false;
      /** @type {Object<string, boolean>} Review rows the user has opened. */
      this._expanded = {};
      this._shownGroups = GROUP_BATCH;
      // Monotonic guards. Captured before every await, checked in both the
      // success and the error path, so a slow parse that the user has already
      // navigated away from can't paint over whatever they moved on to.
      this._parseSeq = 0;
      this._importSeq = 0;
    }

    renderLoading() {
      // Synchronous, before onMount. The draft restore below is sync too, so
      // this only ever shows for the frame before render() — but a step this
      // view can't name yet must not paint as step 1.
      this.container.innerHTML = this._chrome(`
        <div class="imp-step">${buddyLoader({ size: 96, label: "Opening the importer…" })}</div>
      `);
      this.refreshIcons();
    }

    async onMount() {
      this._resetFormState();
      // A refresh three steps in resumes where it was. A draft written by an
      // older build reads as absent (see DRAFT_VERSION) rather than
      // half-restoring into a shape this build can't paint.
      if (!this._draft.restore()) this._draft.reset();
      this.render();
      // Not awaited before the first paint: the Players step is reachable in
      // two taps and its rows render fine unmatched, so blocking the whole
      // screen on a buddy list nobody has asked for yet costs a round trip of
      // blank screen for nothing.
      this._loadPartners();
    }

    async onUnmount() {
      this._scroller.disconnect();
      // Save rather than clear: leaving mid-wizard is not abandoning it, and
      // the close button is the path that clears (see _close).
      if (this._draft.isDirty) this._draft.save();
    }

    // ── Chrome ────────────────────────────────────────────────────────────────

    _chrome(body, opts) {
      const steps = window.PlayImport.steps;
      const i = this._draft.step;
      const o = opts || {};
      return `
        <header class="spoke-head">
          <h2 class="spoke-head__title font-display">Import plays</h2>
          <button class="spoke-head__close" onclick="window.importPlaysView._close()"
                  aria-label="Close importer">
            <i data-icon="x" class="w-4 h-4"></i>
          </button>
        </header>
        <div class="imp-chrome">
          <div class="imp-chrome__count" aria-live="polite">
            Step <b>${i + 1}</b> of ${steps.length}
          </div>
          <div class="imp-chrome__bar">
            ${steps.map((_, n) => `<div class="imp-chrome__seg${n <= i ? " is-done" : ""}"></div>`).join("")}
          </div>
        </div>
        <div class="imp-body" data-imp-body>${body}</div>
        ${o.hideNav ? "" : this._renderNav()}
      `;
    }

    _renderNav() {
      const i = this._draft.step;
      const last = i === window.PlayImport.steps.length - 1;
      // The last step's action is the Import button inside the step body, not
      // a Continue — "Continue" on a screen whose whole point is one
      // irreversible commit would be the wrong word for it.
      if (last) {
        return `
          <div class="imp-nav">
            <button class="imp-nav__back" type="button" ${this._importing ? "disabled" : ""}
                    onclick="window.importPlaysView._back()">Back</button>
          </div>
        `;
      }
      const busy = this._parsing;
      const blocked = this._continueBlocker();
      return `
        <div class="imp-nav">
          ${i > 0 ? `<button class="imp-nav__back" type="button" ${busy ? "disabled" : ""}
                  onclick="window.importPlaysView._back()">Back</button>` : ""}
          <button class="imp-nav__next" type="button" ${busy || blocked ? "disabled" : ""}
                  onclick="window.importPlaysView._next()">
            ${busy ? "Reading your notes…" : (i === 1 ? "Read my notes" : "Continue")}
          </button>
        </div>
      `;
    }

    /** Null when Continue is allowed, else why it isn't. */
    _continueBlocker() {
      const d = this._draft;
      switch (d.stepName) {
        case "source":
          return d.text.trim().length && d.text.length <= window.PlayImport.maxChars ? null : "text";
        case "plays":
          return d.liveCount ? null : "empty";
        default:
          return null;
      }
    }

    render() {
      const d = this._draft;
      if (this._error) {
        this.container.innerHTML = this._chrome(this._renderError());
        this.refreshIcons();
        return;
      }
      if (this._parsing) {
        this.container.innerHTML = this._chrome(`
          <div class="imp-step">
            ${buddyLoader({ size: 120, label: "Reading your notes…" })}
            <p class="imp-step__lede imp-step__lede--center">
              This takes a few seconds. Nothing is saved yet.
            </p>
          </div>
        `);
        this.refreshIcons();
        return;
      }
      const body = window.ImportPlaysSteps[d.stepName](d, {
        loadingPartners: this._loadingPartners,
        expanded: this._expanded,
        shownGroups: this._shownGroups,
        importing: this._importing,
      });
      // The last step hides the nav while a run is in flight: there is nothing
      // to go back to mid-write, and a Back button there invites the one tap
      // that would leave the user unsure what landed.
      this.container.innerHTML = this._chrome(body, {
        hideNav: d.stepName === "import" && (this._importing || !!d.progress),
      });
      this.refreshIcons();
      this._armScroller();
    }

    _renderError() {
      return `
        <div class="imp-step imp-step--empty">
          <img class="imp-empty__art" src="assets/illustrations/bgb-loading.svg" alt="" />
          <h3 class="imp-step__title font-display">That didn't work</h3>
          <p class="imp-step__lede">${escapeHtml(this._error)}</p>
          <button class="imp-cta" type="button" onclick="window.importPlaysView._dismissError()">
            Back to my notes
          </button>
        </div>
      `;
    }

    _dismissError() {
      this._error = null;
      this.render();
    }

    // ── Windowing ─────────────────────────────────────────────────────────────

    _armScroller() {
      if (this._draft.stepName !== "plays") { this._scroller.observe(null); return; }
      // Re-point on every paint: the paint replaced the host, so a single
      // long-lived observation would be watching a detached node.
      this._scroller.observe(this.container.querySelector("[data-imp-sentinel]"));
    }

    _revealMore() {
      const total = this._draft.groups().length;
      if (this._shownGroups >= total) return;
      this._shownGroups = Math.min(total, this._shownGroups + GROUP_BATCH);
      this.render();
    }

    // ── Step 1 & 2 ────────────────────────────────────────────────────────────

    _onSourceInput(value) {
      this._draft.text = value;
      // No re-render: the textarea is the source of truth while it has focus,
      // and repainting it would drop the caret mid-paste. Patch the two things
      // that must stay live instead — Continue's disabled state and the
      // character count, which is the only warning before the cap bites.
      this._syncNext();
      this._syncCount();
    }

    _onHintInput(value) { this._draft.hint = value; }

    _useHint(text) {
      this._draft.hint = text;
      this.render();
    }

    /** Patch the Continue button in place rather than repainting the step. */
    _syncNext() {
      const btn = this.container.querySelector(".imp-nav__next");
      if (btn) /** @type {HTMLButtonElement} */ (btn).disabled = !!this._continueBlocker();
    }

    /** Same, for the character counter under the paste box. */
    _syncCount() {
      const el = this.container.querySelector(".imp-count");
      if (!el) return;
      const used = this._draft.text.length;
      const max = window.PlayImport.maxChars;
      el.textContent = `${used.toLocaleString()} / ${max.toLocaleString()}`;
      el.classList.toggle("is-over", used > max);
    }

    /**
     * Read a .txt/.md/.csv into the textarea. Nothing is uploaded — the same
     * client-side read the chapter editor's "Import .md" does.
     */
    _onFilePick(event) {
      const input = event && event.target;
      const file = input && input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "")
          .replace(/^﻿/, "")
          .replace(/\r\n?/g, "\n");
        this._draft.text = text.slice(0, window.PlayImport.maxChars);
        if (text.length > window.PlayImport.maxChars) {
          showToast("That file was too long — I kept the first part.", "info");
        }
        this.render();
      };
      reader.onerror = () => showToast("Couldn't read that file", "error");
      reader.readAsText(file);
      // Reset so picking the same file twice fires onchange the second time.
      input.value = "";
    }

    // ── Navigation ────────────────────────────────────────────────────────────

    async _next() {
      const d = this._draft;
      if (this._continueBlocker() || this._parsing) return;
      if (d.stepName === "details") { await this._parse(); return; }
      if (d.stepName === "games") {
        const unresolved = d.unresolvedGames();
        const cost = unresolved.reduce((a, u) => a + u.plays, 0);
        if (cost) {
          const ok = await window.PolaroidPopup.confirm({
            title: `Leave ${cost} play${cost === 1 ? "" : "s"} out?`,
            body: `${unresolved.map((u) => u.name).join(", ")} ${unresolved.length === 1 ? "hasn't" : "haven't"} been matched to a game, so ${cost === 1 ? "its play" : "their plays"} can't be imported. You can go back and match ${unresolved.length === 1 ? "it" : "them"}.`,
            confirmLabel: "Leave them out",
            cancelLabel: "Match them",
          });
          if (!ok) return;
        }
      }
      d.step = Math.min(d.step + 1, window.PlayImport.steps.length - 1);
      this._shownGroups = GROUP_BATCH;
      d.save();
      this.render();
    }

    _back() {
      const d = this._draft;
      if (this._parsing || this._importing) return;
      d.step = Math.max(0, d.step - 1);
      d.save();
      this.render();
    }

    async _close() {
      if (this._draft.isDirty && !this._draft.progress) {
        const ok = await window.PolaroidPopup.confirm({
          title: "Discard this import?",
          body: "Your notes and everything you've matched so far will be lost. Nothing has been added to your plays.",
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

    // ── The parse ─────────────────────────────────────────────────────────────

    async _parse() {
      const seq = ++this._parseSeq;
      this._parsing = true;
      this._error = null;
      this.render();
      try {
        await this._draft.parse();
      } catch (err) {
        if (seq !== this._parseSeq) return;
        this._parsing = false;
        this._error = (err && err.message) || "Couldn't read that note.";
        this.render();
        return;
      }
      if (seq !== this._parseSeq) return;
      this._parsing = false;
      // Suggestions run against whatever the partner load has by now. When it
      // hasn't landed, _loadPartners re-runs them on arrival — a name the user
      // has since decided about is never re-suggested.
      this._draft.suggestPlayers(this._partners || {});
      this._draft.step = window.PlayImport.steps.indexOf("players");
      this._draft.save();
      this.render();
    }

    async _loadPartners() {
      this._loadingPartners = true;
      let data = null;
      try {
        data = await window.Buddy.allBuddies();
      } catch (_) {
        // A missing buddy list costs auto-matching, not the import: every row
        // is still pickable by hand and every name is still importable as a
        // ghost.
        data = null;
      }
      this._loadingPartners = false;
      this._partners = data || { accounts: [], ghosts: [], recent: [] };
      if (this._draft.playerNames.length) {
        this._draft.suggestPlayers(this._partners);
        this._draft.save();
      }
      if (this._draft.stepName === "players") this.render();
    }

    // ── Players step ──────────────────────────────────────────────────────────

    _openPlayerSheet(name) {
      const p = this._partners || { accounts: [], ghosts: [], recent: [] };
      const candidates = [
        ...(p.accounts || []).map((a) => ({
          source: "account",
          user_id: a.user_id || a.id,
          name: a.display_name || a.username || "",
          username: a.username || null,
          avatar: a.avatar || null,
        })),
        ...(p.ghosts || []).map((g) => ({
          source: "ghost",
          user_id: null,
          name: g.display_name || g.name || "",
          username: null,
          avatar: null,
          plays: g.play_count || 0,
        })),
      ].filter((c) => c.name);
      const current = this._draft.playerMapping(name);

      window.PlayerPickerSheet.open({
        candidates,
        recent: candidates,
        singleSelect: true,
        title: `Who is “${name}”?`,
        sub: "Match an account, or keep them as a ghost player.",
        selectedName: current.label,
        guestName: current.kind === "ghost" ? current.label : name,
        guestTitle: `Keep “${current.kind === "ghost" ? current.label : name}” as a ghost player`,
        guestHint: "No account — they can claim these plays later",
        returnFocus: document.activeElement,
        onConfirm: (picks) => {
          const pick = picks && picks[0];
          if (!pick) return;
          this._draft.setPlayer(name, pick.user_id
            ? { kind: "buddy", userId: pick.user_id, label: pick.name }
            : { kind: "ghost", userId: null, label: pick.name });
          this._draft.save();
          this.render();
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
          this._draft.setGame(gameName, game);
          this._draft.save();
          this.render();
        },
        onError: (err) => showToast((err && err.message) || "Search failed", "error"),
      });
    }

    /** Per-play override, from inside an expanded review row. */
    _openRowGameSheet(playId) {
      const row = this._rowFor(playId);
      if (!row) return;
      window.GameSearchSheet.open({
        title: "Change this play's game",
        placeholder: "Search for a game…",
        returnFocus: document.activeElement,
        onPick: (game) => {
          // The whole run, not one repeat: the row the user is looking at
          // represents all of them and says so.
          for (const p of row.plays) p.gameId = game.id;
          this._draft.setGame(game.name, game);
          this._draft.save();
          this.render();
        },
        onError: (err) => showToast((err && err.message) || "Search failed", "error"),
      });
    }

    // ── Plays step ────────────────────────────────────────────────────────────

    /** The review row a head/detail control belongs to, by its first play's id. */
    _rowFor(playId) {
      for (const group of this._draft.groups()) {
        for (const row of window.PlayImport.rows(group.plays)) {
          if (row.plays[0].id === playId) return row;
        }
      }
      return null;
    }

    _toggleRow(playId) {
      this._expanded[playId] = !this._expanded[playId];
      this.render();
    }

    async _dropRow(playId) {
      const row = this._rowFor(playId);
      if (!row) return;
      const n = row.plays.length;
      const ok = await window.PolaroidPopup.confirm({
        title: n > 1 ? `Remove these ${n} plays?` : "Remove this play?",
        body: "It won't be imported. Nothing has been saved yet, so you can start the importer again if you change your mind.",
        confirmLabel: "Remove",
        cancelLabel: "Keep",
        destructive: true,
      });
      if (!ok) return;
      this._draft.dropPlays(row.plays.map((p) => p.id));
      this._draft.save();
      this.render();
    }

    _onBulkDate(value) {
      this._draft.bulkDate = value || null;
      this._draft.save();
      this.render();
    }

    _onRowDate(playId, value) {
      const row = this._rowFor(playId);
      if (!row) return;
      for (const p of row.plays) p.playedAt = value || null;
      this._draft.save();
      this.render();
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

  window.ImportPlaysView = ImportPlaysView;
})();
