// views/achievements-view.js — the Achievements spoke (/profile/achievements).
//
// Reached from the Profile hub's Achievements card. Everything on this screen
// comes from ONE call, GET /achievements, backed by the bgb_sync_achievements
// RPC (migration 061) — the catalog, the four group headings, and the viewer's
// progress against every badge. Nothing here fetches per tile.
//
// The screen is a trophy shelf: a summary strip, then one card per group,
// each holding a single horizontally-scrolling rail of medallions ordered
// done → in progress → not started. A locked badge is shown, not hidden — the
// whole point of an achievement list is knowing what is still out there — so
// it keeps its art (dimmed and desaturated by CSS, never by a second "locked"
// sprite) and prints what it wants from you. Tapping any badge opens its
// detail sheet, which keeps the same grey art while it is unearned.
//
// "New" ribbons come from the device, not the server: see domain/
// achievements.js. They are cleared by markSeen() only after this screen has
// actually painted the badges.

// @ts-check

(function () {
  class AchievementsView extends window.View {
    constructor() {
      super("achievements");
      /** @type {any} */
      this._payload = null;
      /** @type {string[]} ids that were unseen when this mount started. */
      this._fresh = [];
      this._loading = true;
      this._error = null;
      this._sheet = new window.BgbBottomSheet({
        id: "bgb-ach-sheet",
        className: "ach-sheet",
        label: "Achievement detail",
      });
    }

    async onMount() {
      // Singleton view — a previous visit's payload must not flash before this
      // one's load resolves (.claude/rules/web-frontend.md).
      this._error = null;
      this._fresh = [];
      // Paint from whatever an earlier visit warmed, so the shelf is on screen
      // before the round trip. `|| this._payload` because this view is a
      // singleton: a cache entry that lapsed between visits should fall back to
      // what was last on screen rather than throwing the user back to a loader
      // for data they have already seen.
      const cached = window.Achievements.cached() || this._payload;
      this._payload = cached;
      this._loading = !cached;
      if (cached) this._fresh = window.Achievements.unseen(cached).map((a) => a.id);
      this.render();
      try {
        const payload = await window.Achievements.all();
        if (payload) {
          // Union rather than replace: a badge earned since the cached copy
          // was written is new too, and one the cached copy already flagged
          // must not lose its ribbon because the fetch landed after paint.
          const ids = new Set(this._fresh);
          for (const a of window.Achievements.unseen(payload)) ids.add(a.id);
          this._fresh = Array.from(ids);
          this._payload = payload;
        }
      } catch (e) {
        if (!this._payload) this._error = (e && e.message) || "Couldn't load your achievements";
      } finally {
        this._loading = false;
        this.render();
        // The ribbons are on screen now, so they are no longer new. `_fresh`
        // keeps them ribboned for the rest of this visit.
        window.Achievements.markSeen(this._payload);
      }
    }

    async onUnmount() {
      this._sheet.close();
    }

    renderLoading() { this.render(); }

    // ── Render ────────────────────────────────────────────────────────────────
    render() {
      const c = this.container;
      if (!c) return;
      const p = this._payload;

      if (!p && this._loading) {
        c.innerHTML = `
          ${this._renderHead(null)}
          <div class="profile-loading">${window.buddyLoader({ size: 96, label: "Polishing the trophies…" })}</div>
        `;
        this.refreshIcons();
        return;
      }
      if (!p) {
        c.innerHTML = `
          ${this._renderHead(null)}
          <div class="alert alert-error text-sm mt-3">${escapeHtml(this._error || "Couldn't load your achievements")}</div>
        `;
        this.refreshIcons();
        return;
      }

      const byGroup = new Map();
      for (const a of p.achievements || []) {
        if (!byGroup.has(a.group_id)) byGroup.set(a.group_id, []);
        byGroup.get(a.group_id).push(a);
      }

      c.innerHTML = `
        ${this._renderHead(p)}
        ${this._renderSummary(p)}
        ${(p.groups || [])
          .filter((g) => (byGroup.get(g.id) || []).length)
          .map((g) => this._renderGroup(g, byGroup.get(g.id)))
          .join("")}
        <div style="height: 1rem"></div>
      `;
      this.refreshIcons();
    }

    _renderHead(p) {
      return `
        <header class="spoke-head">
          <button class="spoke-head__back" type="button" aria-label="Back to profile"
                  onclick="window.router.back('profile-self')">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="spoke-head__title"><span class="spoke-head__title-text">Achievements</span></h2>
          ${p ? `<span class="spoke-head__count">${p.earned_count} of ${p.total}</span>` : ""}
        </header>
      `;
    }

    // The summary is a progress arc rather than a bar: the shelf below is a
    // grid of discs, and a bar reads as a foreign object above it.
    _renderSummary(p) {
      const total = p.total || 0;
      const earned = p.earned_count || 0;
      const pct = total ? Math.round((earned / total) * 100) : 0;
      const R = 34;
      const circ = 2 * Math.PI * R;
      const latest = (p.achievements || [])
        .filter((a) => a.earned && a.unlocked_at)
        .sort((a, b) => new Date(b.unlocked_at) - new Date(a.unlocked_at))[0];
      const freshCount = this._fresh.length;

      let line;
      if (!earned) {
        line = "Nothing on the shelf yet — log a play and the first one lands.";
      } else if (freshCount) {
        line = `${freshCount} new ${freshCount === 1 ? "badge" : "badges"} since you last looked.`;
      } else if (latest) {
        line = `Latest: ${latest.name}, ${formatDate(latest.unlocked_at)}.`;
      } else {
        line = "Keep playing — the rest are still out there.";
      }

      return `
        <section class="ach-summary${freshCount ? " ach-summary--fresh" : ""}">
          <div class="ach-summary__ring">
            <svg width="80" height="80" viewBox="0 0 80 80" aria-hidden="true">
              <circle class="ach-summary__track" cx="40" cy="40" r="${R}" fill="none" stroke-width="8" />
              <circle class="ach-summary__arc" cx="40" cy="40" r="${R}" fill="none" stroke-width="8"
                      stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}"
                      stroke-dashoffset="${(circ * (1 - pct / 100)).toFixed(1)}" />
            </svg>
            <div class="ach-summary__ring-mid">
              <span class="ach-summary__earned">${earned}</span>
              <span class="ach-summary__of">/ ${total}</span>
            </div>
          </div>
          <div class="ach-summary__body">
            <h3 class="ach-summary__h font-display">Your trophy shelf</h3>
            <p class="ach-summary__p">${escapeHtml(line)}</p>
          </div>
        </section>
      `;
    }

    /**
     * Done → in progress → not started, with the catalog's own order kept
     * inside each bucket so a tier ladder never reads out of sequence: at
     * 47 plays, Century Club (47/100) still comes before Table Titan
     * (47/300) rather than being reshuffled by percentage.
     *
     * The index tiebreak makes the sort explicitly stable rather than leaning
     * on the engine's, and `items` arrives in display_order from the RPC.
     *
     * @param {any[]} items
     * @returns {any[]} a new array — never sorts the payload in place, which
     *   is the cached object every other reader shares.
     */
    _byCompletion(items) {
      const rank = (a) => (a.earned ? 0 : (a.progress > 0 ? 1 : 2));
      return items
        .map((a, i) => ({ a, i }))
        .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)
        .map((x) => x.a);
    }

    _renderGroup(group, items) {
      const earned = items.filter((a) => a.earned).length;
      const ordered = this._byCompletion(items);
      return `
        <section class="preview-card ach-group">
          <header class="preview-card__head">
            <span class="preview-card__icon"><i data-icon="trophy" class="w-4 h-4"></i></span>
            <h3 class="preview-card__title font-display">${escapeHtml(group.label)}</h3>
            <span class="preview-card__sub">${earned}/${items.length}</span>
          </header>
          <p class="ach-group__blurb">${escapeHtml(group.blurb)}</p>
          <div class="ach-rail" role="list" aria-label="${escapeAttr(group.label)} achievements">
            ${ordered.map((a) => this._tile(a)).join("")}
          </div>
        </section>
      `;
    }

    _tile(a) {
      const isNew = this._fresh.includes(a.id);
      const src = window.Achievements.spriteUrl(a.icon);
      const label = a.earned
        ? `${a.name} — unlocked ${formatDate(a.unlocked_at)}`
        : `${a.name} — locked. ${a.requirement}`;
      return `
        <button class="ach-tile ${a.earned ? "is-earned" : "is-locked"}" type="button"
                role="listitem" aria-label="${escapeAttr(label)}"
                onclick="window.achievementsView._open('${jsStr(a.id)}')">
          <span class="ach-tile__art">
            <img src="${escapeAttr(src)}" alt="" width="160" height="160" loading="lazy" decoding="async" />
            ${a.earned ? "" : `<span class="ach-tile__lock"><i data-icon="key-round" class="w-3.5 h-3.5"></i></span>`}
          </span>
          ${isNew ? `<span class="ach-tile__new">New</span>` : ""}
          <span class="ach-tile__name">${escapeHtml(a.name)}</span>
          ${this._tileMeta(a)}
        </button>
      `;
    }

    _tileMeta(a) {
      if (a.earned) {
        return `<span class="ach-tile__meta">${escapeHtml(formatDate(a.unlocked_at) || "Unlocked")}</span>`;
      }
      // A one-shot badge has no meaningful "3 of 1" to draw, so it gets the
      // word instead of a bar that would sit permanently at zero.
      if (a.threshold <= 1) {
        return `<span class="ach-tile__meta ach-tile__meta--locked">Locked</span>`;
      }
      const pct = Math.min(100, Math.round((a.progress / a.threshold) * 100));
      return `
        <span class="ach-tile__bar" role="presentation">
          <span class="ach-tile__bar-fill" style="width:${pct}%"></span>
        </span>
        <span class="ach-tile__meta ach-tile__meta--locked">${a.progress} / ${a.threshold}</span>
      `;
    }

    // ── Detail sheet ──────────────────────────────────────────────────────────
    _find(id) {
      const list = (this._payload && this._payload.achievements) || [];
      return list.find((a) => a.id === id) || null;
    }

    _open(id) {
      const a = this._find(id);
      if (!a) return;
      const src = window.Achievements.spriteUrl(a.icon);
      const pct = a.threshold > 1
        ? Math.min(100, Math.round((a.progress / a.threshold) * 100))
        : 0;
      const status = a.earned
        ? `<div class="ach-detail__status ach-detail__status--earned">
             <i data-icon="check" class="w-4 h-4"></i>
             Unlocked ${escapeHtml(formatDate(a.unlocked_at) || "")}
           </div>`
        // The key glyph and the desaturated art carry "locked" visually, and
        // the requirement reads as a to-do rather than as something achieved
        // — but none of that reaches a screen reader, which would otherwise
        // hear only the instruction while the earned variant says "Unlocked"
        // outright. The word goes in visually-hidden text rather than on
        // screen, where it would just restate the picture.
        : `<div class="ach-detail__status">
             <i data-icon="key-round" class="w-4 h-4"></i>
             <span class="bgb-vis-hidden">Locked. To earn: </span>
             ${escapeHtml(a.requirement)}
           </div>`;
      // No bar once it is earned: the status pill above already says so, and
      // "10 / 10" on a badge you cleared 37 plays ago is noise.
      const bar = (!a.earned && a.threshold > 1)
        ? `<div class="ach-detail__progress">
             <div class="ach-detail__bar"><div class="ach-detail__bar-fill" style="width:${pct}%"></div></div>
             <div class="ach-detail__count">${a.progress} / ${a.threshold}</div>
           </div>`
        : "";

      this._sheet.open({
        label: a.earned ? `${a.name} — unlocked` : `${a.name} — locked`,
        html: `
          <div class="ach-sheet__panel bgb-sheet__panel">
            <div class="bgb-sheet__grip" aria-hidden="true"></div>
            <div class="ach-detail ${a.earned ? "is-earned" : "is-locked"}">
              <img class="ach-detail__art" src="${escapeAttr(src)}" alt="" width="160" height="160" />
              <h3 class="ach-detail__name font-display">${escapeHtml(a.name)}</h3>
              <p class="ach-detail__tagline">${escapeHtml(a.tagline)}</p>
              ${status}
              ${bar}
            </div>
            <button class="bgb-sheet__cancel" type="button" data-action="close">Close</button>
          </div>
        `,
      });
    }
  }

  window.AchievementsView = AchievementsView;
})();
