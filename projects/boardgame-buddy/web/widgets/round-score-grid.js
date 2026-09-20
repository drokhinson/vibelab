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
//   minRounds       — editable grids only. How many rows this surface refuses
//                     to go below, default 0. The live play screen passes 1:
//                     its grid opens on Round 1 and always has one
//                     (play-flow-view#_ensureOpeningRound), so the last
//                     remaining round's remove button would be a control that
//                     undoes itself on the next repaint. The play-detail popup
//                     leaves it at 0 — emptying the grid there is how a play
//                     scored in rounds goes back to a single score per player.
//   showAddRound    — editable grids only. The "Round" button under the table,
//                     on by default. The live play screen passes false: its
//                     copy of the control is docked in the screen's CTA bar as
//                     "Next round" (play-flow-view#_renderPlayCta), beside the
//                     "Wrap up" it is the alternative to. The play-detail
//                     popup has no docked bar, so it keeps the one here.
//   playMode        — "competitive" | "team" | "coop". Co-op hides the
//                     per-player trophy button (the whole table wins or
//                     loses together).
//   getCellValue    — optional resolver `(player, roundIdx) → string`. Lets
//                     play-flow-view overlay live realtime scores when a
//                     player has a real user_id. Defaults to reading from
//                     player.roundScores.
//   rowLabels       — optional [{label, color, note, source_color}], index-aligned to round
//                     index. Row r takes rowLabels[r].label when one is present
//                     and `R${r+1}` when it isn't, so a scoring template's rows
//                     and the extras a scorer appends under them are ONE list of
//                     rows, not two kinds of row. A labelled row also loses its
//                     remove button: the template is the SHAPE of this play's
//                     score sheet, and a shape the scorer can delete rows out of
//                     is not a shape. `color` is a palette SLUG resolved by the
//                     stylesheet, never a hex — see .claude/rules/theming.md §10
//                     and the .scoring-round-th--tpl block in styles.css.
//                     `note` is the template author's optional explanation of
//                     HOW the row is scored. It is never printed in the header
//                     — the label column is 7.5rem wide on a phone and already
//                     ellipsises — but a row that has one grows an info button
//                     beside its label that opens the text (RoundGridNotes).
//                     That button is the ONLY surface the note has: the
//                     template's own listing never shows it, which is what
//                     makes an explanation safe to write at length.
//   headerNames     — DEFAULT for the column headers: true starts them on the
//                     player's name, false on the colored bubble. The live
//                     play screens (host + joiner mirror) pass true because
//                     names are what you scan mid-game; the play-detail popup
//                     leaves it off. It is only a default — a user who has
//                     tapped a header once carries a stored preference
//                     (RoundGridNames) that wins on every surface, and one tap
//                     flips EVERY column, not just the one tapped.
//
// Two invariants `rowLabels` deliberately does NOT touch, both of which are the
// same bug in different clothes — the model and the paint disagreeing about how
// many rows exist:
//
//   * roundGridRoundCount does not floor on rowLabels.length. The HOST
//     materializes a template's rows into every player's roundScores when it
//     applies one, so the model stays authoritative and _maxRoundCount /
//     _addRound / _removeRoundAt keep agreeing with what is on screen. A grid
//     that invented rows its host had never heard of would put those three back
//     into the disagreement the comments at play-flow-view.js:2401 and :1755 are
//     a museum of. If a play ever arrives with more labels than round_scores the
//     surplus labels simply don't render.
//   * Extras keep ABSOLUTE numbering — R9, R10 under an 8-row template, not
//     "Extra 1". The number a row shows is its round_index, which is the key the
//     live-scores overlay and the spectator's mirror are both stored under; a
//     second numbering scheme would be a second truth.
//
// THE GRID IS THREE TABLES, not one, and that is load-bearing rather than
// incidental. The column headers pin against the PAGE scroll (there is no
// inner vertical scroller any more), which they can only do from outside the
// horizontal scroller — an `overflow-x: auto` box is a scroll container on
// both axes, so a <thead> inside it pins to a scrollport that never scrolls
// down. Splitting the Total row out again is what bounds the pin: .rg__head's
// containing block is .rg__pinzone, which ends at the last round row, so the
// header is handed back exactly there and can never cover the Total row. The
// three tables are held in column by ONE colgroup (renderColGroup) plus
// `table-layout: fixed` — never by measuring one and applying it to another —
// and in horizontal position by RoundGridScroll.sync. See the block comment
// above `.rg` in styles.css for the full argument.
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
    const showAddRound = editable && o.showAddRound !== false;
    const minRounds = Math.max(0, Number(o.minRounds) || 0);
    // opts.headerNames is this surface's DEFAULT; a stored user choice wins.
    const headerNamesDefault = !!o.headerNames;
    const headerNames = RoundGridNames.enabled(headerNamesDefault);
    const getCell = o.getCellValue || defaultCellValue;
    const rowLabels = Array.isArray(o.rowLabels) ? o.rowLabels : [];
    const safePlayers = Array.isArray(players) ? players : [];
    // Spectators size their grid from the live-scores round count, not from
    // each player's local roundScores array (which they don't have).
    const roundCount = roundGridRoundCount(safePlayers, o.roundCount);
    // One total implementation, fed the same resolver and the same round
    // range the rows below were built from.
    const getTotal = (p) => roundGridTotal(p, roundCount, getCell);

    // The body keeps its column across the host's re-renders, and drops to the
    // new last round when this render added one. See RoundGridScroll.
    RoundGridScroll.schedule(host, roundCount);

    // tag → colour slot, or null when no seat carries a side — which covers a
    // competitive play, a co-op play, and a team play whose sides were never
    // named. Built once and read by every header below, so the grid and the
    // banded player list above it cannot land on different colours.
    const teams = window.BgbTeams ? window.BgbTeams.indexMap(safePlayers) : null;
    const slotOf = (p) => (teams && teams.get(window.BgbTeams.keyOf(p && p.team))) || 0;

    const cols = renderColGroup(safePlayers.length);

    return `
      <div class="rg" data-round-grid="${escapeAttr(host)}" style="--rg-cols: ${safePlayers.length}">
        <div class="rg__pinzone">
          <div class="rg__head" data-rg-sync>
            <table class="scoring-table scoring-table--head">
              ${cols}
              <thead>
                <tr>
                  <th class="scoring-head-corner"></th>
                  ${safePlayers.map((p) => {
                    // A custom property set inline from data — the one
                    // legitimate inline-colour case (theming.md §10), and the
                    // same shape the row-label cells use for --row-accent.
                    const slot = slotOf(p);
                    return `
                    <th class="scoring-head${headerNames ? " is-named" : ""}${slot ? " is-team" : ""}" scope="col"
                        ${slot ? `style="--team-tint: var(--team-${slot})"` : ""}
                        title="${escapeAttr(shownName(p))}">${renderScoringHead(renderHeadBadge(p), shownName(p), headerNames, headerNamesDefault)}</th>
                  `;}).join("")}
                </tr>
              </thead>
            </table>
          </div>
          <div class="rg__body" data-rg-scroller
               onscroll="window.RoundGridScroll.sync('${host}', this)">
            <table class="scoring-table scoring-table--body">
              ${cols}
              <tbody>
            ${Array.from({ length: roundCount }).map((_, r) => {
              const tpl = rowLabels[r] || null;
              // A row contributed by an ADD-ON expansion carries that
              // expansion's colour (domain/scoring-template.js), which draws a
              // rule down the RIGHT edge of the header cell. The left edge is
              // already the row's own palette tint, so the two facts — what the
              // row IS and which box it CAME FROM — get opposite edges rather
              // than fighting over one. Set as a custom property, never as a
              // literal, the one legitimate inline-colour case in
              // .claude/rules/theming.md §10.
              const src = (tpl && tpl.source_color) || null;
              // The three tables no longer share a <thead>, so a cell can no
              // longer be associated with its column by structure. Every cell
              // says what it is instead — which these inputs never did at all
              // before, so it is a gain rather than a patch for the split.
              const rowName = tpl ? tpl.label : `Round ${r + 1}`;
              return `
              <tr>
                <th scope="row" class="scoring-round-th${tpl ? " scoring-round-th--tpl" : ""}${src ? " scoring-round-th--exp" : ""}"
                    ${src ? `style="--exp-accent: ${escapeAttr(src)}"` : ""}
                    ${tpl ? `data-row-color="${escapeAttr(tpl.color || "neutral")}"` : ""}
                    ${tpl ? `title="${escapeAttr(tpl.label)}"` : ""}>
                  <span class="scoring-round-label">
                    ${editable && !tpl && roundCount > minRounds ? `
                      <button class="scoring-round-remove" title="Remove round"
                              onclick="window.${host}._removeRoundAt(${r})">
                        <i data-icon="x" class="w-3 h-3"></i>
                      </button>
                    ` : ""}
                    ${renderRowLabel(tpl, r)}
                  </span>
                </th>
                ${safePlayers.map((p, i) => `
                  <td>
                    ${editable
                      ? renderEditableCell(getCell(p, r), i, r, host, `${shownName(p)} — ${rowName}`)
                      : `<span class="scoring-cell--read" data-score-cell="${i}-${r}" aria-label="${escapeAttr(`${shownName(p)} — ${rowName}`)}">${escapeHtml(getCell(p, r))}</span>`}
                  </td>
                `).join("")}
              </tr>`;
            }).join("")}
              </tbody>
            </table>
          </div>
        </div>
        <div class="rg__foot" data-rg-sync>
          <table class="scoring-table scoring-table--foot">
            ${cols}
            <tbody>
              <tr class="scoring-total-row">
                <th scope="row">Total</th>
                ${safePlayers.map((p, i) => renderTotalsCell(p, i, mode, getTotal(p), host, editable)).join("")}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      ${showAddRound ? `
        <div class="scoring-actions">
          <button class="btn btn-ghost btn-xs scoring-add-round" onclick="window.${host}._addRound()">
            <i data-icon="plus" class="w-3.5 h-3.5"></i> Round
          </button>
        </div>
      ` : ""}
    `;
  }

  // The column contract, and the whole of it. Three tables have to agree on
  // their columns to the pixel; they do it by sharing this markup and
  // `table-layout: fixed` rather than by anyone measuring anyone else. Widths
  // come from --rg-label-w / --rg-col-min on .rg (styles.css), so a repaint
  // cannot land them out of step and there is no resize pass to forget.
  function renderColGroup(n) {
    let cols = `<col class="rg-col--label" />`;
    for (let i = 0; i < n; i++) cols += `<col class="rg-col--player" />`;
    return `<colgroup>${cols}</colgroup>`;
  }

  // The row's own label, and — on a template row whose author wrote a
  // description — the info affordance that opens it. Absent otherwise, so the
  // common grid is exactly the markup it always was.
  //
  // THE WHOLE LABEL IS THE BUTTON, rather than a separate icon beside it. A
  // grid row is about 36px tall, so a control inside one cannot carry a 44px
  // target without eating into the rows above and below it (the remove × next
  // to it has the same problem and simply lives with a 17px one). The label
  // cell is ~120px wide, so making the cell the target buys back everything
  // width can give and leaves the height bounded by the row, which is the only
  // dimension actually constrained. The `i` is then a marker, not a target.
  //
  // The text travels on data- attributes and the handler reads it back off the
  // element rather than being interpolated into the onclick string: a row
  // description is 200 characters of the author's prose, and prose in a JS
  // string literal inside an HTML attribute has to survive two levels of
  // quoting at once. An attribute survives one, which escapeAttr already does.
  function renderRowLabel(tpl, r) {
    const text = `<span class="scoring-round-text">${tpl ? escapeHtml(tpl.label) : `R${r + 1}`}</span>`;
    const note = tpl && tpl.note ? String(tpl.note) : "";
    if (!note) return text;
    return `<button type="button" class="scoring-round-note"
              aria-label="${escapeAttr(tpl.label)} — how to score this row"
              title="${escapeAttr(note)}"
              data-note-label="${escapeAttr(tpl.label || "")}"
              data-note-body="${escapeAttr(note)}"
              onclick="window.RoundGridNotes.show(this)">
              ${text}
              <i data-icon="info" class="w-3 h-3"></i>
            </button>`;
  }

  // One editable cell.
  //
  // `type="number"` WITH NO `inputmode` AND NO `pattern`, and both omissions
  // are the point. A score can be negative, and on iOS the minus key exists on
  // exactly one software keyboard: the numbers-and-punctuation plane, which is
  // what Safari raises for a bare `type="number"`. `inputmode="numeric"` (or
  // `pattern="[0-9]*"`) is the documented way to ask for the 10-key pad
  // INSTEAD — digits and nothing else, no sign — and either one overrides the
  // type. This cell used to carry both, which is why it needed a per-cell +/−
  // button and a preference to turn that button on; the keyboard carries the
  // sign now, so the button and the preference are gone.
  //
  // The cost of `type=number` is that the element sanitizes its own value: a
  // half-typed "-" reads back as "" (with `validity.badInput` set) rather than
  // as "-", and so does "+5" or "3e4". Three places cover that, and all three
  // are load-bearing:
  //
  //   * Neither editable host re-renders the cell it is being typed into —
  //     play-flow-view patches only the totals row, and the popup morphs
  //     (ui/dom-patch.js), whose syncValue no-ops when the live value and the
  //     rendered one agree, which "" and "" do. So the "-" on screen survives
  //     until a digit follows it and the value becomes real.
  //   * `onblur` clears text the element is refusing to parse, so a cell can
  //     never sit there reading "+5" while its column totals it as nothing.
  //   * `onwheel` blurs rather than letting a scroll over a focused cell
  //     spin its value — the grid body is a horizontal scroller inside a
  //     vertical page, so a wheel gesture over a cell is a scroll, never an
  //     edit.
  function renderEditableCell(rawValue, i, r, host, label) {
    const val = rawValue == null ? "" : String(rawValue);
    const neg = val.charAt(0) === "-";
    return `<div class="scoring-cell-wrap${neg ? " is-neg" : ""}">
      <input type="number" step="1"
             id="rg-${host}-${i}-${r}" data-score-cell="${i}-${r}"
             class="scoring-cell"
             aria-label="${escapeAttr(label || "Score")}"
             value="${escapeAttr(val)}"
             onwheel="window.roundGridCellWheel(this)"
             onblur="window.roundGridCellBlur(this)"
             oninput="window.${host}._setRoundScore(${i}, ${r}, this.value)" />
    </div>`;
  }

  // The two `type=number` guards the comment above describes. Globals rather
  // than host methods on purpose: they are about the ELEMENT, identical on
  // every surface, and adding them to the host contract would mean six
  // consumers implementing the same two lines.
  function roundGridCellBlur(el) {
    if (el && el.validity && el.validity.badInput) el.value = "";
  }
  function roundGridCellWheel(el) {
    if (el && el.ownerDocument && el.ownerDocument.activeElement === el) el.blur();
  }

  // Exported as window.renderRoundGridTotalsCell for hosts that repaint the
  // totals row in place between full renders — same markup, same classes, so a
  // patched row can't drift from a freshly rendered one.
  function renderTotalsCell(p, i, mode, total, host, showWinner) {
    // Co-op: the whole table wins or loses together, no per-player trophy.
    const negClass = Number(total) < 0 ? " is-neg" : "";
    const tdClass = p.is_winner ? "scoring-total-cell--winner" : "";
    // Labelled for the same reason the score cells are: the Total row is its
    // own table now, so "which column is this" is no longer answerable from
    // the markup around it.
    const totalLabel = escapeAttr(`${shownName(p)} total`);
    if (mode === "coop") {
      return `<td class="${tdClass}">
        <div class="scoring-total-cell">
          <span class="scoring-total${negClass}" aria-label="${totalLabel}">${escapeHtml(total)}</span>
        </div>
      </td>`;
    }
    return `<td class="${tdClass}">
      <div class="scoring-total-cell">
        ${showWinner
          ? `<button class="scoring-winner-btn ${p.is_winner ? "is-winner" : ""}"
                     title="${p.is_winner ? "Winner" : "Mark as winner"}"
                     aria-label="${escapeAttr(shownName(p))} — ${p.is_winner ? "winner" : "mark as winner"}"
                     onclick="window.${host}._toggleWinner(${i})">
              <i data-icon="${p.is_winner ? "trophy" : "circle"}" class="w-4 h-4"></i>
            </button>`
          : (p.is_winner ? `<i data-icon="trophy" class="w-4 h-4"></i>` : "")}
        <span class="scoring-total${negClass}" aria-label="${totalLabel}">${escapeHtml(total)}</span>
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

  // Did anyone actually type into this player's row? Blank cells sum to 0 in
  // roundGridTotal, which is right for the number UNDER the column — an
  // untouched grid reads 0 — and wrong for what gets SAVED: a play stored with
  // every seat on 0 is indistinguishable from a table that genuinely all
  // scored nothing, so it counts as a recorded loss in the feed caption and in
  // the win rate. Every persistence boundary asks this first and stores NULL
  // when it comes back false. Same resolver contract as roundGridTotal.
  function roundGridHasAnyScore(player, roundCount, getCell) {
    const resolve = typeof getCell === "function" ? getCell : defaultCellValue;
    const n = Math.max(0, Number(roundCount) || 0);
    for (let r = 0; r < n; r++) {
      if (parseRoundScore(resolve(player, r)) != null) return true;
    }
    return false;
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
      displayName: shownName(p),
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
  // would reset `.rg__body`'s scrollLeft — on a 5-6 player grid the
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

  // What a column READS AS: the viewer's private alias when they set one,
  // otherwise the name the seat carries. Resolved HERE rather than in each of
  // the six hosts, because a host that forgot it produced a grid whose headers
  // disagreed with the scoreboard printed directly above them — which is
  // exactly what the play-detail popup did.
  //
  // Safe in every host including the editable ones: the grid writes SCORES.
  // A name only ever reaches the DOM through this function, never a value, so
  // the paint-only contract in domain/buddy.js holds. Guarded because the
  // tools/check-*.mjs harnesses load this file into a bare VM context.
  function shownName(p) {
    return window.Buddy ? window.Buddy.nameFor(p.user_id, p.name) : p.name;
  }

  function initialsFor(p) {
    if (p.initials) return p.initials;
    const parts = String(shownName(p) || "").trim().split(/[\s.]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || "?").slice(0, 2).toUpperCase();
  }

  // ── Score value helpers (shared by every grid host) ──────────────────────
  // Cells are stored as STRINGS ("", "-5", "12") so a leading minus survives
  // the round trip through the draft. A lone "-" is still handled: the number
  // input can no longer produce one, but drafts persisted before it was a
  // number input can, and parseRoundScore has to read those back as empty
  // rather than as NaN. These helpers convert to a clean string for storage /
  // display and to a number|null for math.

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

  // ── Horizontal continuity, and the new round ───────────────────────
  // Two jobs, both of them consequences of the grid being three tables and one
  // page scroll rather than one table in a bounded pane.
  //
  // 1. KEEPING THE THREE REGIONS IN COLUMN. .rg__body is the only real
  //    scroller; .rg__head and .rg__foot are `overflow: hidden` boxes whose
  //    scrollLeft is settable, so they are driven from the body rather than
  //    transformed — a transform would carry their sticky-left round-label
  //    cell along with everything else, which is the one cell that must not
  //    move. Nothing here measures anything: the columns themselves are held
  //    in step by the shared colgroup (renderColGroup) and `table-layout:
  //    fixed`, and this only mirrors the offset.
  //
  // 2. SURVIVING THE HOSTS' REPAINTS. Every host replaces the whole scoring
  //    card on _addRound / _removeRoundAt / _toggleWinner, and the spectator
  //    mirror repaints on every realtime score echo. Each one resets the
  //    body's scrollLeft — on a 5-6 player grid that snaps the table back to
  //    column 1, sometimes while the host is simply typing (the same wart the
  //    note on renderScoringHead describes). So the offset is remembered per
  //    host and reapplied on the next render.
  //
  //    The scrollTop half of this is gone with the pane: the page holds its own
  //    position across an innerHTML swap. What the page cannot do by itself is
  //    the "Add round" case — the new row lands below the fold and the button
  //    reads as doing nothing — so when the round count grew we scroll the new
  //    last row into view. `block: "nearest"` so a grid already on screen does
  //    not jump, and the row's own scroll-margin (styles.css) is what keeps it
  //    clear of the band pinned above it and the docked CTA below it.
  //
  // The restore runs in a rAF because the renderer hands back a STRING: the
  // host injects it synchronously in the same task, so the next frame is the
  // first moment the regions exist. If a host ever injects late the restore
  // simply finds nothing and the grid starts at column 1, exactly as before.
  const _paneScroll = Object.create(null);
  const RoundGridScroll = {
    /**
     * Mirror the body's column offset onto the two hidden regions, and
     * remember it for the next repaint. Wired to .rg__body's inline onscroll.
     * @param {string} host @param {HTMLElement} el
     */
    sync(host, el) {
      if (!el) return;
      const prev = _paneScroll[host];
      _paneScroll[host] = { left: el.scrollLeft, rounds: prev ? prev.rounds : 0 };
      const rg = el.closest(".rg");
      if (!rg) return;
      const mirrors = rg.querySelectorAll("[data-rg-sync]");
      for (let i = 0; i < mirrors.length; i++) mirrors[i].scrollLeft = el.scrollLeft;
    },
    /** @param {string} host @param {number} roundCount */
    schedule(host, roundCount) {
      const prev = _paneScroll[host];
      const grew = !!prev && roundCount > prev.rounds;
      _paneScroll[host] = { left: prev ? prev.left : 0, rounds: roundCount };
      if (typeof requestAnimationFrame !== "function") return;
      requestAnimationFrame(() => {
        const rg = document.querySelector(`.rg[data-round-grid="${host}"]`);
        if (!rg) return;
        const el = rg.querySelector("[data-rg-scroller]");
        if (!el) return;
        el.scrollLeft = (_paneScroll[host] || { left: 0 }).left;
        this.sync(host, el);
        if (!grew) return;
        const rows = rg.querySelectorAll(".scoring-table--body tbody tr");
        const last = rows[rows.length - 1];
        if (last && typeof last.scrollIntoView === "function") {
          last.scrollIntoView({ block: "nearest" });
        }
      });
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

  // Opening one row's description. The project's one-button information modal
  // rather than a popover: the label cell lives inside .rg__body, which is a
  // horizontal scrollport with `overflow-x: auto`, so anything positioned
  // against that cell would be clipped by the region it is anchored in — the
  // same geometry argument .claude/rules/overlays.md §1 makes for sheets over
  // dropdowns. A modal has no anchor to be clipped by, and PolaroidPopup.alert
  // already handles the backdrop tap, the device back press and the focus.
  const RoundGridNotes = {
    /** @param {Element} el the info button that was tapped */
    show(el) {
      if (!el) return;
      const body = el.getAttribute("data-note-body") || "";
      if (!body) return;
      const label = el.getAttribute("data-note-label") || "Scoring row";
      if (window.PolaroidPopup && window.PolaroidPopup.alert) {
        window.PolaroidPopup.alert({ title: label, body, label: "Got it" });
      } else if (typeof showToast === "function") {
        // The popup module is loaded on every screen that renders a grid, so
        // this is the "it somehow wasn't" branch: the text still has to reach
        // the reader, because the button promised it would.
        showToast(body, "info");
      }
    },
  };

  window.renderRoundGrid = renderRoundGrid;
  window.renderRoundGridTotalsCell = renderTotalsCell;
  window.roundGridRoundCount = roundGridRoundCount;
  window.roundGridTotal = roundGridTotal;
  window.roundGridHasAnyScore = roundGridHasAnyScore;
  window.sanitizeRoundScore = sanitizeRoundScore;
  window.roundGridCellBlur = roundGridCellBlur;
  window.roundGridCellWheel = roundGridCellWheel;
  window.parseRoundScore = parseRoundScore;
  window.RoundGridScroll = RoundGridScroll;
  window.RoundGridNames = RoundGridNames;
  window.RoundGridNotes = RoundGridNotes;
})();
