// views/rank-queue-view.js — "Rank your games", opened from the Collection card.
//
// Every owned or played game without a rank, A to Z, one after another through
// the same questions the game page's sheet asks (ui/rank-flow.js). "Start
// ranking" begins at the top; tapping a row begins at that game. The list is
// snapshotted when ranking starts, so a game ranked here never reshuffles what
// is still to come. "Done for now" keeps everything ranked so far — each game is
// saved the moment its questions are answered. Skip leaves a game for later.
//
// Games parked with "Rank after next play" (the gut check's fourth answer,
// Rank.defer) sit under their own heading at the foot of the list. Start walks
// past them and they are left out of the count; tapping one ranks just that
// game. The server brings each back into line once it has been played again.

(function () {
  class RankQueueView extends window.View {
    constructor() {
      super("rank-queue");
      this._reset();
    }

    _reset() {
      if (this._flow) this._flow.destroy();
      this._flow = null;
      this._items = [];
      this._walk = [];       // the games Start / a row tap goes through, snapshotted
      this._loading = false;
      this._loaded = false;
      this._failed = false;
      this._mode = "list";   // "list" | "active" | "done"
      this._idx = 0;
      this._rankedIds = new Set();  // Undo + re-place is one game, not two
      this._deferredIds = new Set();
      this._skipped = 0;
      this._lastWrite = Promise.resolve();
      this._seq = 0;
    }

    async onMount() {
      this._reset();
      // Seeded at boot and kept current by every rank write, so the list is
      // usually on screen in the first frame; _load() then only confirms it.
      const cached = window.Rank.cachedQueue();
      if (cached) {
        this._items = cached;
        this._loaded = true;
      }
      await this._load();
    }

    onUnmount() {
      this._reset();
    }

    renderLoading() {
      this._reset();
      const cached = window.Rank.cachedQueue();
      if (cached) { this._items = cached; this._loaded = true; }
      this._loading = true;
      this.render();
    }

    async _load() {
      this._loading = true;
      this._failed = false;
      this.render();
      try {
        const items = await window.Rank.queue();
        // Once ranking has started the list is snapshotted (see the header):
        // a late answer must not shift the index out from under the flow.
        if (this._mode === "list") this._items = items;
        this._loaded = true;
      } catch (_) {
        if (!this._loaded) this._failed = true;
      } finally {
        this._loading = false;
        if (this._mounted) this.render();
      }
    }

    render() {
      this.container.innerHTML = `
        ${this._renderHead()}
        <section class="rank-queue">${this._renderBody()}</section>`;
      this.refreshIcons();
      if (this._mode === "active") this._mountFlow();
    }

    _renderHead() {
      const active = this._mode === "active";
      const n = active ? this._walk.length : window.Rank.countable(this._items).length;
      const leftOver = this._skipped || this._deferredIds.size;
      const title = active ? `${this._idx + 1} of ${n}` : this._mode === "done" ? (leftOver ? "End of the list" : "All ranked") : "Unranked games";
      const right = active
        ? `<button class="btn btn-ghost btn-sm rank-queue__stop" type="button"
                   onclick="window.router.up('collection')">Done for now</button>`
        : (this._mode === "list" && this._loaded && n ? `<span class="spoke-head__count">${n}</span>` : "");
      return `
        <header class="spoke-head">
          <button class="spoke-head__back" type="button" aria-label="Back to collection"
                  onclick="window.router.up('collection')">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="spoke-head__title font-display">
            <span class="spoke-head__title-text">${title}</span>
          </h2>
          ${right}
        </header>
        ${active ? `<div class="rank-queue__bar"><i style="width:${Math.round((this._idx / n) * 100)}%"></i></div>` : ""}`;
    }

    _renderBody() {
      if (!this._items.length && (!this._loaded || this._loading)) {
        return window.buddyLoader({ size: 88, label: "Opening…" });
      }
      if (this._failed) {
        return `
          <div class="p-6 text-center">
            <p class="opacity-60 mb-3">Couldn't load your games just now.</p>
            <button class="btn btn-sm btn-primary" onclick="window.rankQueueView._load()">Try again</button>
          </div>`;
      }
      if (this._mode === "done") {
        return `
          <p class="rank-queue__done">You ranked ${this._rankedIds.size} ${this._rankedIds.size === 1 ? "game" : "games"}.${
            this._skipped ? ` ${this._skipped} skipped ${this._skipped === 1 ? "game stays" : "games stay"} in your queue for next time.` : ""}${
            this._deferredIds.size ? ` ${this._deferredIds.size} ${this._deferredIds.size === 1 ? "waits" : "wait"} until you play ${this._deferredIds.size === 1 ? "it" : "them"} again.` : ""}</p>
          <button class="btn btn-primary rank-queue__cta" type="button"
                  onclick="window.router.up('collection')">Back to your collection</button>`;
      }
      if (!this._items.length) {
        return `<div class="profile-empty">Every game you own or have played is ranked.</div>`;
      }
      if (this._mode === "active") {
        const item = this._walk[this._idx];
        return `
          <div class="rank-queue__game">
            ${gameArtImg(item.game, "card", { cls: "rank-queue__art" })
              || `<span class="rank-queue__art rank-flow__art-empty"><i data-icon="dice-6" class="w-6 h-6"></i></span>`}
            <h3 class="rank-queue__name font-display">${escapeHtml(item.game.name)}</h3>
          </div>
          <div id="rank-queue-flow" class="rank-queue__flow"></div>
          <div id="rank-queue-foot">${this._skipHtml(item)}</div>`;
      }
      const row = (it, i) => `
            <li>
              <button type="button" class="rank-queue__row" onclick="window.rankQueueView._start(${i})">
                ${gameArtImg(it.game, "chip", { cls: "rank-flow__thumb" })
                  || `<span class="rank-flow__thumb rank-flow__art-empty"><i data-icon="dice-6" class="w-4 h-4"></i></span>`}
                <span class="rank-queue__row-name">${escapeHtml(it.game.name)}</span>
                <span class="rank-queue__tag">${escapeHtml(it.category_label)}</span>
                <i data-icon="chevron-right" class="w-4 h-4 rank-queue__go" aria-hidden="true"></i>
              </button>
            </li>`;
      const rows = this._items.map((it, i) => ({ it, i }));
      const now = rows.filter((r) => !r.it.deferred);
      const later = rows.filter((r) => r.it.deferred);
      return `
        ${now.length ? `
          <ol class="rank-queue__list">${now.map((r) => row(r.it, r.i)).join("")}</ol>
          <button class="btn btn-primary rank-queue__cta" type="button"
                  onclick="window.rankQueueView._start()">Start ranking</button>`
          : `<div class="profile-empty">Nothing to rank until you play these again.</div>`}
        ${later.length ? `
          <h3 class="rank-queue__sec">
            <i data-icon="hourglass" class="w-4 h-4" aria-hidden="true"></i> After next play
          </h3>
          <ol class="rank-queue__list rank-queue__list--later">${later.map((r) => row(r.it, r.i)).join("")}</ol>` : ""}`;
    }

    // Start walks every game still counted. A tapped row starts there and
    // carries on down the counted list from it; a parked game is ranked on
    // its own, since the rest of that section is parked too.
    _start(idx) {
      const tapped = idx == null ? null : this._items[idx];
      if (tapped && tapped.deferred) this._walk = [tapped];
      else {
        const from = tapped ? this._items.slice(idx) : this._items;
        this._walk = window.Rank.countable(from);
      }
      if (!this._walk.length) return;
      this._mode = "active";
      this._idx = 0;
      this.render();
    }

    // The gut check shows at once — the queue item already carries the game
    // and the category the server decided. The list it is ranked against
    // follows: built from the cached ranking when that can answer, fetched
    // when not, and in either case only after the previous game's background
    // save has landed (its echo is what puts that game in the cached list).
    _mountFlow() {
      const host = this.container.querySelector("#rank-queue-flow");
      if (!host) return;
      if (this._flow) this._flow.destroy();
      this._flow = null;
      const item = this._walk[this._idx];
      const cats = { category: item.category, category_label: item.category_label };
      const list = () => this._lastWrite.then(() =>
        window.Rank.localContext(item.game, cats) || window.Rank.context(item.game.id));
      const next = this._walk[this._idx + 1];
      this._flow = new window.RankFlow({
        host,
        context: { game: item.game, ...cats, rank: null, ranked: null },
        ready: list(),
        reload: list,
        continueLabel: next ? `Next: ${next.game.name}` : "Finish",
        onContinue: () => this._next(),
        onDefer: item.deferred ? null : () => this._defer(item),
        // Counted when the place is shown, not when its save lands: Continue
        // can leave before the background write finishes.
        onStep: (step) => {
          if (step === "result") this._rankedIds.add(item.game.id);
          this._paintFoot(step);
        },
      });
    }

    // Under the questions: skip this game. Under the result (whose Continue
    // is the Next button): back to the list, to pick what to rank next.
    _paintFoot(step) {
      const foot = this.container.querySelector("#rank-queue-foot");
      if (!foot) return;
      const key = step === "result" ? "list" : "skip";
      if (foot.__footFor === key) return;
      foot.__footFor = key;
      foot.innerHTML = key === "skip"
        ? this._skipHtml(this._walk[this._idx])
        : `
          <button class="btn btn-ghost rank-queue__skip" type="button"
                  onclick="window.rankQueueView._backToList()">
            <i data-icon="list-numbers" class="w-4 h-4"></i> Back to unranked games
          </button>`;
      this.refreshIcons(foot);
    }

    // Skip leaves a game unranked and moves on; it comes back the next time
    // the queue opens.
    _skipHtml(item) {
      return `
        <button class="btn btn-ghost rank-queue__skip" type="button"
                onclick="window.rankQueueView._skip()">
          Skip ${escapeHtml(item.game.name)} <i data-icon="chevron-right" class="w-4 h-4"></i>
        </button>`;
    }

    /** The list again, minus what was just ranked; the server's copy follows
     *  once this game's background save has landed. */
    async _backToList() {
      if (this._flow) {
        this._lastWrite = this._flow.settled();
        this._flow.destroy();
        this._flow = null;
      }
      this._seq++;
      this._mode = "list";
      this._idx = 0;
      // The cached queue already carries this walk's deferrals and drops each
      // rank as its save lands; the ones still in the air are filtered here.
      this._items = (window.Rank.cachedQueue() || this._items)
        .filter((it) => !this._rankedIds.has(it.game.id));
      this.render();
      window.scrollTo(0, 0);
      await this._lastWrite;
      if (this._mounted && this._mode === "list") this._load();
    }

    _skip() {
      this._skipped++;
      this._next();
    }

    // "Rank after next play": parked at once (Rank.defer is optimistic) and
    // on to the next game. A failed save puts it back in the cached queue.
    _defer(item) {
      this._deferredIds.add(item.game.id);
      window.Rank.defer(item.game.id).catch(() => {
        this._deferredIds.delete(item.game.id);
        window.showToast(`Couldn't park ${escapeHtml(item.game.name)} just now.`, "error");
      });
      this._next();
    }

    _next(step = 1) {
      if (this._flow) this._lastWrite = this._flow.settled();
      this._idx += step;
      if (this._idx >= this._walk.length) this._mode = "done";
      this.render();
      window.scrollTo(0, 0);
    }
  }

  window.RankQueueView = RankQueueView;
})();
