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
    const showSign = !!o.showSign;
    const getCell = o.getCellValue || defaultCellValue;
    const getTotal = o.getPlayerTotal || defaultPlayerTotal;
    const safePlayers = Array.isArray(players) ? players : [];
    // Viewer mode (joiner's read-only mirror): exactly one column — the
    // current user's — stays editable, every other column renders greyed-out
    // read-only cells and the host-only controls (add/remove round, winner
    // trophy) are hidden. The host grid leaves editableColumnId unset and
    // keeps its all-editable behavior.
    const viewerMode = !!o.editableColumnId;
    const showControls = editable && !viewerMode;
    const colEditable = (p) =>
      viewerMode ? !!(p.user_id && p.user_id === o.editableColumnId) : editable;
    const colRead = (p) => viewerMode && !colEditable(p);
    // Joiner sizes its grid from the live-scores round count, not from each
    // player's local roundScores array (which it doesn't have).
    const roundCount =
      o.roundCount != null
        ? o.roundCount
        : Math.max(0, ...safePlayers.map((p) => (p.roundScores || []).length));

    return `
      <div class="scoring-table-wrap">
        <table class="scoring-table">
          <thead>
            <tr>
              <th></th>
              ${safePlayers.map((p) => `
                <th class="scoring-head${colRead(p) ? " scoring-col--read" : ""}" title="${escapeAttr(p.name)}">${renderScoringHead(renderHeadBadge(p), p.name)}</th>
              `).join("")}
            </tr>
          </thead>
          <tbody>
            ${Array.from({ length: roundCount }).map((_, r) => `
              <tr>
                <th class="scoring-round-th">
                  <span class="scoring-round-label">
                    ${showControls ? `
                      <button class="scoring-round-remove" title="Remove round"
                              onclick="window.${host}._removeRoundAt(${r})">
                        <i data-lucide="x" class="w-3 h-3"></i>
                      </button>
                    ` : ""}
                    R${r + 1}
                  </span>
                </th>
                ${safePlayers.map((p, i) => `
                  <td class="${colRead(p) ? "scoring-col--read" : ""}">
                    ${colEditable(p)
                      ? renderEditableCell(getCell(p, r), i, r, host, showSign)
                      : `<span class="scoring-cell scoring-cell--read" data-score-cell="${i}-${r}">${escape(getCell(p, r))}</span>`}
                  </td>
                `).join("")}
              </tr>
            `).join("")}
            <tr class="scoring-total-row">
              <th>Total</th>
              ${safePlayers.map((p, i) => renderTotalsCell(p, i, mode, getTotal(p), host, showControls, colRead(p) ? "scoring-col--read" : "")).join("")}
            </tr>
          </tbody>
        </table>
      </div>
      ${showControls ? `
        <div class="flex gap-2 mt-1">
          <button class="btn btn-ghost btn-xs" onclick="window.${host}._addRound()">
            <i data-lucide="plus" class="w-3.5 h-3.5"></i> Round
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

  function renderTotalsCell(p, i, mode, total, host, showWinner, readClass) {
    // Co-op: the whole table wins or loses together, no per-player trophy.
    const negClass = Number(total) < 0 ? " is-neg" : "";
    const tdClass = [p.is_winner ? "scoring-total-cell--winner" : "", readClass || ""]
      .filter(Boolean)
      .join(" ");
    if (mode === "coop") {
      return `<td class="${tdClass}">
        <div class="scoring-total-cell">
          <span class="scoring-total${negClass}">${escape(total)}</span>
        </div>
      </td>`;
    }
    return `<td class="${tdClass}">
      <div class="scoring-total-cell">
        ${showWinner
          ? `<button class="scoring-winner-btn ${p.is_winner ? "is-winner" : ""}"
                     title="${p.is_winner ? "Winner" : "Mark as winner"}"
                     onclick="window.${host}._toggleWinner(${i})">
              <i data-lucide="${p.is_winner ? "trophy" : "circle"}" class="w-4 h-4"></i>
            </button>`
          : (p.is_winner ? `<i data-lucide="trophy" class="w-4 h-4"></i>` : "")}
        <span class="scoring-total${negClass}">${escape(total)}</span>
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

  // Wraps a column-header badge in a button that toggles the header cell
  // between the colored bubble and the player's display name. Pure DOM toggle
  // (no re-render, no host method) so it works identically in the host grid,
  // the joiner grid, and the play-detail popup. Shared via window export.
  function renderScoringHead(badgeHtml, name) {
    return `<button type="button" class="scoring-head__toggle" title="${escapeAttr(name)}"
              onclick="this.closest('.scoring-head').classList.toggle('is-named')">
              <span class="scoring-head__bubble">${badgeHtml}</span>
              <span class="scoring-head__name">${escape(name)}</span>
            </button>`;
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

  window.renderRoundGrid = renderRoundGrid;
  window.renderScoringHead = renderScoringHead;
  window.sanitizeRoundScore = sanitizeRoundScore;
  window.parseRoundScore = parseRoundScore;
  window.nextSignToggle = nextSignToggle;
  window.RoundGridSign = RoundGridSign;
})();
