// views/discovery-view.js — the Discover tab.
//
// Four rails from one GET /discover bundle (domain/discovery.js):
//   Picked for you              bgb_discover_recommendations — the catalog
//                               scored against this viewer's shelf and plays,
//                               each tile captioned with WHY it is there
//   Trending on BoardGameGeek   BGG's hot list; a game the catalog lacks is a
//                               stub tile whose tap imports it
//   New in {year}               this year's catalog releases by BGG rank
//   Back on the shelf           owned games that have not hit the table lately
//
// Shape: the shell (header + four section hosts) paints synchronously in
// renderLoading, from the cached bundle when there is one; each host is then
// repainted on its own. Three branches per web-frontend.md — a loader while
// the first fetch is in the air, a retry card when it failed with nothing to
// show, and only then the rails or their empty copy. The trending rail has a
// fourth: BGG down while everything else is fine.
//
// Tiles go through ui/game-rail.js → ui/game-card.js, the same writer as the
// feed's "Hot this week", and status pills are repainted on `status-changed`
// through window.syncGamePolaroidStatus like the feed and the explorer do.

(function () {
  function cssAttrEscape(v) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(String(v));
    return String(v).replace(/["\\]/g, "\\$&");
  }

  const HOSTS = {
    picks: "discover-picks-host",
    climbing: "discover-climbing-host",
    trending: "discover-trending-host",
    fresh: "discover-new-host",
    shelf: "discover-shelf-host",
  };

  class DiscoveryView extends window.View {
    constructor() {
      super("discovery");
      this._bundle = null;
      this._loading = false;
      this._error = null;
      // Monotonic: a load resolving after a newer one (pull-to-refresh over a
      // mount fetch) must not write its result back.
      this._loadSeq = 0;
      this._statusMap = {};
      this._statusReady = false;
      this._expansionCounts = {};
      // Stub imports in flight, by bgg_id — a double tap must not import twice.
      this._importing = new Set();
      this._ptr = null;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    // View.mount() calls this synchronously before onMount(): the shell is on
    // screen in the tap's own frame, and so is the last bundle if the cache
    // holds one. Only a cold cache waits on the network.
    renderLoading() {
      this._error = null;
      this._hydrateStatusFromCache();
      const cached = window.Discovery.cachedBundle();
      if (cached) this._bundle = cached;
      this._loading = !cached;
      this.render();
    }

    async onMount() {
      this._hydrateStatusFromCache();
      this.listen("discover", (b) => {
        // A background SWR refresh landed: repaint the rails from it.
        if (b && b !== this._bundle) { this._bundle = b; this._paintAll(); }
      });
      this.listen("myCollectionMap", () => this._refreshCollectionData());
      this.listen("offline", (offline) => { if (!offline) this._retryInitial(); });
      this.listenDom("status-changed", (e) => {
        const { gameId, status } = e.detail || {};
        if (!gameId) return;
        if (status == null) delete this._statusMap[gameId];
        else this._statusMap[gameId] = status;
        this._syncStatusPills(gameId, status);
      });
      this._refreshCollectionData();
      await this._load();
      this._attachPull();
    }

    onUnmount() {
      if (this._ptr) this._ptr.detach();
    }

    _attachPull() {
      if (!window.PullToRefresh || !window.PullToRefresh.supported) return;
      this._ptr = this._ptr || new window.PullToRefresh({
        host: this.container,
        onRefresh: () => this._load({ force: true }),
      });
      this._ptr.attach();
    }

    // ── Data ────────────────────────────────────────────────────────────────

    _hydrateStatusFromCache() {
      const warm = window.Collection.cachedStatusMap && window.Collection.cachedStatusMap();
      if (warm) {
        this._statusMap = warm;
        this._statusReady = true;
      }
      const exp = window.Collection.cachedExpansionCounts && window.Collection.cachedExpansionCounts();
      if (exp) this._expansionCounts = exp;
    }

    async _refreshCollectionData() {
      try {
        const [status, exp] = await Promise.all([
          window.Collection.myStatusMap(),
          window.Collection.myExpansionCountByBaseBggId(),
        ]);
        this._statusMap = status || {};
        this._expansionCounts = exp || {};
      } catch (_) {
        // A failed fetch is not "owns nothing" — but it is not "still
        // loading" either. Fall back to the "+" so the viewer can still add.
      }
      this._statusReady = true;
      this._paintAll();
    }

    async _load({ force = false } = {}) {
      const seq = ++this._loadSeq;
      this._loading = true;
      this._error = null;
      this._paintAll();
      try {
        const b = await window.Discovery.bundle({ force });
        if (seq !== this._loadSeq) return;
        this._bundle = b;
      } catch (e) {
        if (seq !== this._loadSeq) return;
        this._error = (e && e.message) || "Couldn't load Discover";
      } finally {
        if (seq === this._loadSeq) {
          this._loading = false;
          this._paintAll();
        }
      }
    }

    /** Bound to the error card's button and to connectivity returning. */
    _retryInitial() {
      if (this._loading || this._bundle) return;
      this._load();
    }

    /**
     * A trending tile the catalog does not have: import it, then open it.
     * POST /games/import-bgg is idempotent, so a race with another viewer
     * importing the same game resolves to the same row.
     */
    async _importStub(bggId) {
      if (!bggId || this._importing.has(bggId)) return;
      this._importing.add(bggId);
      showToast("Adding to the catalog\u2026", "info");
      try {
        const game = await window.Game.importBgg(bggId);
        window.Discovery.invalidate();
        if (game && game.id) {
          window.router.go("game-detail", { gameId: game.id, gameName: game.name });
        }
      } catch (e) {
        showToast((e && e.message) || "Couldn't import that game", "error");
      } finally {
        this._importing.delete(bggId);
      }
    }

    // ── Paint ───────────────────────────────────────────────────────────────

    render() {
      this.container.innerHTML = `
        <div class="discover">
          <header class="discover__head">
            <h2 class="discover__title font-display">Discover</h2>
            <p class="discover__blurb">Games worth a look, picked from what's on your shelf and what hits your table.</p>
          </header>
          <section class="discover__section" id="${HOSTS.picks}"></section>
          <section class="discover__section" id="${HOSTS.climbing}"></section>
          <section class="discover__section" id="${HOSTS.trending}"></section>
          <section class="discover__section" id="${HOSTS.fresh}"></section>
          <section class="discover__section" id="${HOSTS.shelf}"></section>
          <div id="discover-shop-host"></div>
          <p class="discover__footnote">Trending and ratings courtesy of BoardGameGeek.</p>
        </div>
      `;
      this._paintAll();
    }

    _host(key) {
      return this.container && this.container.querySelector(`#${HOSTS[key]}`);
    }

    _paintAll() {
      if (!this.container || !this._host("picks")) return;
      const b = this._bundle;
      if (!b && this._loading) {
        this._paintHosts({
          picks: this._skeleton("sparkles", "Picked for you"),
          climbing: "",
          trending: this._skeleton("flame", "Trending on BoardGameGeek"),
          fresh: this._skeleton("star", "New this year"),
          shelf: this._skeleton("hourglass", "Back on the shelf"),
        });
        return;
      }
      if (!b) {
        // Failed with nothing to show: one retry card, not four.
        this._paintHosts({
          picks: this._renderLoadError(),
          climbing: "", trending: "", fresh: "", shelf: "",
        });
        return;
      }
      this._paintHosts({
        picks: this._renderPicks(b),
        climbing: this._renderClimbing(b),
        trending: this._renderTrending(b),
        fresh: this._renderNew(b),
        shelf: this._renderShelf(b),
      });
      if (window.scheduleRailTitleFit) window.scheduleRailTitleFit();
      this._loadShopFooter(b);
    }

    /**
     * "Shop these games" under the rails — one line that opens the top pick's
     * page, where the Where to buy section lives. Rendered only when the
     * affiliate endpoint says a partner is live; otherwise the host stays
     * empty and nothing about affiliates is on this screen at all.
     */
    async _loadShopFooter(b) {
      const host = this.container && this.container.querySelector("#discover-shop-host");
      if (!host || !window.Affiliate) return;
      const top = (b.picks || []).map((p) => p.game).find((g) => g && g.id);
      if (!top) { host.innerHTML = ""; return; }
      const cached = window.Affiliate.cachedLinks(top.id);
      const paint = (res) => {
        if (this._bundle !== b) return;
        host.innerHTML = (res && res.live)
          ? `<p class="discover__shop">
               <i data-icon="box" class="w-4 h-4"></i>
               Shop these games \u2014
               <a class="link" href="#" onclick="event.preventDefault(); window.Affiliate.click('', '${escapeAttr(top.id)}', 'discover'); ${escapeAttr(gameDetailJs(top.id, top.name))}">see where to buy ${escapeHtml(top.name)}</a>
             </p>`
          : "";
        this.refreshIcons(host);
      };
      if (cached) paint(cached);
      try {
        paint(await window.Affiliate.links(top.id));
      } catch (_) {
        if (!cached) host.innerHTML = "";
      }
    }

    _paintHosts(html) {
      for (const key of Object.keys(html)) {
        const host = this._host(key);
        if (!host) continue;
        host.innerHTML = html[key];
        this.refreshIcons(host);
      }
    }

    _railOpts(extra) {
      return {
        statusMap: this._statusMap,
        statusReady: this._statusReady,
        expansionCounts: this._expansionCounts,
        flush: true,
        eager: true,
        clickHandler: (g) => gameDetailJs(g.id, g.name),
        ...extra,
      };
    }

    _renderPicks(b) {
      const picks = b.picks || [];
      const entries = picks.map((p) => ({
        game: p.game,
        reason: p.reason_label || "",
        meta: this._ratingMeta(p.game),
      }));
      const cold = picks.length && picks.every((p) => p.cold_start);
      return window.renderGameRail(entries, this._railOpts({
        icon: "sparkles",
        title: "Picked for you",
        subtitle: cold ? "Log a few plays and add some games to your shelf \u2014 we'll get personal." : "",
        emptyHtml: this._empty("Log a few plays and add some games to your shelf \u2014 we'll get personal."),
      }));
    }

    _renderTrending(b) {
      if (b.trending_error && !(b.trending || []).length) {
        return `
          <section class="feed-rail feed-rail--flush">
            <header class="feed-rail__header">
              <h3><i data-icon="flame" class="w-4 h-4"></i> Trending on BoardGameGeek</h3>
            </header>
            <div class="discover__rail-error">
              <p>BoardGameGeek isn't answering right now.</p>
              <button class="btn btn-ghost btn-sm" onclick="window.discoveryView._load({ force: true })">Try again</button>
            </div>
          </section>
        `;
      }
      const entries = (b.trending || []).map((t) => this._trendingEntry(t));
      return window.renderGameRail(entries, this._railOpts({
        icon: "flame",
        title: "Trending on BoardGameGeek",
        stubHandler: (s) => `window.discoveryView._importStub(${Number(s.bgg_id) || 0})`,
        emptyHtml: this._empty("Nothing trending to show just now."),
      }));
    }

    /**
     * A trending row as a rail entry. The meta line carries the rank and,
     * when the snapshot knows it (migration 039), the move since the run a
     * day earlier: "#3 on BGG · ▲2", "· ▼1", "· NEW". Text on the existing
     * meta line rather than a new chip — the tile is 112px wide.
     */
    _trendingEntry(t) {
      let move = "";
      if (t.is_new) move = " \u00b7 NEW";
      else if (typeof t.rank_delta === "number" && t.rank_delta > 0) move = ` \u00b7 \u25b2${t.rank_delta}`;
      else if (typeof t.rank_delta === "number" && t.rank_delta < 0) move = ` \u00b7 \u25bc${-t.rank_delta}`;
      const meta = `#${t.rank} on BGG${move}`;
      return t.game
        ? { game: t.game, meta }
        : { stub: { bgg_id: t.bgg_id, name: t.name, thumbnail_url: t.thumbnail_url, year_published: t.year_published }, meta };
    }

    /**
     * What moved up since yesterday's run — the interesting half of a hot
     * list. Only when at least three games climbed three or more places;
     * fewer is noise, and before the first two snapshots there is nothing to
     * compare, so the section stays empty rather than saying so.
     */
    _renderClimbing(b) {
      const climbers = (b.trending || [])
        .filter((t) => typeof t.rank_delta === "number" && t.rank_delta >= 3)
        .sort((x, y) => y.rank_delta - x.rank_delta);
      if (climbers.length < 3) return "";
      return window.renderGameRail(climbers.map((t) => this._trendingEntry(t)), this._railOpts({
        icon: "arrow-up-right",
        title: "Climbing this week",
        subtitle: "Up the BoardGameGeek hot list since yesterday.",
        stubHandler: (s) => `window.discoveryView._importStub(${Number(s.bgg_id) || 0})`,
      }));
    }

    _renderNew(b) {
      const entries = (b.new_this_year || []).map((g) => ({ game: g, meta: this._ratingMeta(g) }));
      return window.renderGameRail(entries, this._railOpts({
        icon: "star",
        title: `New in ${b.new_year || new Date().getFullYear()}`,
        emptyHtml: this._empty("No new releases in the catalog yet \u2014 import one from BoardGameGeek and it'll show up here."),
      }));
    }

    _renderShelf(b) {
      const entries = (b.back_on_shelf || []).map((d) => ({
        game: d.game,
        meta: d.last_played_at ? `Last played ${formatRelativeDay(d.last_played_at)}` : "Never played",
      }));
      return window.renderGameRail(entries, this._railOpts({
        icon: "hourglass",
        title: "Back on the shelf",
        subtitle: entries.length ? `Owned, and not played in ${b.dormant_days || 60} days.` : "",
        emptyHtml: this._empty("Nothing's gathering dust \u2014 everything you own has hit the table lately."),
      }));
    }

    /** "★ 7.8" when the catalog knows the rating, else the players/time line. */
    _ratingMeta(g) {
      if (g && typeof g.bgg_rating === "number" && g.bgg_rating > 0) {
        return `\u2605 ${g.bgg_rating.toFixed(1)}`;
      }
      return null;
    }

    _empty(text) {
      return `<p class="discover__empty">${escapeHtml(text)}</p>`;
    }

    _skeleton(icon, title) {
      const tiles = Array.from({ length: 4 }, () => `<div class="discover__skeleton-tile"></div>`).join("");
      return `
        <section class="feed-rail feed-rail--flush" aria-busy="true">
          <header class="feed-rail__header">
            <h3><i data-icon="${escapeAttr(icon)}" class="w-4 h-4"></i> ${escapeHtml(title)}</h3>
          </header>
          <div class="feed-rail__scroll discover__skeleton">${tiles}</div>
        </section>
      `;
    }

    _renderLoadError() {
      return `
        <div class="feed-empty">
          <img src="assets/illustrations/bgb-loading.svg" alt="" style="width:120px;height:120px;opacity:.4" />
          <h3 class="text-lg font-semibold mt-3">Couldn't load Discover</h3>
          <p class="text-sm opacity-70 mt-1">${escapeHtml(this._error || "")}</p>
          <button class="btn btn-primary btn-sm mt-3"
                  onclick="window.discoveryView._retryInitial()">Try again</button>
        </div>
      `;
    }

    /** Repaint one game's corner pill wherever it is on screen. */
    _syncStatusPills(gameId, status) {
      const root = this.container;
      if (!root) return;
      const sel = cssAttrEscape(gameId);
      root.querySelectorAll(`.game-polaroid[data-game-id="${sel}"]`)
        .forEach((tile) => window.syncGamePolaroidStatus(tile, status || null));
    }
  }

  window.DiscoveryView = DiscoveryView;
})();
