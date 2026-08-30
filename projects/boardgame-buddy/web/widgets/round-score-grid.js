// widgets/round-score-grid.js — shared rounds × players scoring grid.
//
// Lifted out of play-flow-view's _renderScoringSection so the play-detail
// popup can render the same table (view + edit mode). Pure-string renderer:
// callers embed the returned HTML directly. State mutations stay with the
// host so each consumer keeps its own persistence path (PlaySession draft
// vs popup edit draft).
//
// Host contract — `host` is a string identifying a global object on
// `window` (e.g. "playFlowView", "PlayDetailPopup"). The renderer wires
// inline handlers to:
//
//   window[host]._setRoundScore(playerIdx, roundIdx, value)
//   window[host]._addRound()
//   window[host]._removeRoundAt(roundIdx)
//   window[host]._toggleWinner(playerIdx)
//
// Each consumer implements these with identical signatures.
//
// The grid has exactly two modes, and `editable` picks between them:
//
//   editable: true  — every cell is an input and the host controls (add round,
//                     remove round, winner trophy) render. The host's live
//                     grid and the play-detail popup's edit mode.
//   editable: false — every cell is a static number and no controls render.
//                     The spectator's mirror and the popup's view mode.
//
// There used to be a third, per-column mode (`editableColumnId`) for the
// spectator, back when a joiner owned their own column. The host is the only
// person who scores now, so a grid is either yours to type in or it isn't.
//
// Opts:
//   editable        — when false, cells render as static spans, "Add round"
//                     and remove buttons are hidden.
//   playMode        — "competitive" | "team" | "coop". Co-op hides the
//                     per-player trophy button (the whole table wins or
//                     loses together).
//   getCellValue    — optional resolver `(player, roundIdx) → string`. Lets
//                     play-flow-view overlay live realtime scores when a
//                     player has a real user_id. Defaults to reading from
//                     player.roundScores.
//   headerNames     — DEFAULT for the column headers: true starts them on the
//                     player's name, false on the colored bubble. The live
//                     play screens (host + joiner mirror) pass true because
//                     names are what you scan mid-game; the play-detail popup
//                     leaves it off. It is only a default — a user who has
//                     tapped a header once carries a stored preference
//                     (RoundGridNames) that wins on every surface, and one tap
//                     flips EVERY column, not just the one tapped.
//
// There is deliberately NO total resolver. The Total row is ALWAYS the sum of
// the very cells this render just emitted — same getCellValue, same round
// range — so "the column doesn't add up" is not a state the grid can reach.
// Consumers that patch the totals row in place must call the exported
// window.roundGridTotal() with the same arguments; anything that recomputes a
// total its own way is a bug waiting to happen (it was: hosts summed each
// player's own roundScores array while the grid rendered the longest array's
// worth of rows, so a short array silently dropped visible cells from its
// total, and a total refresh awaited a network write that could hang).

(function () {
  function renderRoundGrid(players, host, opts) {
    const o = opts || {};
    const editable = o.editable !== false;
    const mode = o.playMode || "competitive";
    const showSign = !!o.showSign;
    // opts.headerNames is this surface's DEFAULT; a stored user choice wins.
    const headerNamesDefault = !!o.headerNames;
    const headerNames = RoundGridNames.enabled(headerNamesDefault);
    const getCell = o.getCellValue || defaultCellValue;
    const safePlayers = Array.isArray(players) ? players : [];
    // Spectators size their grid from the live-scores round count, not from
    // each player's local roundScores array (which they don't have).
    const roundCount = roundGridRoundCount(safePlayers, o.roundCount);
    // One total implementation, fed the same resolver and the same round
    // range the rows below were built from.
    const getTotal = (p) => roundGridTotal(p, roundCount, getCell);

    return `
      <div class="scoring-table-wrap">
        <table class="scoring-table">
          <thead>
            <tr>
              <th></th>
              ${safePlayers.map((p) => `
                <th class="scoring-head${headerNames ? " is-named" : ""}" title="${escapeAttr(p.name)}">${renderScoringHead(renderHeadBadge(p), p.name, headerNames, headerNamesDefault)}</th>
              `).join("")}
            </tr>
          </thead>
          <tbody>
            ${Array.from({ length: roundCount }).map((_, r) => `
              <tr>
                <th class="scoring-round-th">
                  <span class="scoring-round-label">
                    ${editable ? `
                      <button class="scoring-round-remove" title="Remove round"
                              onclick="window.${host}._removeRoundAt(${r})">
                        <i data-icon="x" class="w-3 h-3"></i>
                      </button>
                    ` : ""}
                    R${r + 1}
                  </span>
                </th>
                ${safePlayers.map((p, i) => `
                  <td>
                    ${editable
                      ? renderEditableCell(getCell(p, r), i, r, host, showSign)
                      : `<span class="scoring-cell--read" data-score-cell="${i}-${r}">${escapeHtml(getCell(p, r))}</span>`}
                  </td>
                `).join("")}
              </tr>
            `).join("")}
            <tr class="scoring-total-row">
              <th>Total</th>
              ${safePlayers.map((p, i) => renderTotalsCell(p, i, mode, getTotal(p), host, editable)).join("")}
            </tr>
          </tbody>
        </table>
      </div>
      ${editable ? `
        <div class="scoring-actions">
          <button class="btn btn-ghost btn-xs scoring-add-round" onclick="window.${host}._addRound()">
            <i data-icon="plus" class="w-3.5 h-3.5"></i> Round
          </button>
        </div>
      ` : ""}
    `;
  }

  // One editable cell: a sanitized text input (so a leading "-" survives —
  // `type=number` strips it on some engines) plus an optional +/− sign button.
  // The sign button is gated by the host's "± Negative" toggle so that, by
  // default, phones whose keyboard already has a minus key aren't cluttered.
  function renderEditableCell(rawValue, i, r, host, showSign) {
    const val = rawValue == null ? "" : String(rawValue);
    const neg = val.charAt(0) === "-";
    return `<div class="scoring-cell-wrap${neg ? " is-neg" : ""}">
      ${showSign
        ? `<button type="button" class="scoring-sign-btn${neg ? " is-neg" : ""}" tabindex="-1"
                   aria-label="Toggle positive or negative"
                   onclick="window.${host}._toggleRoundSign(${i}, ${r})">${neg ? "−" : "+"}</button>`
        : ""}
      <input type="text" inputmode="numeric" pattern="-?[0-9]*"
             id="rg-${host}-${i}-${r}" data-score-cell="${i}-${r}"
             class="scoring-cell"
             value="${escapeAttr(val)}"
             oninput="window.${host}._setRoundScore(${i}, ${r}, this.value)" />
    </div>`;
  }

  // Exported as window.renderRoundGridTotalsCell for hosts that repaint the
  // totals row in place between full renders — same markup, same classes, so a
  // patched row can't drift from a freshly rendered one.
  function renderTotalsCell(p, i, mode, total, host, showWinner) {
    // Co-op: the whole table wins or loses together, no per-player trophy.
    const negClass = Number(total) < 0 ? " is-neg" : "";
    const tdClass = p.is_winner ? "scoring-total-cell--winner" : "";
    if (mode === "coop") {
      return `<td class="${tdClass}">
        <div class="scoring-total-cell">
          <span class="scoring-total${negClass}">${escapeHtml(total)}</span>
        </div>
      </td>`;
    }
    return `<td class="${tdClass}">
      <div class="scoring-total-cell">
        ${showWinner
          ? `<button class="scoring-winner-btn ${p.is_winner ? "is-winner" : ""}"
                     title="${p.is_winner ? "Winner" : "Mark as winner"}"
                     onclick="window.${host}._toggleWinner(${i})">
              <i data-icon="${p.is_winner ? "trophy" : "circle"}" class="w-4 h-4"></i>
            </button>`
          : (p.is_winner ? `<i data-icon="trophy" class="w-4 h-4"></i>` : "")}
        <span class="scoring-total${negClass}">${escapeHtml(total)}</span>
      </div>
    </td>`;
  }

  function defaultCellValue(player, r) {
    const v = player.roundScores && player.roundScores[r];
    return v == null || v === "" ? "" : String(v);
  }

  // How many round rows a player set renders. `explicit` (opts.roundCount)
  // wins when the caller knows the count from somewhere other than the local
  // arrays — the joiner sizes its mirror from live-scores round indexes.
  // Otherwise it's the longest roundScores array, which is what the grid has
  // always rendered; the point of exporting it is that totals are now summed
  // over exactly this many rounds too.
  function roundGridRoundCount(players, explicit) {
    if (explicit != null) return Math.max(0, Number(explicit) || 0);
    const safe = Array.isArray(players) ? players : [];
    return Math.max(0, ...safe.map((p) => ((p && p.roundScores) || []).length));
  }

  // The one true column total: the sum of the cells the grid shows for this
  // player. `getCell` must be the same resolver passed to renderRoundGrid and
  // `roundCount` the same count, or the number under the column stops meaning
  // "the cells above me, added up".
  function roundGridTotal(player, roundCount, getCell) {
    const resolve = typeof getCell === "function" ? getCell : defaultCellValue;
    const n = Math.max(0, Number(roundCount) || 0);
    let total = 0;
    for (let r = 0; r < n; r++) {
      total += parseRoundScore(resolve(player, r)) || 0;
    }
    return total;
  }

  // Column-header badge. Renders the player's colored bubble but FORCES
  // initials inside (even when the user picked an icon avatar) so the
  // narrow header column stays scannable while still being color-coded
  // by the player's own palette.
  function renderHeadBadge(p) {
    if (!window.BgbBadge || typeof window.BgbBadge.render !== "function") {
      // Fallback if user-badge.js failed to load — show the raw initials.
      return escapeHtml(initialsFor(p));
    }
    const me = window.store && window.store.get && window.store.get("user");
    return window.BgbBadge.render({
      avatar: p.avatar || null,
      displayName: p.name,
      initials: p.initials || undefined,
      size: "xs",
      isGhost: !p.user_id,
      isMe: !!(me && p.user_id === me.id),
      forceInitials: true,
      extraClass: "scoring-head__badge",
    });
  }

  // Wraps a column-header badge in a button that flips EVERY column header
  // between the colored bubble and the player's display name, and remembers
  // the choice (RoundGridNames). Both spans are always emitted; CSS shows one.
  //
  // Still no host method and still no re-render, for the same reason it never
  // had one: the two states differ by a single class, so there is nothing to
  // rebuild. Routing the tap through a host's `outerHTML` repaint instead
  // would reset `.scoring-table-wrap`'s scrollLeft — on a 5-6 player grid the
  // table snaps back to column 1 — blur whatever cell was being typed in, and
  // give the read-only spectator mirror a host contract it has never needed.
  //
  // `fallback` is the caller's opts.headerNames default, so the first tap on a
  // surface the user has never toggled flips away from what it actually shows.
  function renderScoringHead(badgeHtml, name, isNamed, fallback) {
    return `<button type="button" class="scoring-head__toggle"
              aria-pressed="${isNamed ? "true" : "false"}"
              aria-label="${escapeAttr(name)} — show player names on every column"
              title="${escapeAttr(name)}"
              onclick="window.RoundGridNames.toggleAll(${!!fallback})">
              <span class="scoring-head__bubble">${badgeHtml}</span>
              <span class="scoring-head__name">${escapeHtml(name)}</span>
            </button>`;
  }

  function initialsFor(p) {
    if (p.initials) return p.initials;
    const parts = String(p.name || "").trim().split(/[\s.]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || "?").slice(0, 2).toUpperCase();
  }

  // ── Score value helpers (shared by every grid host) ──────────────────────
  // Cells are stored as STRINGS ("", "-", "-5", "12") so a leading minus and
  // the transient "-"-only state survive editing. These helpers convert to a
  // clean string for storage / display and to a number|null for math.

  // Strip anything that isn't a digit or a leading minus.
  function sanitizeRoundScore(raw) {
    return String(raw == null ? "" : raw)
      .replace(/[^0-9-]/g, "")
      .replace(/(?!^)-/g, "");
  }

  // "" / "-" / null → null ; otherwise the integer value.
  function parseRoundScore(v) {
    if (v == null || v === "" || v === "-") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // Sign-toggle transition: "" → "-", "-" → "", "-5" → "5", "5" → "-5".
  function nextSignToggle(v) {
    const s = String(v == null ? "" : v);
    if (s === "") return "-";
    if (s === "-") return "";
    return s.charAt(0) === "-" ? s.slice(1) : "-" + s;
  }

  // Persisted user preference for whether the per-cell +/− sign buttons show.
  // Defaults OFF — many phone keyboards already expose a minus key, so the
  // toggle is opt-in for the ones that don't.
  const SIGN_PREF_KEY = "bgb.scoring.showSign";
  const RoundGridSign = {
    enabled() {
      try { return localStorage.getItem(SIGN_PREF_KEY) === "1"; } catch (_) { return false; }
    },
    set(on) {
      try { localStorage.setItem(SIGN_PREF_KEY, on ? "1" : "0"); } catch (_) {}
    },
    toggle() {
      const next = !this.enabled();
      this.set(next);
      return next;
    },
    // Header pill that flips the preference. `host` is the global object name
    // (e.g. "playFlowView") whose `_toggleSignButtons()` re-renders the grid.
    renderToggle(host) {
      const on = this.enabled();
      return `<button type="button" class="scoring-sign-toggle${on ? " is-on" : ""}"
                aria-pressed="${on}" title="Toggle +/− sign buttons on each score cell"
                onclick="window.${host}._toggleSignButtons()">
                <span class="scoring-sign-toggle__glyph">±</span>
                <span>toggle</span>
              </button>`;
    },
  };

  // Persisted user preference for whether column headers show the player's
  // display NAME instead of their colored bubble. One value for the whole app:
  // tapping any header moves all of them, on every surface, and it is still
  // set the next time the user opens a grid.
  //
  // Unlike SIGN_PREF_KEY there is no single default — the live play screens
  // (host + spectator mirror) start on names, the play-detail popup on
  // bubbles. So this key is an OVERRIDE: absent means "use this surface's own
  // default", which the caller supplies as `fallback` (opts.headerNames). One
  // tap anywhere and the stored value wins everywhere.
  const NAMES_PREF_KEY = "bgb.scoring.headerNames";
  // Mirrors the stored value for this page's lifetime. A browser that refuses
  // localStorage (private-mode Safari, blocked site data) would otherwise flip
  // the headers and then snap back on the next repaint, which reads as a
  // broken button rather than as a browser setting.
  let _namesChoice = null;
  const RoundGridNames = {
    /**
     * @param {boolean} [fallback] surface default, used only while the user
     *   has never expressed a preference.
     * @returns {boolean}
     */
    enabled(fallback) {
      if (_namesChoice != null) return _namesChoice;
      try {
        const v = localStorage.getItem(NAMES_PREF_KEY);
        if (v === "1") return true;
        if (v === "0") return false;
      } catch (_) {}
      return !!fallback;
    },
    set(on) {
      _namesChoice = !!on;
      try { localStorage.setItem(NAMES_PREF_KEY, on ? "1" : "0"); } catch (_) {}
    },
    /** Flip relative to what is on screen (stored value, else `fallback`). */
    toggle(fallback) {
      const next = !this.enabled(fallback);
      this.set(next);
      return next;
    },
    /**
     * Inline-handler entry point: flip the preference, then repaint every
     * column header in the document. Document-wide rather than per-table so a
     * grid sitting behind the play-detail popup doesn't read stale until its
     * own next repaint.
     * @param {boolean} [fallback]
     */
    toggleAll(fallback) {
      const on = this.toggle(fallback);
      this.apply(on);
      return on;
    },
    /** @param {boolean} on */
    apply(on) {
      const heads = document.querySelectorAll(".scoring-head");
      Array.prototype.forEach.call(heads, (th) => {
        th.classList.toggle("is-named", on);
        const btn = th.querySelector(".scoring-head__toggle");
        if (btn) btn.setAttribute("aria-pressed", on ? "true" : "false");
      });
    },
  };

  window.renderRoundGrid = renderRoundGrid;
  window.renderRoundGridTotalsCell = renderTotalsCell;
  window.roundGridRoundCount = roundGridRoundCount;
  window.roundGridTotal = roundGridTotal;
  window.sanitizeRoundScore = sanitizeRoundScore;
  window.parseRoundScore = parseRoundScore;
  window.nextSignToggle = nextSignToggle;
  window.RoundGridSign = RoundGridSign;
  window.RoundGridNames = RoundGridNames;
})();
