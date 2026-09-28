// ui/rank-flow.js — the ranking questions, shared by the game page's sheet and
// the rank queue.
//
// A gut check first (Love it / It's a good game / Not for me), then "which do
// you prefer?" against games already in that tier, each answer halving the
// range the new game can land in. So ranking against n games in a tier costs
// about log2(n+1) questions. "Too close to call" places it straight after the
// game it was being compared with.
//
// Lifecycle only — it owns one host element's markup and clicks. Whatever sits
// around it (the sheet's Done, the queue's Next) is the caller's.

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

  class RankFlow {
    /**
     * @param {{host: HTMLElement, context: Object, onDone?: (entry: Object) => void}} opts
     *   context is GET /ranks/games/{id}: {game, category_label, ranked, …}.
     */
    constructor({ host, context, onDone }) {
      this.host = host;
      this.ctx = context;
      this.onDone = onDone || (() => {});
      this.step = "tier";
      this.tier = null;
      this.list = [];
      this.lo = 0;
      this.hi = 0;
      this.hist = [];
      this.entry = null;
      this._onClick = (e) => this._click(e);
      host.addEventListener("click", this._onClick);
      this.render();
    }

    destroy() {
      this.host.removeEventListener("click", this._onClick);
    }

    _click(e) {
      const el = e.target.closest("[data-rank-act]");
      if (!el || !this.host.contains(el) || this.step === "saving") return;
      const act = el.getAttribute("data-rank-act");
      if (act === "tier") this._pickTier(el.getAttribute("data-tier"));
      else if (act === "new") this._answer(true);
      else if (act === "old") this._answer(false);
      else if (act === "tie") this._save(Math.floor((this.lo + this.hi) / 2) + 1);
      else if (act === "undo") this._undo();
      else if (act === "retry") this._save(this._pendingIndex);
    }

    _pickTier(tier) {
      this.tier = tier;
      this.list = (this.ctx.ranked || []).filter((r) => r.tier === tier);
      this.lo = 0;
      this.hi = this.list.length;
      this.hist = [];
      if (!this.list.length) return this._save(0);
      this.step = "cmp";
      this.render();
    }

    _answer(preferNew) {
      const mid = Math.floor((this.lo + this.hi) / 2);
      this.hist.push([this.lo, this.hi]);
      if (preferNew) this.hi = mid; else this.lo = mid + 1;
      if (this.lo >= this.hi) return this._save(this.lo);
      this.render();
    }

    _undo() {
      if (!this.hist.length) { this.step = "tier"; this.render(); return; }
      [this.lo, this.hi] = this.hist.pop();
      this.render();
    }

    async _save(index) {
      this._pendingIndex = index;
      this.step = "saving";
      this.render();
      try {
        this.entry = await window.Rank.place(this.ctx.game.id, this.tier, index);
        this.step = "done";
        this.render();
        this.onDone(this.entry);
      } catch (_) {
        this.step = "error";
        this.render();
      }
    }

    render() {
      this.host.innerHTML = this._html();
      if (window.BgbIcons) window.BgbIcons.render(this.host);
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
      if (this.step === "saving") {
        return `${ctxLine}${window.buddyLoader({ size: 64, label: "Saving…" })}`;
      }
      if (this.step === "error") {
        return `${ctxLine}
          <div class="rank-flow__error">
            <p>That didn't save. Check your connection and try again.</p>
            <button type="button" class="btn btn-primary btn-sm" data-rank-act="retry">Try again</button>
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
        <p class="rank-flow__badge">
          <span class="rank-flow__num">#${e.position}</span> ${escapeHtml(e.category_label)}
        </p>
        <ol class="rank-flow__list" start="${lo + 1}">
          ${rows.slice(lo, hi).map((g, i) => `
            <li class="rank-flow__row${g.id === this.ctx.game.id ? " is-me" : ""}">
              <span class="rank-flow__row-n">${lo + i + 1}</span>
              ${thumb(g)}
              <span class="rank-flow__row-name">${escapeHtml(g.name)}</span>
            </li>`).join("")}
        </ol>`;
    }
  }

  window.RankFlow = RankFlow;
})();
