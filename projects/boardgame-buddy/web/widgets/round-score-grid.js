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
// Opts:
//   editable        — when false, cells render as static spans, "Add round"
//                     and remove buttons are hidden. Used by the popup's
//                     read-only view mode.
//   playMode        — "competitive" | "team" | "coop". Co-op hides the
//                     per-player trophy button (the whole table wins or
//                     loses together).
//   getCellValue    — optional resolver `(player, roundIdx) → string`. Lets
//                     play-flow-view overlay live realtime scores when a
//                     player has a real user_id. Defaults to reading from
//                     player.roundScores.
//   getPlayerTotal  — optional `(player) → number`. Same idea — play-flow
//                     overlays live totals from realtime.

(function () {
  function renderRoundGrid(players, host, opts) {
    const o = opts || {};
    const editable = o.editable !== false;
    const mode = o.playMode || "competitive";
    const getCell = o.getCellValue || defaultCellValue;
    const getTotal = o.getPlayerTotal || defaultPlayerTotal;
    const safePlayers = Array.isArray(players) ? players : [];
    const roundCount = Math.max(0, ...safePlayers.map((p) => (p.roundScores || []).length));

    return `
      <div class="scoring-table-wrap">
        <table class="scoring-table">
          <thead>
            <tr>
              <th></th>
              ${safePlayers.map((p) => `
                <th class="scoring-head" title="${escapeAttr(p.name)}">${renderHeadBadge(p)}</th>
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
                        <i data-lucide="x" class="w-3 h-3"></i>
                      </button>
                    ` : ""}
                    R${r + 1}
                  </span>
                </th>
                ${safePlayers.map((p, i) => `
                  <td>
                    ${editable
                      ? `<input type="number" inputmode="numeric"
                                class="scoring-cell"
                                value="${escapeAttr(getCell(p, r))}"
                                oninput="window.${host}._setRoundScore(${i}, ${r}, this.value)" />`
                      : `<span class="scoring-cell scoring-cell--read">${escape(getCell(p, r))}</span>`}
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
        <div class="flex gap-2 mt-1">
          <button class="btn btn-ghost btn-xs" onclick="window.${host}._addRound()">
            <i data-lucide="plus" class="w-3.5 h-3.5"></i> Round
          </button>
        </div>
      ` : ""}
    `;
  }

  function renderTotalsCell(p, i, mode, total, host, editable) {
    // Co-op: the whole table wins or loses together, no per-player trophy.
    if (mode === "coop") {
      return `<td class="${p.is_winner ? "scoring-total-cell--winner" : ""}">
        <div class="scoring-total-cell">
          <span class="scoring-total">${escape(total)}</span>
        </div>
      </td>`;
    }
    return `<td class="${p.is_winner ? "scoring-total-cell--winner" : ""}">
      <div class="scoring-total-cell">
        ${editable
          ? `<button class="scoring-winner-btn ${p.is_winner ? "is-winner" : ""}"
                     title="${p.is_winner ? "Winner" : "Mark as winner"}"
                     onclick="window.${host}._toggleWinner(${i})">
              <i data-lucide="${p.is_winner ? "trophy" : "circle"}" class="w-4 h-4"></i>
            </button>`
          : (p.is_winner ? `<i data-lucide="trophy" class="w-4 h-4"></i>` : "")}
        <span class="scoring-total">${escape(total)}</span>
      </div>
    </td>`;
  }

  function defaultCellValue(player, r) {
    const v = player.roundScores && player.roundScores[r];
    return v == null || v === "" ? "" : String(v);
  }

  function defaultPlayerTotal(player) {
    return (player.roundScores || []).reduce((a, b) => a + (Number(b) || 0), 0);
  }

  // Column-header badge. Renders the player's colored bubble but FORCES
  // initials inside (even when the user picked an icon avatar) so the
  // narrow header column stays scannable while still being color-coded
  // by the player's own palette.
  function renderHeadBadge(p) {
    if (!window.BgbBadge || typeof window.BgbBadge.render !== "function") {
      // Fallback if user-badge.js failed to load — show the raw initials.
      return escape(initialsFor(p));
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

  function initialsFor(p) {
    if (p.initials) return p.initials;
    const parts = String(p.name || "").trim().split(/[\s.]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || "?").slice(0, 2).toUpperCase();
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }

  window.renderRoundGrid = renderRoundGrid;
})();
