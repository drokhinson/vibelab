// widgets/rank-sheet.js — the game page's rank pill opens this.
//
// Unranked: the ranking questions (ui/rank-flow.js), then the game's new place.
// Ranked: the category's whole list with the game highlighted, and Re-rank,
// which runs the questions again. The category is the server's, from
// BoardGameGeek, and the sheet only ever names it.

(function () {
  class RankSheet {
    constructor() {
      this._sheet = new window.BgbBottomSheet({
        id: "bgb-rank-sheet",
        className: "rank-sheet",
        label: "Rank this game",
      });
      this._flow = null;
      this._seq = 0;
    }

    /**
     * @param {{id:string, name:string}} game
     * @param {{returnFocus?: Element, tier?: string}} [opts] tier: the gut
     *   check was already answered elsewhere, so an unranked game opens on its
     *   first "which do you prefer?".
     */
    open(game, { returnFocus = null, tier = null } = {}) {
      const seq = ++this._seq;
      this._game = game;
      this._tier = tier;
      this._ctx = null;
      this._sheet.open({
        html: this._panel(`Rank ${escapeHtml(game.name)}`,
          window.buddyLoader({ size: 64, label: "Opening…" }), ""),
        label: `Rank ${game.name}`,
        returnFocus,
        onClick: (e) => this._click(e),
        onOpen: (root) => {
          const panel = root.querySelector(".bgb-sheet__panel");
          if (panel) panel.focus();
        },
        onClose: () => this._teardown(),
      });
      this._load(seq);
    }

    _load(seq) {
      // From the cached ranking when it can answer — no "Opening…" at all. The
      // category comes from the game's own rank, or from its unranked-queue
      // item (both the server's decision); with neither, ask the server.
      const queued = (window.Rank.cachedQueue() || []).find((it) => it.game && it.game.id === this._game.id);
      const local = window.Rank.localContext(this._game, queued || {});
      if (local) {
        this._ctx = local;
        if (local.rank) this._showList();
        else this._startFlow();
        return;
      }
      window.Rank.context(this._game.id).then((ctx) => {
        if (seq !== this._seq || !this._sheet.isOpen) return;
        this._ctx = ctx;
        if (ctx.rank) this._showList();
        else this._startFlow();
      }).catch(() => {
        if (seq !== this._seq || !this._sheet.isOpen) return;
        this._patch(null, `
          <div class="rank-flow__error">
            <p>Couldn't load your ranking just now.</p>
            <button type="button" class="btn btn-primary btn-sm" data-rank-sheet="retry">Try again</button>
          </div>`, "");
      });
    }

    _teardown() {
      this._seq++;
      if (this._flow) this._flow.destroy();
      this._flow = null;
    }

    _panel(title, body, foot) {
      return `
        <div class="bgb-sheet__panel" tabindex="-1">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title" data-rank-title>${title}</h3>
          <div class="bgb-sheet__list rank-sheet__body" data-rank-body>${body}</div>
          <div class="rank-sheet__foot" data-rank-foot>${foot}</div>
        </div>`;
    }

    /** Patch the title, body and foot hosts in place; null leaves one alone. */
    _patch(title, body, foot) {
      const root = this._sheet.el;
      if (!root) return;
      if (title != null) root.querySelector("[data-rank-title]").innerHTML = title;
      if (body != null) root.querySelector("[data-rank-body]").innerHTML = body;
      if (foot != null) root.querySelector("[data-rank-foot]").innerHTML = foot;
      window.BgbIcons.render(root);
    }

    /** The category the rules give this ranked game from its current data —
     *  which can differ from the category its rank is stored in. Null when
     *  unknown. */
    _current() {
      const own = (window.Rank.cachedSummary() || {})[this._game.id] || this._ctx.rank;
      if (!own || !own.current_category) return null;
      return { category: own.current_category, category_label: own.current_category_label || own.current_category };
    }

    _startFlow() {
      if (this._flow) this._flow.destroy();
      const rerank = !!this._ctx.rank;
      const verb = rerank ? "Re-rank" : "Rank";
      this._patch(`${verb} ${escapeHtml(this._game.name)}`, "", "");
      const host = this._sheet.el.querySelector("[data-rank-body]");
      // Only the first flow of an open takes the preset tier; Re-rank asks again.
      const tier = rerank ? null : this._tier;
      this._tier = null;
      // A Re-rank ranks the game in the category its current data gives it.
      // When that differs from the stored one, the game moves there and leaves
      // the stored list; otherwise it is re-ranked within the stored list.
      let context = { ...this._ctx, rank: null };
      let ready = null;
      let reload = null;
      const cur = rerank ? this._current() : null;
      if (cur && cur.category !== this._ctx.category) {
        const local = window.Rank.localContext(this._game, cur, { current: true });
        if (local) context = { ...local, rank: null };
        else {
          context = { game: this._ctx.game, ...cur, rank: null, ranked: null };
          reload = () => window.Rank.context(this._game.id, { current: true });
          ready = reload();
        }
      }
      this._flow = new window.RankFlow({
        host,
        tier,
        context,
        ready,
        reload,
        placeOpts: rerank ? { recategorize: true } : {},
        continueLabel: "Done",
        onContinue: () => this._sheet.close(),
        onStep: (step) => {
          const title = step === "result" ? "Ranked" : `${verb} ${escapeHtml(this._game.name)}`;
          const el = this._sheet.el && this._sheet.el.querySelector("[data-rank-title]");
          if (el && el.innerHTML !== title) el.innerHTML = title;
        },
      });
    }

    _showList() {
      const ctx = this._ctx;
      const rows = ctx.ranked.map((r) => r.game);
      rows.splice(ctx.rank.position - 1, 0, ctx.game);
      const list = `
        <p class="rank-sheet__sub">
          ${escapeHtml(ctx.game.name)} is #${ctx.rank.position} of ${rows.length}
        </p>
        <ol class="rank-flow__list">
          ${rows.map((g, i) => `
            <li class="rank-flow__row${g.id === ctx.game.id ? " is-me" : ""}">
              <span class="rank-flow__row-n">${i + 1}</span>
              ${gameArtImg(g, "chip", { cls: "rank-flow__thumb" })
                || `<span class="rank-flow__thumb rank-flow__art-empty"><i data-icon="dice-6" class="w-4 h-4"></i></span>`}
              <span class="rank-flow__row-name">${escapeHtml(g.name)}</span>
            </li>`).join("")}
        </ol>`;
      const cur = this._current();
      const moved = cur && cur.category !== ctx.category ? cur : null;
      const note = moved
        ? `<p class="rank-sheet__moved">BoardGameGeek now lists this as a <b>${escapeHtml(moved.category_label)}</b> game. Re-rank to move it.</p>`
        : "";
      this._patch(`Your ${escapeHtml(ctx.category_label)} games`, list + note, `
        <button class="bgb-sheet__cancel rank-sheet__rerank" type="button" data-rank-sheet="rerank">
          <i data-icon="rotate-ccw" class="w-4 h-4"></i>
          ${moved ? `Re-rank in ${escapeHtml(moved.category_label)}` : `Re-rank ${escapeHtml(ctx.game.name)}`}
        </button>`);
    }

    _click(e) {
      const el = e.target.closest("[data-rank-sheet]");
      if (!el) return;
      const act = el.getAttribute("data-rank-sheet");
      if (act === "rerank") this._startFlow();
      else if (act === "retry") {
        this._patch(null, window.buddyLoader({ size: 64, label: "Opening…" }), null);
        this._load(++this._seq);
      }
    }
  }

  let _instance = null;
  window.RankSheet = {
    open(game, opts) {
      if (!_instance) _instance = new RankSheet();
      _instance.open(game, opts);
    },
  };
})();
