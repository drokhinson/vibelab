// ui/rank-flow.js — the ranking questions, shared by the game page's sheet and
// the rank queue.
//
// A gut check first (Love it / A good game / Not for me), then "which do
// you prefer?" against games already in that tier, each answer halving the
// range the new game can land in. So ranking against n games in a tier costs
// about log2(n+1) questions. "Too close to call" places it straight after the
// game it was being compared with.
//
// The moment the questions find the spot, the result shows — worked out here,
// not waited for — and the save runs behind it (chained, latest wins). The
// result carries Undo (back one question) and the caller's Continue.
//
// Lifecycle only — it owns one host element's markup and clicks. Whatever sits
// around it (the queue's Skip) is the caller's.

(function () {
  const WINDOW = 2;  // rows either side of the new game on the result list

  function art(game, cls) {
    return gameArtImg(game, "card", { cls })
      || `<span class="${cls} rank-flow__art-empty"><i data-icon="dice-6" class="w-6 h-6"></i></span>`;
  }

  function thumb(game) {
    return gameArtImg(game, "chip", { cls: "rank-flow__thumb" })
      || `<span class="rank-flow__thumb rank-flow__art-empty"><i data-icon="dice-6" class="w-4 h-4"></i></span>`;
  }

  const TIER_ORDER = { love: 0, good: 1, not: 2 };

  class RankFlow {
    /**
     * @param {{host: HTMLElement, context: Object, tier?: string,
     *          onDone?: (entry: Object) => void, onStep?: (step: string) => void,
     *          continueLabel?: string, onContinue?: () => void}} opts
     *   context is GET /ranks/games/{id}: {game, category_label, ranked, …}.
     *   tier skips the gut check when the caller already asked it (the
     *   wrap-up card's "Rate {game}" stub), opening on the first question.
     *   onDone fires each time the latest placement is SAVED, with the
     *   server's entry. onStep fires after every paint, so a host can swap
     *   its own chrome when the result is up. continueLabel + onContinue put
     *   the result screen's primary button ("Next: Azul", "Done").
     */
    constructor({ host, context, onDone, onStep, tier, continueLabel, onContinue }) {
      this.host = host;
      this.ctx = context;
      this.onDone = onDone || (() => {});
      this.onStep = onStep || (() => {});
      this.continueLabel = continueLabel || null;
      this.onContinue = onContinue || null;
      this.step = "tier";
      this.tier = null;
      this.list = [];
      this.lo = 0;
      this.hi = 0;
      this.hist = [];
      this.entry = null;       // shown on the result: local first, then the server's
      this._placeSeq = 0;      // only the latest placement's save reconciles
      this._write = Promise.resolve();
      this._saveState = null;  // null | "pending" | "saved" | "error"
      this._onClick = (e) => this._click(e);
      host.addEventListener("click", this._onClick);
      if (tier) this._pickTier(tier);
      else this.render();
    }

    destroy() {
      this._destroyed = true;
      this.host.removeEventListener("click", this._onClick);
    }

    /** Resolves once every save this flow started has landed or failed, so a
     *  host can hold the NEXT game's list until this game is in it. */
    settled() {
      return this._write.catch(() => {});
    }

    _click(e) {
      const el = e.target.closest("[data-rank-act]");
      if (!el || !this.host.contains(el)) return;
      const act = el.getAttribute("data-rank-act");
      if (act === "tier") this._pickTier(el.getAttribute("data-tier"));
      else if (act === "new") this._answer(true);
      else if (act === "old") this._answer(false);
      else if (act === "tie") {
        this.hist.push([this.lo, this.hi]);
        this._place(Math.floor((this.lo + this.hi) / 2) + 1);
      }
      else if (act === "undo") this._undo();
      else if (act === "retry") this._save(this._placedIndex);
      else if (act === "continue" && this.onContinue) this.onContinue();
    }

    _pickTier(tier) {
      this.tier = tier;
      this.list = (this.ctx.ranked || []).filter((r) => r.tier === tier);
      this.lo = 0;
      this.hi = this.list.length;
      this.hist = [];
      if (!this.list.length) return this._place(0);
      this.step = "cmp";
      this.render();
    }

    _answer(preferNew) {
      const mid = Math.floor((this.lo + this.hi) / 2);
      this.hist.push([this.lo, this.hi]);
      if (preferNew) this.hi = mid; else this.lo = mid + 1;
      if (this.lo >= this.hi) return this._place(this.lo);
      this.render();
    }

    /** Back one question — from the result too. With no question asked (an
     *  empty tier), back to the gut check. */
    _undo() {
      if (!this.hist.length) { this.step = "tier"; this.render(); return; }
      [this.lo, this.hi] = this.hist.pop();
      this.step = "cmp";
      this.render();
    }

    /**
     * The questions have found the spot: show it NOW, worked out here, and
     * save behind it. Position stacks the tiers as the server does; the score
     * is Rank.scoreFor, the server's formula. The save's echo replaces both.
     */
    _place(index) {
      const ranked = this.ctx.ranked || [];
      const above = ranked.filter((r) => TIER_ORDER[r.tier] < TIER_ORDER[this.tier]).length;
      this.entry = {
        game_id: this.ctx.game.id,
        category: this.ctx.category,
        category_label: this.ctx.category_label,
        tier: this.tier,
        position: above + index + 1,
        score: window.Rank.scoreFor(this.tier, index, this.list.length + 1),
      };
      this.step = "result";
      this.render();
      this._save(index);
    }

    _save(index) {
      this._placedIndex = index;
      const seq = ++this._placeSeq;
      const tier = this.tier;
      const gameId = this.ctx.game.id;
      this._saveState = "pending";
      this._paintSaveLine();
      // Chained, so an Undo-and-answer-again can never land before the write
      // it replaces; a failed write does not block the next one.
      this._write = this._write.catch(() => {})
        .then(() => window.Rank.place(gameId, tier, index))
        .then((entry) => {
          if (seq !== this._placeSeq) return;
          // A host that moved on (the queue's Continue) still hears the save.
          if (this._destroyed) { this.onDone(entry); return; }
          const moved = !this.entry || entry.position !== this.entry.position
            || Number(entry.score) !== Number(this.entry.score);
          this.entry = entry;
          this._saveState = "saved";
          if (this.step === "result" && moved) this.render();
          else this._paintSaveLine();
          this.onDone(entry);
        }, () => {
          if (seq !== this._placeSeq || this._destroyed) return;
          this._saveState = "error";
          this._paintSaveLine();
        });
    }

    _saveLineHtml() {
      if (this._saveState !== "error") return "";
      return `That didn't save.
        <button type="button" class="rank-flow__retry" data-rank-act="retry">Try again</button>`;
    }

    _paintSaveLine() {
      const line = this.host.querySelector("[data-rank-save]");
      if (line) line.innerHTML = this._saveLineHtml();
    }

    render() {
      this.host.innerHTML = this._html();
      if (window.BgbIcons) window.BgbIcons.render(this.host);
      this.onStep(this.step);
    }

    _html() {
      const ctxLine = `
        <div class="rank-flow__ctx">
          <i data-icon="list-numbers" class="w-4 h-4"></i>
          <span>Ranking against your <b>${escapeHtml(this.ctx.category_label)}</b> games</span>
        </div>`;
      if (this.step === "tier") {
        return `${ctxLine}
          <div class="rank-flow__tiers" role="group" aria-label="How did you feel about it?">
            ${window.Rank.TIERS.map((t) => `
              <button type="button" class="rank-flow__tier rank-flow__tier--${t.id}" data-rank-act="tier" data-tier="${t.id}">
                <span class="rank-flow__tier-dot"><i data-icon="${t.icon}" class="w-4 h-4"></i></span>
                <span>${t.label}</span>
              </button>`).join("")}
          </div>`;
      }
      if (this.step === "cmp") {
        const mid = Math.floor((this.lo + this.hi) / 2);
        const other = this.list[mid].game;
        const total = Math.max(this.hist.length + 1, Math.ceil(Math.log2(this.list.length + 1)));
        const g = this.ctx.game;
        return `${ctxLine}
          <h3 class="rank-flow__q font-display">Which do you prefer?</h3>
          <div class="rank-flow__vs">
            <button type="button" class="rank-flow__pick" data-rank-act="new" aria-label="${escapeAttr(g.name)}">
              ${art(g, "rank-flow__art")}
              <span class="rank-flow__pick-name">${escapeHtml(g.name)}</span>
            </button>
            <span class="rank-flow__or" aria-hidden="true">or</span>
            <button type="button" class="rank-flow__pick" data-rank-act="old" aria-label="${escapeAttr(other.name)}">
              ${art(other, "rank-flow__art")}
              <span class="rank-flow__pick-name">${escapeHtml(other.name)}</span>
            </button>
          </div>
          <div class="rank-flow__actions">
            <button type="button" class="btn btn-ghost btn-sm" data-rank-act="tie">Too close to call</button>
            <button type="button" class="btn btn-ghost btn-sm" data-rank-act="undo">
              <i data-icon="rotate-ccw" class="w-4 h-4"></i> Undo
            </button>
          </div>
          <div class="rank-flow__progress">
            <span>Question ${this.hist.length + 1} of about ${total}</span>
            <span class="rank-flow__bar"><i style="width:${Math.round((this.hist.length / total) * 100)}%"></i></span>
          </div>`;
      }
      return this._resultHtml();
    }

    _resultHtml() {
      const e = this.entry;
      const rows = (this.ctx.ranked || []).map((r) => r.game);
      rows.splice(e.position - 1, 0, this.ctx.game);
      const lo = Math.max(0, e.position - 1 - WINDOW);
      const hi = Math.min(rows.length, e.position + WINDOW);
      return `
        <div class="rank-flow__badge">
          <span><span class="rank-flow__num">#${e.position}</span> ${escapeHtml(e.category_label)}</span>
          <span class="rank-flow__score"><b>${Number(e.score).toFixed(1)}</b>/10</span>
        </div>
        <ol class="rank-flow__list" start="${lo + 1}">
          ${rows.slice(lo, hi).map((g, i) => `
            <li class="rank-flow__row${g.id === this.ctx.game.id ? " is-me" : ""}">
              <span class="rank-flow__row-n">${lo + i + 1}</span>
              ${thumb(g)}
              <span class="rank-flow__row-name">${escapeHtml(g.name)}</span>
            </li>`).join("")}
        </ol>
        <p class="rank-flow__save" data-rank-save role="status">${this._saveLineHtml()}</p>
        <div class="rank-flow__done-actions">
          <button type="button" class="btn btn-ghost rank-flow__undo" data-rank-act="undo">
            <i data-icon="rotate-ccw" class="w-4 h-4"></i> Undo
          </button>
          ${this.onContinue ? `
            <button type="button" class="btn btn-primary rank-flow__continue" data-rank-act="continue">
              ${escapeHtml(this.continueLabel || "Continue")}
            </button>` : ""}
        </div>`;
    }
  }

  window.RankFlow = RankFlow;
})();
