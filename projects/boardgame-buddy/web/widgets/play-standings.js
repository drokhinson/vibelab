// widgets/play-standings.js — the Play step's Players page: everyone at the
// table, highest score first.
//
// It reads the scoring grid's own COLUMNS (window.roundGridColumns), not the
// roster, so it can never disagree with the grid about who scores together.
// A side the grid merged into one column is one blob here — the side's name
// and its total once, its members inside — because that is one score, not
// several. A seat on no side, or a side the grid had to split (its members'
// numbers disagree), is a row of its own.
//
// Nothing on this page adds or removes a seat; that is Gather's job, and the
// roster is frozen server-side once Play starts. The one control is the team
// chip, and only in a team play: the host draws it (play-flow-view's
// _renderTeamChip / _renderTeamStrip), so the picker here is the Gather one.
//
// Pure string renderer, like widgets/round-score-grid.js.
//
//   renderPlayStandings(columns, {
//     total(col)          → number, the column's total as the grid shows it
//     anyScore            → boolean, has a number been entered anywhere yet
//     rounds              → number of rounds so far
//     name(p)             → the seat's display name (alias-aware)
//     badge(p, shown)     → the seat's avatar markup
//     seatKey(p, i)       → stable key for the reorder animation
//     chip(p, i, shown)   → team chip markup, or omitted outside team play
//     strip(p, i, shown)  → the open team picker under a seat, or ""
//   })

// @ts-check

(function () {
  /**
   * Standard competition ranking: two on 30 share 1st, the next is 3rd.
   * @param {number[]} sorted  totals, highest first
   * @param {number} v
   */
  const rankOf = (sorted, v) => 1 + sorted.findIndex((x) => x === v);

  /** @param {number} v @param {number} top @param {boolean} first @param {boolean} any */
  function gapText(v, top, first, any) {
    if (!any) return "";
    if (v === top) return first ? "Leading" : "Tied for the lead";
    return `${top - v} behind`;
  }

  /**
   * @param {any[]} columns
   * @param {any} o
   */
  function renderPlayStandings(columns, o) {
    const rows = columns
      .map((col, k) => ({ col, k, v: Number(o.total(col)) || 0 }))
      .sort((a, b) => b.v - a.v || a.k - b.k);
    if (!rows.length) return "";
    const totals = rows.map((r) => r.v);
    const top = totals[0];

    const member = (p, i, cls) => {
      const shown = o.name(p);
      return `
        <div class="${cls}">
          ${o.badge(p, shown)}
          <span class="standing__name">${escapeHtml(shown)}</span>
          ${o.chip ? o.chip(p, i, shown) : ""}
        </div>
        ${o.strip ? o.strip(p, i, shown) : ""}`;
    };

    const items = rows.map(({ col, v }, n) => {
      const rank = rankOf(totals, v);
      const gap = gapText(v, top, n === 0, o.anyScore);
      const lead = o.anyScore && v === top;
      const tint = col.slot ? ` style="--sw: var(--team-${col.slot})"` : "";
      const score = `<span class="standing__score">${v}</span>`;
      const rankEl = `<span class="standing__rank">${rank}</span>`;

      if (col.merged) {
        return `
          <li class="standing standing--side${lead ? " is-lead" : ""}"
              data-standing="t:${escapeAttr(col.key)}"${tint}>
            <div class="standing__row">
              ${rankEl}
              <span class="standing__who">
                <span class="standing__side-name">${escapeHtml(col.label)}</span>
                ${gap ? `<span class="standing__gap">${gap}</span>` : ""}
              </span>
              ${score}
            </div>
            <div class="standing__members">
              ${col.players.map((p, k) => member(p, col.indexes[k], "standing__member")).join("")}
            </div>
          </li>`;
      }

      const p = col.players[0];
      const i = col.indexes[0];
      const shown = o.name(p);
      return `
        <li class="standing${lead ? " is-lead" : ""}" data-standing="p:${escapeAttr(o.seatKey(p, i))}"${tint}>
          <div class="standing__row">
            ${rankEl}
            ${o.badge(p, shown)}
            <span class="standing__who">
              <span class="standing__name">${escapeHtml(shown)}</span>
              ${gap ? `<span class="standing__gap">${gap}</span>` : ""}
            </span>
            ${o.chip ? o.chip(p, i, shown) : ""}
            ${score}
          </div>
          ${o.strip ? o.strip(p, i, shown) : ""}
        </li>`;
    }).join("");

    const sub = o.anyScore
      ? `After ${o.rounds === 1 ? "round 1" : `${o.rounds} rounds`}`
      : "No scores yet";
    return `
      <section class="cascade-card cascade-card--standings">
        <div class="standings__head">
          <label class="cascade-card__label">Players</label>
          <span class="standings__sub">${sub}</span>
        </div>
        <ol class="standings">${items}</ol>
      </section>`;
  }

  /**
   * Repaint the page in place and slide each row from where it was to where
   * it now ranks, so a lead changing hands reads as movement, not a reshuffle.
   * @param {HTMLElement} host
   * @param {string} html
   * @param {boolean} animate
   */
  function patchPlayStandings(host, html, animate) {
    const before = new Map();
    if (animate) {
      host.querySelectorAll("[data-standing]").forEach((el) => {
        before.set(el.getAttribute("data-standing"), el.getBoundingClientRect().top);
      });
    }
    host.innerHTML = html;
    if (!animate || !before.size) return;
    host.querySelectorAll("[data-standing]").forEach((el) => {
      const was = before.get(el.getAttribute("data-standing"));
      if (was == null) return;
      const d = was - el.getBoundingClientRect().top;
      if (Math.abs(d) < 1) return;
      el.animate([{ transform: `translateY(${d}px)` }, { transform: "none" }],
        { duration: 320, easing: "cubic-bezier(.22, .61, .36, 1)" });
    });
  }

  window.renderPlayStandings = renderPlayStandings;
  window.patchPlayStandings = patchPlayStandings;
})();
