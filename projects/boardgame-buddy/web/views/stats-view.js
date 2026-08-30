// views/stats-view.js — the Stats spoke (/profile/stats).
//
// Reached from the Profile hub's "Your stats" card. Everything on this screen
// comes from ONE call, GET /users/me/stats/detail, backed by the
// bgb_user_stats_detail RPC (migration 058) — podium, per-game breakdown,
// nemesis, play rhythm, unplayed shelf, table size, taste, comebacks, co-op
// record and personal bests. Nothing here fetches per card.
//
// Screen order is deliberate: the podium is the thing worth opening the screen
// for, so it leads; the career strip anchors it in totals; the game picker is
// the only interactive block and sits above the fold's end; the small cards are
// a browse tail. Every block below the picker renders only when its data
// exists, so a new account sees the empty state rather than a wall of zeroes.
//
// @typedef {Object} StatsDetail
// @property {Object} career          total_plays, unique_games, win_count,
//                                    rated_plays, rated_wins, hours_played,
//                                    first_played_at, last_played_at
// @property {Array}  podium          up to 3 × {game_id, name, thumbnail_url, plays}
// @property {Array}  games           per-game rows for the picker
// @property {?Object} nemesis        {user_id, display_name, avatar, shared_plays,
//                                     their_wins, your_wins} — null under 3 shared plays
// @property {Object} rhythm          {weeks[], current_streak_weeks,
//                                     longest_streak_weeks, busiest_weekday}
// @property {Object} shelf           {owned, played, unplayed, marked,
//                                    games[], games_truncated} — games are the
//                                    owned base games with no logged plays,
//                                    for the shelf sheet to list and toggle
// @property {Object} table_size      {avg, buckets[]}
// @property {Array}  taste           up to 6 × {name, plays}
// @property {Object} comeback        {wins_from_behind, tracked_plays}
// @property {Object} coop            {wins, losses}
// @property {Array}  personal_bests  up to 5 × {game_id, name, plays, score, played_at}

(function () {
  const HEAT_WEEKS = 26;
  const MEDALS = ["", "stats-plinth--1", "stats-plinth--2", "stats-plinth--3"];
  const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const PLAYER_LABEL = { 1: "Solo", 2: "2 players", 3: "3 players", 4: "4 players", 5: "5+" };
  // 2πr for the two dials below, so the dasharray never drifts from the r in
  // the markup.
  const RING_R = 44;
  const SHELF_R = 24;
  // Stable host for the By-game card, so picking a game can swap just that
  // section instead of the whole screen.
  const BY_GAME_ID = "stats-by-game";
  // Same idea for the Shelf of shame card: marking a game as played from the
  // sheet moves the ring and the sentence, and nothing else on the screen.
  const SHELF_ID = "stats-shelf";

  class StatsView extends window.View {
    constructor() {
      super("stats");
      this._resetState();
    }

    // Singleton views survive logout → login and back-stack pops, so every
    // transient field is reset here and this runs from both the constructor
    // and the top of onMount (.claude/rules/web-frontend.md).
    _resetState() {
      this._detail = null;
      this._loading = false;
      this._error = null;
      this._selectedGameId = null;
    }

    async onMount() {
      this._resetState();
      // Paint whatever the cache still holds before awaiting anything — a
      // re-entry inside the fresh window then never flashes a loader.
      this._detail = window.Stats.cachedDetail();
      this._loading = !this._detail;
      this.render();
      await this._load();
    }

    renderLoading() { this.render(); }

    async _load() {
      this._error = null;
      try {
        const detail = await window.Stats.detail();
        if (!this._mounted) return;
        this._detail = detail;
      } catch (e) {
        // A cached payload is better than an error screen: the numbers move
        // once a game night, so a stale podium is still a true one.
        if (!this._detail) this._error = (e && e.message) || "Couldn't load your stats";
      } finally {
        this._loading = false;
        this.render();
      }
    }

    // ── Render ────────────────────────────────────────────────────────────────
    render() {
      const c = this.container;
      if (!c) return;
      const d = this._detail;

      if (!d && this._loading) {
        c.innerHTML = `
          ${this._renderHead(null)}
          <div class="profile-loading">${window.buddyLoader({ size: 96, label: "Crunching your plays…" })}</div>
        `;
        this.refreshIcons();
        return;
      }
      if (!d) {
        c.innerHTML = `
          ${this._renderHead(null)}
          <div class="alert alert-error text-sm mt-3">${escapeHtml(this._error || "Couldn't load your stats")}</div>
        `;
        this.refreshIcons();
        return;
      }

      const career = d.career || {};
      if (!career.total_plays) {
        c.innerHTML = `${this._renderHead(career)}${this._renderEmpty()}`;
        this.refreshIcons();
        return;
      }

      c.innerHTML = `
        ${this._renderHead(career)}
        ${this._renderPodium(d.podium)}
        ${this._renderStrip(career)}
        ${this._renderByGame(d.games)}
        ${this._renderNemesis(d.nemesis)}
        ${this._renderRhythm(d.rhythm)}
        ${this._renderShelfAndTable(d.shelf, d.table_size)}
        ${this._renderTasteAndComeback(d.taste, d.comeback, d.coop)}
        ${this._renderPersonalBests(d.personal_bests)}
        <div style="height: 1rem"></div>
      `;
      this.refreshIcons();
    }

    _renderHead(career) {
      const plays = career && career.total_plays;
      return `
        <header class="spoke-head">
          <button class="spoke-head__back" type="button" aria-label="Back to profile"
                  onclick="window.router.back('profile-self')">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="spoke-head__title"><span class="spoke-head__title-text">Stats</span></h2>
          ${plays ? `<span class="spoke-head__count">${plays} ${plays === 1 ? "play" : "plays"}</span>` : ""}
        </header>
      `;
    }

    _renderEmpty() {
      return `
        <div class="stats-empty">
          <div class="stats-empty__h font-display">Nothing to count yet</div>
          <p class="stats-empty__p">
            Log a play and this screen fills in — your most-played podium, who
            beats you most, and how often you actually get to the table.
          </p>
          <button class="btn btn-primary btn-sm" onclick="window.router.go('log-play')">
            <i data-icon="dices" class="w-4 h-4"></i> Log a play
          </button>
        </div>
      `;
    }

    // ── Podium ────────────────────────────────────────────────────────────────
    // Second place goes on the left and first in the middle, the way a real
    // podium reads — not 1-2-3 left to right.
    _renderPodium(podium) {
      const rows = Array.isArray(podium) ? podium.slice(0, 3) : [];
      if (!rows.length) return "";
      const order = rows.length === 1 ? [0] : rows.length === 2 ? [1, 0] : [1, 0, 2];
      const stageMod = rows.length < 3 ? ` stats-podium__stage--${rows.length}` : "";
      return `
        <section class="stats-podium">
          <div class="stats-podium__eyebrow">
            <i data-icon="trophy" class="w-3.5 h-3.5"></i> Most played, all time
          </div>
          <div class="stats-podium__stage${stageMod}">
            ${order.map((i) => this._plinth(rows[i], i + 1)).join("")}
          </div>
          <div class="stats-podium__floor"></div>
        </section>
      `;
    }

    _plinth(row, rank) {
      const name = row.name || "";
      const art = gameArtImg(row, "chip", { alt: name });
      const nav = `window.router.go('game-detail',{gameId:'${row.game_id}',gameName:'${jsStr(name)}'})`;
      return `
        <button class="stats-plinth ${MEDALS[rank]}" type="button" onclick="${nav}"
                aria-label="${escapeAttr(`${name}, number ${rank}, ${row.plays} plays`)}">
          <span class="stats-plinth__art">
            ${art || `<span class="stats-plinth__art-fallback">${escapeHtml(name.slice(0, 24))}</span>`}
          </span>
          <span class="stats-plinth__name">${escapeHtml(name)}</span>
          <span class="stats-plinth__plays">${row.plays} ${row.plays === 1 ? "play" : "plays"}</span>
          <span class="stats-plinth__base">${rank}</span>
        </button>
      `;
    }

    // ── Career strip ──────────────────────────────────────────────────────────
    _renderStrip(career) {
      // Win rate divides by rated_plays — competitive plays the user actually
      // sat in — never by total_plays. See the RPC's header comment.
      const rate = career.rated_plays
        ? `${Math.round((career.rated_wins / career.rated_plays) * 100)}%`
        : "—";
      return `
        <section class="stats-strip">
          <div class="stats-strip__c">
            <div class="stats-strip__v">${career.total_plays || 0}</div>
            <div class="stats-strip__k">Plays</div>
          </div>
          <div class="stats-strip__c" title="${escapeAttr(
            career.rated_plays
              ? `${career.rated_wins} wins across ${career.rated_plays} competitive plays you sat in`
              : "No competitive plays yet",
          )}">
            <div class="stats-strip__v">${rate}</div>
            <div class="stats-strip__k">Win rate</div>
          </div>
          <div class="stats-strip__c">
            <div class="stats-strip__v">${career.unique_games || 0}</div>
            <div class="stats-strip__k">Games</div>
          </div>
          <div class="stats-strip__c">
            <div class="stats-strip__v">${Math.round(career.hours_played || 0)}</div>
            <div class="stats-strip__k">Hours</div>
          </div>
        </section>
      `;
    }

    // ── By game ───────────────────────────────────────────────────────────────
    _games() {
      return (this._detail && Array.isArray(this._detail.games) && this._detail.games) || [];
    }

    _selectedGame() {
      const games = this._games();
      if (!games.length) return null;
      const found = this._selectedGameId
        ? games.find((g) => g.game_id === this._selectedGameId)
        : null;
      // Default to the most-played game — the list is already ordered by plays.
      return found || games[0];
    }

    // The section is a stable host: `_selectGame` swaps its insides rather
    // than repainting the screen, so BY_GAME_ID and _renderByGameInner are
    // split out from the wrapper for the two call sites to share.
    _renderByGame(games) {
      if (!Array.isArray(games) || !games.length) return "";
      return `
        <section class="preview-card" id="${BY_GAME_ID}">
          ${this._renderByGameInner(games)}
        </section>
      `;
    }

    _renderByGameInner(games) {
      const g = this._selectedGame();
      return `
        <header class="preview-card__head">
          <span class="preview-card__icon"><i data-icon="dice-6" class="w-4 h-4"></i></span>
          <h3 class="preview-card__title font-display">By game</h3>
          <span class="preview-card__sub">${games.length} played</span>
        </header>

        <button class="stats-picker" type="button" aria-haspopup="dialog"
                onclick="window.statsView._openPicker(event)">
          <span class="stats-picker__art">${gameArtImg(g, "chip", { alt: "" })}</span>
          <span class="stats-picker__l">
            <span class="stats-picker__lab">Showing</span>
            <span class="stats-picker__name">${escapeHtml(g.name || "")}</span>
          </span>
          <span class="stats-picker__chev"><i data-icon="chevron-down" class="w-4 h-4"></i></span>
        </button>

        ${this._renderGamePanel(g)}
      `;
    }

    _renderGamePanel(g) {
      const pct = g.plays ? Math.round((g.wins / g.plays) * 100) : 0;
      const circ = 2 * Math.PI * RING_R;
      const offset = circ * (1 - pct / 100);
      const isCoop = g.play_mode === "coop";
      // A co-op game has no per-player score to average, and a competitive one
      // may simply never have had scores typed in. Both land on the same
      // dashes; the footnote is what tells them apart.
      const noScores = g.avg_winning_score == null;
      const scoreCell = (v) => (noScores
        ? `<span class="stats-fact__v stats-fact__v--none">no scores</span>`
        : `<span class="stats-fact__v">${v}</span>`);

      return `
        <div class="stats-ratio">
          <div class="stats-ring">
            <svg width="104" height="104" viewBox="0 0 104 104" aria-hidden="true">
              <circle class="stats-ring__track" cx="52" cy="52" r="${RING_R}" fill="none" stroke-width="11" />
              <circle class="stats-ring__arc" cx="52" cy="52" r="${RING_R}" fill="none" stroke-width="11"
                      stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}"
                      stroke-dashoffset="${offset.toFixed(1)}" />
            </svg>
            <div class="stats-ring__mid">
              <div>
                <div class="stats-ring__pct">${pct}%</div>
                <div class="stats-ring__lab">${isCoop ? "Table wins" : "Win rate"}</div>
              </div>
            </div>
          </div>
          <div class="stats-facts">
            <div class="stats-fact"><span class="stats-fact__k">Plays</span><span class="stats-fact__v">${g.plays}</span></div>
            <div class="stats-fact"><span class="stats-fact__k">Wins</span><span class="stats-fact__v stats-fact__v--gold">${g.wins}</span></div>
            <div class="stats-fact"><span class="stats-fact__k">Avg winning score</span>${scoreCell(g.avg_winning_score)}</div>
            <div class="stats-fact"><span class="stats-fact__k">Your average</span>${scoreCell(g.your_avg_score)}</div>
            <div class="stats-fact"><span class="stats-fact__k">Your best</span>${scoreCell(g.your_best_score)}</div>
          </div>
        </div>

        <div class="stats-split">
          <i class="stats-split__win" style="width:${pct}%"></i>
          <i class="stats-split__loss" style="width:${100 - pct}%"></i>
        </div>
        <div class="stats-legend">
          <span>${isCoop ? "Beat the game" : "Won"} <b>${g.wins}</b></span>
          <span>${isCoop ? "Lost to it" : "Lost"} <b>${g.plays - g.wins}</b></span>
        </div>

        <p class="stats-foot">${this._panelFootnote(g, isCoop, noScores)}</p>
      `;
    }

    _panelFootnote(g, isCoop, noScores) {
      const last = g.last_played_at ? ` Last played ${formatDate(g.last_played_at)}.` : "";
      if (isCoop) {
        return escapeHtml(
          `Co-operative game — a win here is the whole table beating the game, and no per-player score is kept.${last}`,
        );
      }
      if (noScores) {
        return escapeHtml(`No scores were logged on any of these plays, so there's no average to show.${last}`);
      }
      return escapeHtml(
        `Winning score averaged across the ${g.scored_plays} of ${g.plays} ` +
        `${g.plays === 1 ? "play" : "plays"} that recorded scores.${last}`,
      );
    }

    // ── Extra cards ───────────────────────────────────────────────────────────
    _renderNemesis(n) {
      // Null under three shared plays — one lucky evening is not a rivalry.
      if (!n) return "";
      const shared = n.shared_plays || 0;
      const theirs = n.their_wins || 0;
      const yours = n.your_wins || 0;
      const other = Math.max(0, shared - theirs - yours);
      // The RPC counts nemesis over competitive plays only, so these three
      // normally sum to `shared`. A play with joint winners (a tie the table
      // called) can still push them over it, and three segments totalling
      // >100% would spill out of the bar — divide by whichever is larger.
      const total = Math.max(shared, yours + theirs + other) || 1;
      const pctOf = (v) => (v / total) * 100;
      const badge = window.BgbBadge.render({
        avatar: n.avatar,
        displayName: n.display_name,
        size: "sm",
        extraClass: "stats-nemesis__av",
      });
      return `
        <section class="preview-card">
          <header class="preview-card__head">
            <span class="preview-card__icon"><i data-icon="flame" class="w-4 h-4"></i></span>
            <h3 class="preview-card__title font-display">Nemesis</h3>
            <span class="preview-card__sub">${shared} shared ${shared === 1 ? "play" : "plays"}</span>
            <button class="preview-card__seeall" onclick="window.router.go('profile-other',{userId:'${jsStr(n.user_id)}'})">
              Profile <i data-icon="chevron-right" class="w-3 h-3"></i>
            </button>
          </header>
          <div class="stats-nemesis">
            ${badge}
            <div class="stats-nemesis__body">
              <div class="stats-nemesis__n">${escapeHtml(n.display_name || "")}</div>
              <div class="stats-nemesis__s">
                They've won ${theirs} of the ${shared} ${shared === 1 ? "game" : "games"} you've both sat down for.
              </div>
            </div>
          </div>
          <div class="stats-split">
            <i class="stats-split__win" style="width:${pctOf(yours).toFixed(1)}%"></i>
            <i class="stats-split__them" style="width:${pctOf(theirs).toFixed(1)}%"></i>
            <i class="stats-split__loss" style="width:${pctOf(other).toFixed(1)}%"></i>
          </div>
          <div class="stats-legend">
            <span>You <b>${yours}</b></span>
            <span>${escapeHtml(this._firstName(n.display_name))} <b>${theirs}</b></span>
            ${other ? `<span>Someone else <b>${other}</b></span>` : ""}
          </div>
        </section>
      `;
    }

    _renderRhythm(r) {
      if (!r || !Array.isArray(r.weeks) || !r.weeks.length) return "";
      const weeks = r.weeks.slice(-HEAT_WEEKS);
      const peak = Math.max(1, ...weeks.map((w) => w.plays || 0));
      // One cell per WEEK, not per day: the RPC buckets by week, and a
      // seven-row day grid built from weekly totals would be six empty rows
      // pretending to be data. Three levels scaled to the window's own peak, so
      // a two-plays-a-month player gets a readable strip rather than one
      // uniformly faint block.
      const grid = weeks.map((w) => {
        const n = w.plays || 0;
        if (!n) return `<i title="${escapeAttr(this._weekLabel(w) + " — no plays")}"></i>`;
        const lvl = n >= peak * 0.75 ? 3 : n >= peak * 0.4 ? 2 : 1;
        const label = `${this._weekLabel(w)} — ${n} ${n === 1 ? "play" : "plays"}`;
        return `<i data-l="${lvl}" title="${escapeAttr(label)}"></i>`;
      }).join("");
      const career = this._detail.career || {};
      const bw = r.busiest_weekday;
      const busiestPct = bw && career.total_plays
        ? Math.round((bw.plays / career.total_plays) * 100)
        : 0;
      return `
        <section class="preview-card">
          <header class="preview-card__head">
            <span class="preview-card__icon"><i data-icon="history" class="w-4 h-4"></i></span>
            <h3 class="preview-card__title font-display">Play rhythm</h3>
            <span class="preview-card__sub">Last ${weeks.length} weeks</span>
          </header>
          <div class="stats-heat" aria-hidden="true">${grid}</div>
          <div class="stats-heat-legend">
            <span>${escapeHtml(this._monthLabel(weeks[0]))}</span>
            <span>${escapeHtml(this._monthLabel(weeks[Math.floor(weeks.length / 2)]))}</span>
            <span>${escapeHtml(this._monthLabel(weeks[weeks.length - 1]))}</span>
          </div>
          <div class="stats-duo" style="margin-top:0.7rem">
            <div class="stats-mini stats-mini--flat">
              <div class="stats-mini__k"><i data-icon="flame" class="w-3 h-3"></i> Current streak</div>
              <div class="stats-mini__v">${r.current_streak_weeks || 0} ${(r.current_streak_weeks === 1) ? "week" : "weeks"}</div>
              <div class="stats-mini__d">Best ever <b>${r.longest_streak_weeks || 0}</b></div>
            </div>
            ${bw ? `
              <div class="stats-mini stats-mini--flat">
                <div class="stats-mini__k"><i data-icon="clock" class="w-3 h-3"></i> Game night</div>
                <div class="stats-mini__v stats-mini__v--sm">${escapeHtml(DOW[bw.dow] || "")}s</div>
                <div class="stats-mini__d"><b>${busiestPct}%</b> of all plays</div>
              </div>` : ""}
          </div>
        </section>
      `;
    }

    // The shelf card is a stable host: a mark applied from the sheet swaps its
    // insides rather than repainting the screen, so SHELF_ID and _renderShelf
    // are split out for the two call sites to share — the same shape
    // BY_GAME_ID / _renderByGameInner already use.
    _renderShelfAndTable(shelf, table) {
      const hasShelf = shelf && shelf.owned > 0;
      const buckets = (table && Array.isArray(table.buckets) && table.buckets) || [];
      const hasTable = table && table.avg != null && buckets.length;
      if (!hasShelf && !hasTable) return "";
      const peak = Math.max(1, ...buckets.map((b) => b.plays));
      return `
        <div class="stats-duo">
          ${hasShelf ? `
            <div class="stats-mini" id="${SHELF_ID}">${this._renderShelf(shelf)}</div>` : ""}
          ${hasTable ? `
            <div class="stats-mini">
              <div class="stats-mini__k"><i data-icon="users" class="w-3 h-3"></i> Table size</div>
              <div class="stats-mini__v">${table.avg}<small> avg</small></div>
              <div class="stats-bars">
                ${buckets.map((b) => this._bar(PLAYER_LABEL[b.size] || `${b.size}+`, b.plays, peak)).join("")}
              </div>
            </div>` : ""}
        </div>
      `;
    }

    // Split so a mark can repaint the dial and the sentence WITHOUT rebuilding
    // the Show button: the sheet holds that button as its return-focus target,
    // and replacing the node would leave a keyboard user on <body> when the
    // sheet closes. The button's presence depends only on games.length, which
    // a mark never changes.
    _renderShelf(shelf) {
      const games = Array.isArray(shelf.games) ? shelf.games : [];
      return `
        <div class="stats-mini__k"><i data-icon="layers" class="w-3 h-3"></i> Shelf of shame</div>
        <div data-shelf-body>${this._renderShelfBody(shelf)}</div>
        ${games.length ? `
          <button class="stats-mini__more" type="button" aria-haspopup="dialog"
                  onclick="window.statsView._openShelfSheet(event)">
            Show <i data-icon="chevron-right" class="w-3 h-3"></i>
          </button>` : ""}
      `;
    }

    _renderShelfBody(shelf) {
      const pctPlayed = Math.round((shelf.played / shelf.owned) * 100);
      const circ = 2 * Math.PI * SHELF_R;
      const marked = shelf.marked || 0;
      return `
        <div class="stats-shelf">
          <div class="stats-shelf__ring">
            <svg width="58" height="58" viewBox="0 0 58 58" aria-hidden="true">
              <circle class="stats-ring__track" cx="29" cy="29" r="${SHELF_R}" fill="none" stroke-width="7" />
              <circle class="stats-ring__arc" cx="29" cy="29" r="${SHELF_R}" fill="none" stroke-width="7"
                      stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}"
                      stroke-dashoffset="${(circ * (1 - pctPlayed / 100)).toFixed(1)}" />
            </svg>
            <div class="stats-shelf__mid">${pctPlayed}%</div>
          </div>
          <div class="stats-mini__d" style="margin-top:0">
            You've played <b>${pctPlayed}%</b> of what you own.
            ${this._shelfLine(shelf, marked)}
          </div>
        </div>
      `;
    }

    _renderTasteAndComeback(taste, comeback, coop) {
      const rows = (Array.isArray(taste) && taste) || [];
      const cb = comeback || {};
      const co = coop || {};
      const coopTotal = (co.wins || 0) + (co.losses || 0);
      const hasSecond = cb.tracked_plays > 0 || coopTotal > 0;
      if (!rows.length && !hasSecond) return "";
      const peak = Math.max(1, ...rows.map((r) => r.plays));
      return `
        <div class="stats-duo">
          ${rows.length ? `
            <div class="stats-mini">
              <div class="stats-mini__k"><i data-icon="puzzle" class="w-3 h-3"></i> Your taste</div>
              <div class="stats-bars">
                ${rows.map((r) => this._bar(r.name, r.plays, peak)).join("")}
              </div>
            </div>` : ""}
          ${hasSecond ? `
            <div class="stats-mini">
              ${cb.tracked_plays ? `
                <div class="stats-mini__k"><i data-icon="sparkles" class="w-3 h-3"></i> Comeback kid</div>
                <div class="stats-mini__v">${cb.wins_from_behind} ${cb.wins_from_behind === 1 ? "win" : "wins"}</div>
                <div class="stats-mini__d">
                  Games you won after trailing at the halfway round — out of
                  <b>${cb.tracked_plays}</b> round-tracked ${cb.tracked_plays === 1 ? "play" : "plays"}.
                </div>` : ""}
              ${coopTotal ? `
                <div class="stats-mini__k" style="margin-top:${cb.tracked_plays ? "0.8rem" : "0"}">
                  <i data-icon="handshake" class="w-3 h-3"></i> Co-op record
                </div>
                <div class="stats-mini__v stats-mini__v--sm">${co.wins}&ndash;${co.losses}</div>
                <div class="stats-mini__d">
                  The table beat the game <b>${Math.round((co.wins / coopTotal) * 100)}%</b> of the time.
                </div>` : ""}
            </div>` : ""}
        </div>
      `;
    }

    _renderPersonalBests(bests) {
      const rows = (Array.isArray(bests) && bests) || [];
      if (!rows.length) return "";
      return `
        <section class="preview-card">
          <header class="preview-card__head">
            <span class="preview-card__icon"><i data-icon="crown" class="w-4 h-4"></i></span>
            <h3 class="preview-card__title font-display">Personal bests</h3>
            <span class="preview-card__sub">Top score per game</span>
          </header>
          <div class="stats-bars">
            ${rows.map((r) => `
              <div class="stats-bar stats-bar--record">
                <span class="stats-bar__k">${escapeHtml(r.name || "")}</span>
                <span class="stats-bar__v">${r.score} &middot; ${escapeHtml(formatDate(r.played_at))}</span>
              </div>
            `).join("")}
          </div>
        </section>
      `;
    }

    // Three cases, not two-plus-a-suffix: "Every box has hit the table" with
    // "4 more are marked as played" bolted on afterwards contradicts itself,
    // because a marked box IS one that has hit the table.
    _shelfLine(shelf, marked) {
      const owned = shelf.owned;
      if (shelf.unplayed) {
        const head = `<b>${shelf.unplayed}</b> of ${owned} ${owned === 1 ? "game has" : "games have"} never hit the table.`;
        return marked
          ? `${head} <b>${marked}</b> more ${marked === 1 ? "is" : "are"} marked as played before you joined.`
          : head;
      }
      return marked
        ? `Every box on the shelf has hit the table, <b>${marked}</b> of them before you joined.`
        : `Every box on the shelf has hit the table.`;
    }

    _bar(label, value, peak) {
      const w = Math.max(4, Math.round((value / peak) * 100));
      return `
        <div class="stats-bar">
          <span class="stats-bar__k" title="${escapeAttr(label)}">${escapeHtml(label)}</span>
          <span class="stats-bar__track"><i style="width:${w}%"></i></span>
          <span class="stats-bar__v">${value}</span>
        </div>
      `;
    }

    // ── Interaction ───────────────────────────────────────────────────────────

    // The sheet lives on document.body, so it outlives any repaint in here and
    // the page behind it never moves — which is the whole reason the picker
    // stopped being an inline disclosure.
    _openPicker(event) {
      const games = this._games();
      if (!games.length) return;
      const current = this._selectedGame();
      window.GamePickerSheet.open({
        games,
        selectedId: current ? current.game_id : null,
        returnFocus: (event && event.currentTarget) || null,
        onPick: (game) => this._selectGame(game.game_id),
      });
    }

    // The shelf sheet needs no fetch: detail.shelf.games came down with the
    // rest of this screen, which is also what makes the sheet's list and the
    // "63 of 74" sentence on the card that opened it impossible to disagree.
    _openShelfSheet(event) {
      const shelf = (this._detail && this._detail.shelf) || null;
      const games = (shelf && Array.isArray(shelf.games) && shelf.games) || [];
      if (!games.length) return;
      window.ShelfOfShameSheet.open({
        games,
        truncated: !!shelf.games_truncated,
        returnFocus: (event && event.currentTarget) || null,
        onToggle: (gameId, playedBefore) => this._applyShelfMark(gameId, playedBefore),
      });
    }

    /**
     * Apply one mark to the local payload and repaint the shelf card alone.
     *
     * Called for the sheet's optimistic paint AND for its rollback, so it sets
     * the state it is handed rather than flipping — two racing writes on one
     * row would otherwise undo the wrong one. No-ops when the row is already
     * in the requested state, so a rollback that changes nothing costs nothing.
     *
     * @param {string} gameId
     * @param {boolean} playedBefore
     */
    _applyShelfMark(gameId, playedBefore) {
      const shelf = (this._detail && this._detail.shelf) || null;
      if (!shelf || !Array.isArray(shelf.games)) return;
      const row = shelf.games.find((g) => g.game_id === gameId);
      if (!row || row.played_before === playedBefore) return;

      row.played_before = playedBefore;
      const d = playedBefore ? 1 : -1;
      shelf.played = (shelf.played || 0) + d;
      shelf.unplayed = (shelf.unplayed || 0) - d;
      shelf.marked = (shelf.marked || 0) + d;

      // The counts above are hand-edited, so the cached payload is now a
      // half-truth. Dropping it means the next mount refetches rather than
      // serving our arithmetic back to us.
      window.Stats.invalidate();

      // The dial and the sentence only — the Show button beside them is the
      // sheet's return-focus target and must survive (see _renderShelf).
      const host = this.container
        && this.container.querySelector(`#${SHELF_ID} [data-shelf-body]`);
      if (!host) return;
      host.innerHTML = this._renderShelfBody(shelf);
      this.refreshIcons(host);
    }

    // Patch the one card that changed instead of rebuilding all nine sections
    // (.claude/rules/web-frontend.md, "Re-render surgically, not the whole
    // screen"). Nothing here awaits — the payload is already in memory — so
    // the swap lands in the same frame as the tap, and the podium, heatmap and
    // the reader's scroll position all stay exactly where they were.
    _selectGame(gameId) {
      this._selectedGameId = gameId;
      const host = this.container && this.container.querySelector(`#${BY_GAME_ID}`);
      if (!host) { this.render(); return; }
      host.innerHTML = this._renderByGameInner(this._games());
      this.refreshIcons(host);
      // The swap replaced the trigger the sheet had handed focus back to, so
      // a keyboard user would be left on <body>. Only when focus actually
      // fell through — never steal it from wherever the user has moved on to.
      if (document.activeElement === document.body) {
        const trigger = host.querySelector(".stats-picker");
        if (trigger) trigger.focus({ preventScroll: true });
      }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    _firstName(name) {
      return String(name || "").trim().split(/\s+/)[0] || "They";
    }

    _monthLabel(week) {
      if (!week || !week.week_start) return "";
      return new Date(week.week_start).toLocaleDateString("en-US", { month: "short" });
    }

    _weekLabel(week) {
      if (!week || !week.week_start) return "";
      return `Week of ${new Date(week.week_start).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    }
  }

  window.StatsView = StatsView;
})();
