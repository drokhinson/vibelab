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
// `playerIdx` IS A COLUMN'S FIRST SEAT, not necessarily its only one. In a
// team play the seats on one side share a single cell (see roundGridColumns),
// so an editable host has to ask window.roundGridSeatsFor() — with the same
// arguments it passed to render — which seats the cell it was handed covers,
// and write the value to every one of them. A host that writes only the index
// it was given puts the side's score on one member and saves the rest as
// zeroes. The read-only hosts need none of this; the grid resolves the cell.
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
//                     loses together). "team" is what MERGES a side's seats
//                     into one column, one cell per round and one Total — see
//                     roundGridColumns, and note that a host which renders a
//                     team play without passing this gets the old per-seat
//                     grid rather than a wrong one.
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
//                     — the label column is a handful of characters wide on a
//                     phone and already ellipsises — but a row that has one
//                     grows an info button beside its label that opens the
//                     text (RoundGridNotes).
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
//                     A TEAM grid ignores it and opens on the badges whichever
//                     surface asked: a side's badges are the only thing on
//                     screen that says WHO IS ON IT, while the tag it would
//                     show instead is already the column's tint, its Total and
//                     its trophy.
//                     Tapping such a header shows "Red: Ana, Bo" — the tag and
//                     the roster, so the tap trades one fact for two rather
//                     than losing the badges' one. Team and solo grids keep
//                     SEPARATE stored preferences for the same reason; see
//                     RoundGridNames.
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
  // What separates two teammates in a merged column's header text. A comma
  // and a space, which is how every other list of PEOPLE in this app is
  // punctuated (a play card's winners, a plays-list row) — the middle dot is
  // this project's separator for unlike things (players · minutes · year) and
  // a side's members are alike by definition.
  const TEAM_NAME_DELIM = ", ";

  function renderRoundGrid(players, host, opts) {
    const o = opts || {};
    const editable = o.editable !== false;
    const mode = o.playMode || "competitive";
    const showAddRound = editable && o.showAddRound !== false;
    const minRounds = Math.max(0, Number(o.minRounds) || 0);
    const getCell = o.getCellValue || defaultCellValue;
    const rowLabels = Array.isArray(o.rowLabels) ? o.rowLabels : [];
    const safePlayers = Array.isArray(players) ? players : [];
    // Spectators size their grid from the live-scores round count, not from
    // each player's local roundScores array (which they don't have).
    const roundCount = roundGridRoundCount(safePlayers, o.roundCount);
    // The body keeps its column across the host's re-renders, and drops to the
    // new last round when this render added one. See RoundGridScroll.
    // `trackScroll: false` renders without touching that state at all (the
    // play-detail pager's neighbour copies); `scrollKey` says WHICH record the
    // grid shows, so a different play on the same surface is a new grid rather
    // than this one growing; `centreNewRound: false` for a read-only grid,
    // where nothing is ever added and a scroll is never the grid's to make.
    if (o.trackScroll !== false) {
      RoundGridScroll.schedule(host, roundCount, o.scrollKey, o.centreNewRound !== false);
    }

    // What this grid actually draws. One column per seat everywhere except a
    // team play, where a side is ONE column — see roundGridColumns.
    const columns = roundGridColumns(safePlayers, mode, roundCount, getCell);
    // WHICH GRID THIS IS, and therefore which default and which memory the
    // headers answer to. A grid holding at least one merged side is a TEAM
    // grid: it opens on the badges whatever this surface asked for, because
    // the badges are the only thing that says who is on which side — the tag
    // is already the column's tint, its trophy and its Total, so spending the
    // header on it too says nothing the column was not already saying. See
    // RoundGridNames for why the choice is remembered per shape rather than
    // once for the app.
    const scope = columns.some((c) => c.merged) ? "team" : "solo";
    // opts.headerNames is this surface's DEFAULT; a stored user choice wins.
    const headerNamesDefault = scope === "team" ? false : !!o.headerNames;
    const headerNames = RoundGridNames.enabled(headerNamesDefault, scope);
    // A column's cells and its Total, from the same resolver the rows use.
    const cellOf = (col, r) => roundGridColumnValue(col, r, getCell);
    const totalOf = (col) => roundGridColumnTotal(col, roundCount, getCell);

    const cols = renderColGroup(columns);
    // The label column is sized to what it actually holds, not to a fixed
    // block: the longest header it draws (roundGridLabelChars) plus room for
    // the remove × on the renders that draw one (roundGridHasRemove).
    const labelCh = roundGridLabelChars(rowLabels, roundCount);
    const removable = roundGridHasRemove(rowLabels, roundCount, editable, minRounds);

    return `
      <div class="rg${editable ? " rg--editable" : ""}${removable ? " rg--removable" : ""}" data-round-grid="${escapeAttr(host)}"
           data-rg-scope="${scope}"
           style="--rg-cols: ${columns.length}; --rg-label-ch: ${labelCh}">
        <div class="rg__pinzone">
          <div class="rg__head" data-rg-sync>
            <table class="scoring-table scoring-table--head">
              ${cols}
              <thead>
                <tr>
                  <th class="scoring-head-corner"></th>
                  ${columns.map((col) => {
                    // A custom property set inline from data — the one
                    // legitimate inline-colour case (theming.md §10), and the
                    // same shape the row-label cells use for --row-accent.
                    const slot = col.slot;
                    const label = columnLabel(col);
                    return `
                    <th class="scoring-head${headerNames ? " is-named" : ""}${slot ? " is-team" : ""}${col.merged ? " is-merged" : ""}" scope="col"
                        ${slot ? `style="--team-tint: var(--team-${slot})"` : ""}
                        title="${escapeAttr(label)}">${renderScoringHead(renderColumnBadges(col), columnLabelHtml(col), label, headerNames, headerNamesDefault, scope)}</th>
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
                ${columns.map((col) => {
                  // Keyed by the column's FIRST seat, which is what makes a
                  // merged cell addressable by every host that patches by
                  // index: `${col.head}-${r}` is a key those hosts already
                  // compute, and a seat that shares the cell simply has no
                  // key of its own (see _patchScoringCells in either host).
                  const label = `${columnName(col)} — ${rowName}`;
                  return `
                  <td${col.merged ? ` class="scoring-td--merged"` : ""}>
                    ${editable
                      ? renderEditableCell(cellOf(col, r), col.head, r, host, label)
                      : `<span class="scoring-cell--read" data-score-cell="${col.head}-${r}" aria-label="${escapeAttr(label)}">${escapeHtml(cellOf(col, r))}</span>`}
                  </td>
                `;}).join("")}
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
                ${columns.map((col) => renderTotalsCell(col, mode, totalOf(col), host, editable)).join("")}
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

  // ── Columns ─────────────────────────────────────────────────────────────
  //
  // What the grid draws, as opposed to who is in the play. Outside team mode
  // the two are the same thing — one column per seat, which is every grid this
  // widget has ever rendered — and the abstraction costs nothing there.
  //
  // In a TEAM play a side is ONE column. The seats that share a tag hold one
  // cell per round between them, the host types into it once, and the write
  // fans out so every seat on that side carries the number (see
  // PlaySession.teamSeats and the _setRoundScore in either editable host). A
  // side scores as a unit, so a row of identical numbers under identical
  // headers was the table saying the same thing four times — and on a phone it
  // was saying it in four columns that a 3v3 game could not fit.
  //
  // The saved rows do not change shape: each seat still stores its own
  // round_scores and its own score, and they are equal by construction. That
  // is what keeps every reader that never heard of this — the feed card, the
  // stats RPCs, an export — reading a team play exactly as it did.
  //
  // A SIDE OF ONE IS NOT A MERGE. It keeps its own column and its own tint,
  // because there is nothing to merge it with; the grid has never drawn a
  // colspan around a single seat and this must not start.
  //
  // ── WHEN A SIDE STAYS SPLIT ─────────────────────────────────────────────
  //
  // A merged cell shows ONE number, so it may only exist where the seats it
  // covers do not hold two different ones. Formally: a side merges when no
  // round holds two different non-empty values among its seats. Three things
  // fall out of that wording, and all three are the reason for it:
  //
  //   * A play scored SEAT BY SEAT stays split. Team mode has existed since
  //     migration 007 and per-seat round scores since 028, so plays where a
  //     side's members each carry their own number are real and already saved.
  //     Merging those would pick one member's number and print it over
  //     everybody's — the detail popup would misreport a play it is the record
  //     of. They render as they always did instead.
  //   * A seat that is merely EMPTY where its teammate has a number does not
  //     split the side. That is not a disagreement, it is a write in flight:
  //     the host's fan-out is local and synchronous, but a SPECTATOR receives
  //     one Realtime row per seat, so for a few milliseconds a side genuinely
  //     holds one number and two blanks. Counting that as a disagreement would
  //     re-shape the mirror's grid mid-keystroke.
  //   * A side whose seats happen to agree merges even if it was scored
  //     seat by seat. Nothing is misreported — every number on screen is a
  //     number in the data — so there is no reason to spend a column on it.
  //
  // @param {any[]} players @param {string} mode @param {number} roundCount
  // @param {Function} [getCell]
  // @returns {{merged: boolean, players: any[], indexes: number[], head: number,
  //            slot: number, key: string|null, label: string}[]}
  function roundGridColumns(players, mode, roundCount, getCell) {
    const safe = Array.isArray(players) ? players : [];
    const resolve = typeof getCell === "function" ? getCell : defaultCellValue;
    const n = Math.max(0, Number(roundCount) || 0);
    const solo = (p, i, slot, key) => ({
      merged: false, players: [p], indexes: [i], head: i,
      slot: slot || 0, key: key || null, label: "",
    });
    // Same source of truth as the header tints and the play-detail popup's
    // banded roster: nothing here decides which side is which, or what colour
    // it is (ui/team-colors.js). Null covers a competitive play, a co-op play
    // and a team play whose sides were never named — all of which are one
    // column per seat, exactly as before.
    const teams = (mode === "team" && window.BgbTeams)
      ? window.BgbTeams.indexMap(safe)
      : null;
    if (!teams) return safe.map((p, i) => solo(p, i, 0, null));

    // Walk the roster ONCE, in order. A side takes the position of its first
    // seat, so a grid whose sides are seated together is in the order the host
    // arranged and a grid whose sides are interleaved pulls each side's later
    // seats up to its first. Either way both ends of a live session derive the
    // same order from the same array (migration 056), so the host's third
    // column is the spectator's third column.
    const draft = [];
    const byKey = new Map();
    safe.forEach((p, i) => {
      const key = window.BgbTeams.keyOf(p && p.team);
      const slot = key ? (teams.get(key) || 0) : 0;
      if (!key) { draft.push(solo(p, i, 0, null)); return; }
      let col = byKey.get(key);
      if (!col) {
        col = { merged: true, players: [], indexes: [], head: i,
                slot, key, label: String(p.team).trim() };
        byKey.set(key, col);
        draft.push(col);
      }
      col.players.push(p);
      col.indexes.push(i);
    });

    const out = [];
    for (const col of draft) {
      if (!col.merged) { out.push(col); continue; }
      if (col.players.length >= 2 && sideAgrees(col.players, n, resolve)) {
        out.push(col);
        continue;
      }
      // Split back into seats, each keeping the side's tint — a side that
      // cannot share a cell is still a side.
      col.indexes.forEach((i, k) => out.push(solo(col.players[k], i, col.slot, col.key)));
    }
    return out;
  }

  // Does this side hold at most one number in every round? See the third
  // bullet above for why an empty seat is not a disagreement, and why the
  // comparison is on the parsed NUMBER rather than the stored string ("05" and
  // "5" are one score typed two ways, not two scores).
  function sideAgrees(seats, roundCount, resolve) {
    for (let r = 0; r < roundCount; r++) {
      let seen = null;
      for (const p of seats) {
        const v = parseRoundScore(resolve(p, r));
        if (v == null) continue;
        if (seen == null) seen = v;
        else if (seen !== v) return false;
      }
    }
    return true;
  }

  // What a column SHOWS in one round: the first number any of its seats holds.
  // For a solo column that is simply the seat's own cell, so this is the one
  // resolver every surface reads a cell through. A merged column's seats agree
  // by construction (roundGridColumns only merges ones that do), so "first"
  // only ever chooses between a number and the blanks of a write still in
  // flight — which is exactly the choice that keeps a spectator's cell showing
  // the value the instant the first of its rows lands.
  function roundGridColumnValue(col, r, getCell) {
    const resolve = typeof getCell === "function" ? getCell : defaultCellValue;
    const seats = (col && col.players) || [];
    for (const p of seats) {
      const v = resolve(p, r);
      if (v != null && v !== "") return v;
    }
    return "";
  }

  // The one true column total: the sum of the cells the grid shows for this
  // column, which for a merged one is the SIDE's total and not the sum of its
  // seats. Hosts that patch the totals row in place must call this rather than
  // summing a player, or the number under a merged column stops meaning "the
  // cells above me, added up" — it would read N times too big on a side of N.
  function roundGridColumnTotal(col, roundCount, getCell) {
    const n = Math.max(0, Number(roundCount) || 0);
    let total = 0;
    for (let r = 0; r < n; r++) {
      total += parseRoundScore(roundGridColumnValue(col, r, getCell)) || 0;
    }
    return total;
  }

  // Which seats does the cell on seat `i` write to?
  //
  // The answer an editable host needs and must not compute for itself: a
  // merged cell is one input over several seats, so typing in it has to reach
  // every one of them or the play saves with the side's score on one member.
  // Asked of the SAME arguments the render was given, so the fan-out can never
  // cover a different set of seats than the cell on screen does.
  function roundGridSeatsFor(players, mode, roundCount, getCell, i) {
    const cols = roundGridColumns(players, mode, roundCount, getCell);
    const col = cols.find((c) => c.indexes.indexOf(i) !== -1);
    return col ? col.indexes.slice() : [i];
  }

  // What a column reads as in one breath: a side by its tag, a seat by its
  // name. This is the SHORT form — it labels the column's cells and its Total
  // for a screen reader, where "Red — Round 3" is the whole of what the
  // listener needs and the roster would be read out on every one of forty
  // cells.
  function columnName(col) {
    return col.merged ? col.label : shownName(col.players[0]);
  }

  // What a column reads as in its HEADER: a side by its tag AND the people on
  // it, "Red: Ana, Bo". The long form exists because the header is the one
  // place the two facts are asked for together — the badges beside it are who
  // is on the side, so the text state that replaces them has to answer the
  // same question or tapping loses information rather than trading it. The tag
  // alone is already on screen three other ways (the column's tint, its Total
  // and its trophy), so it was the half of the answer the grid could afford to
  // repeat and the names were the half it could not.
  //
  // Names through shownName, so a viewer's private alias reaches this header
  // exactly as it reaches the badge stack under it.
  //
  // This is the flat form — one string, for the `title` and the button's
  // accessible name, where a tooltip and a screen reader both want a sentence.
  // What is DRAWN is the stacked form below.
  function columnLabel(col) {
    if (!col.merged) return shownName(col.players[0]);
    const roster = col.players.map(shownName).filter(Boolean).join(TEAM_NAME_DELIM);
    return roster ? `${col.label}: ${roster}` : col.label;
  }

  // The same thing, drawn: the side's tag on its own line, underlined, with
  // the roster under it —
  //
  //     Red
  //     Ana, Bo
  //
  // rather than the one run-on line the colon made of it. A column header is
  // about 4.3rem wide, so "Red: Ana, Bo" wrapped wherever the box ran out and
  // the break landed mid-list as often as after the tag; stacking puts the
  // break where the meaning already is. The underline is what keeps the two
  // lines from reading as one list with a stray first item — it is the tag
  // doing the job a heading does, which is also what it is.
  //
  // A seat column is one name and stays one span: there is no second thing to
  // put under it, and the markup it has always emitted is what the nowrap
  // ellipsis rule is written against.
  function columnLabelHtml(col) {
    if (!col.merged) return escapeHtml(shownName(col.players[0]));
    const roster = col.players.map(shownName).filter(Boolean).join(TEAM_NAME_DELIM);
    if (!roster) return escapeHtml(col.label);
    return `<span class="scoring-head__team">${escapeHtml(col.label)}</span>`
         + `<span class="scoring-head__roster">${escapeHtml(roster)}</span>`;
  }

  // The header's bubble state, and a team grid's DEFAULT one. A merged column
  // stacks its side's badges — the column is those people, and the tag (which
  // the tint, the Total and the trophy already carry) does not say who is on
  // it.
  function renderColumnBadges(col) {
    const seats = col.players
      .map((p, k) => `<span class="scoring-head__seat" data-head-seat="${col.indexes[k]}">${renderHeadBadge(p)}</span>`)
      .join("");
    if (!col.merged) return seats;
    return `<span class="scoring-head__stack" data-seats="${col.players.length}">${seats}</span>`;
  }

  // The column contract, and the whole of it. Three tables have to agree on
  // their columns to the pixel; they do it by sharing this markup and
  // `table-layout: fixed` rather than by anyone measuring anyone else. Widths
  // come from --rg-label-w / --rg-col-min on .rg (styles.css), so a repaint
  // cannot land them out of step and there is no resize pass to forget.
  function renderColGroup(columns) {
    let cols = `<col class="rg-col--label" />`;
    for (const col of columns) {
      cols += `<col class="rg-col--player${col.merged ? " rg-col--team" : ""}" />`;
    }
    return `<colgroup>${cols}</colgroup>`;
  }

  // How wide the row-header column has to be, in characters: the longest
  // header this grid will draw, and nothing on top of it.
  //
  // NOT "plus two". The count is already generous per character and the cell
  // already has 0.4rem of padding either side, which is the breathing room;
  // two extra characters on top of both was a third of the column on the
  // R1..R9 grids this is for. The generosity is in the unit: `ch` is the width
  // of a ZERO in the table's font — 7.1px where the row label's average letter
  // is ~5.3px — so five characters of "Total" are budgeted about 20% wider
  // than "Total" actually measures, and a digit-heavy label like "R10", which
  // is the one case the estimate is tight on, is exactly what `ch` is measured
  // from.
  //
  // It used to be a flat 6.6rem, which is about eleven characters of room
  // spent on a column whose contents are "R1" through "R9" on most tables —
  // width taken off the score columns beside it, which are the ones a player
  // across the table is trying to read. A template's labels are the case the
  // 6.6rem was for, and they still get it: the cap in styles.css is exactly
  // the width this was, so a labelled grid is no narrower than before and a
  // plain one is much.
  //
  // "TOTAL" IS ONE OF THE HEADERS. It sits in the same column, drawn by the
  // foot table off the same colgroup, so a count taken over the round rows
  // alone would size a column the word Total then has to wrap inside — which
  // would make the totals band two lines tall on exactly the R1..R9 grids this
  // exists to make narrower.
  //
  // Characters rather than pixels, because nothing in this widget measures the
  // DOM and this is not the place to start (see the colgroup note above). The
  // count is handed to CSS as --rg-label-ch and turned into a width where it is
  // used, which is inside the table — so it follows the table's own font,
  // including the offer preview's 0.68rem, with no second rule to keep in
  // step.
  //
  // The controls that share the cell with the label are NOT in the count: they
  // are not text, and styles.css reserves their width on its own terms —
  // :has() for the info glyph, and the rg--removable class for the remove ×,
  // which is a class rather than :has() only because the renderer already
  // knows the answer (see roundGridHasRemove).
  //
  // @param {any[]} rowLabels @param {number} roundCount @returns {number}
  function roundGridLabelChars(rowLabels, roundCount) {
    let longest = 5; // "Total"
    for (let r = 0; r < roundCount; r++) {
      const tpl = rowLabels[r];
      const text = tpl && tpl.label ? String(tpl.label) : `R${r + 1}`;
      if (text.length > longest) longest = text.length;
    }
    return longest;
  }

  // Does this render draw a remove × ANYWHERE? The room for one is 1.4rem off
  // a column that is otherwise about 45px wide, so it is reserved on the
  // renders that draw one and on no others.
  //
  // This used to be a flat "the grid is editable", on the argument that an
  // exact rule would widen the column on the first press of Next round, every
  // game. The argument was right about the mechanics and wrong about the
  // price: the last remaining round draws no × (minRounds) and a template's
  // rows never do, so the Play screen — a grid that opens on Round 1 and holds
  // exactly one — spent 22px of a phone on a control that was not on it, for
  // the whole of the first round of every game. The shift is still real; it
  // now lands on the press of Next round, in the same frame as the new row
  // that press adds, rather than being paid for up front and forever.
  //
  // Asked of the same values the row renders from, and in the same terms
  // (`editable && !tpl && roundCount > minRounds`), so the reservation cannot
  // disagree with what is drawn.
  //
  // @param {any[]} rowLabels @param {number} roundCount @param {boolean} editable
  // @param {number} minRounds @returns {boolean}
  function roundGridHasRemove(rowLabels, roundCount, editable, minRounds) {
    if (!editable || roundCount <= minRounds) return false;
    for (let r = 0; r < roundCount; r++) if (!rowLabels[r]) return true;
    return false;
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
  //
  // Takes a COLUMN, not a player: a merged side has one Total the way it has
  // one cell, and one trophy. `some` rather than the first seat's flag because
  // a side crowned before this play was ever merged can carry the win on one
  // member — the trophy is the side's, and the toggle below settles all of
  // them (PlaySession.applyTeamTag's union rule, the same one).
  function renderTotalsCell(col, mode, total, host, showWinner) {
    // Co-op: the whole table wins or loses together, no per-player trophy.
    const won = col.players.some((p) => p.is_winner);
    const negClass = Number(total) < 0 ? " is-neg" : "";
    const tdClass = won ? "scoring-total-cell--winner" : "";
    // Labelled for the same reason the score cells are: the Total row is its
    // own table now, so "which column is this" is no longer answerable from
    // the markup around it.
    const name = columnName(col);
    const totalLabel = escapeAttr(`${name} total`);
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
          ? `<button class="scoring-winner-btn ${won ? "is-winner" : ""}"
                     title="${won ? "Winner" : "Mark as winner"}"
                     aria-label="${escapeAttr(name)} — ${won ? "winner" : "mark as winner"}"
                     onclick="window.${host}._toggleWinner(${col.head})">
              <i data-icon="${won ? "trophy" : "circle"}" class="w-4 h-4"></i>
            </button>`
          : (won ? `<i data-icon="trophy" class="w-4 h-4"></i>` : "")}
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

  // Wraps a column-header badge in a button that flips every column header of
  // the SAME SHAPE (`scope`: this grid's team-ness) between the colored bubble
  // and the header's text, and remembers the choice (RoundGridNames). Both
  // spans are always emitted; CSS shows one.
  //
  // Still no host method and still no re-render, for the same reason it never
  // had one: the two states differ by a single class, so there is nothing to
  // rebuild. Routing the tap through a host's `outerHTML` repaint instead
  // would reset `.rg__body`'s scrollLeft — on a 5-6 player grid the
  // table snaps back to column 1 — blur whatever cell was being typed in, and
  // give the read-only spectator mirror a host contract it has never needed.
  //
  // `fallback` is the caller's opts.headerNames default — already forced to
  // the badges on a team grid — so the first tap on a surface the user has
  // never toggled flips away from what it actually shows.
  //
  // `labelHtml` arrives ESCAPED (columnLabelHtml does it, because only that
  // function knows which parts are markup and which are a person's name);
  // `name` is the same thing flat and is escaped here, for the two attributes.
  function renderScoringHead(badgeHtml, labelHtml, name, isNamed, fallback, scope) {
    return `<button type="button" class="scoring-head__toggle"
              aria-pressed="${isNamed ? "true" : "false"}"
              aria-label="${escapeAttr(name)} — show player names on every column"
              title="${escapeAttr(name)}"
              onclick="window.RoundGridNames.toggleAll(${!!fallback}, '${scope === "team" ? "team" : "solo"}')">
              <span class="scoring-head__bubble">${badgeHtml}</span>
              <span class="scoring-head__name">${labelHtml}</span>
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
  //    last row to the middle of the screen, where the next scores go in with
  //    the rows above it still in sight. The row's own scroll-margin
  //    (styles.css) keeps it clear of the band pinned above it and the docked
  //    CTA below it on a grid too short to centre.
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
      _paneScroll[host] = { key: prev ? prev.key : undefined, left: el.scrollLeft, rounds: prev ? prev.rounds : 0 };
      const rg = el.closest(".rg");
      if (!rg) return;
      const mirrors = rg.querySelectorAll("[data-rg-sync]");
      for (let i = 0; i < mirrors.length; i++) mirrors[i].scrollLeft = el.scrollLeft;
    },
    /**
     * `key` is the record the grid shows. The memory is per host, and one host
     * can show many records in turn — every card of the play-detail popup is
     * "PlayDetailPopup" — so a render for a different record is a different
     * grid: it starts at column 1 and has not "grown". Without this, opening a
     * play with more rounds than the last one read as "Add round" and
     * scrolled the whole popup down to the grid. Hosts that pass no key (the
     * live play screens, one play each) compare undefined to undefined and
     * behave as they always have.
     * @param {string} host @param {number} roundCount
     * @param {string} [key] @param {boolean} [centre]
     */
    schedule(host, roundCount, key, centre) {
      const prev = _paneScroll[host];
      const same = !!prev && prev.key === key;
      const grew = same && centre !== false && roundCount > prev.rounds;
      _paneScroll[host] = { key, left: same ? prev.left : 0, rounds: roundCount };
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
          last.scrollIntoView({ block: "center" });
        }
      });
    },
  };

  // Persisted user preference for whether column headers show the player's
  // display NAME instead of their colored bubble. Tapping any header moves all
  // of them, on every surface, and the choice is still set the next time the
  // user opens a grid.
  //
  // Unlike SIGN_PREF_KEY there is no single default — the live play screens
  // (host + spectator mirror) start on names, the play-detail popup on
  // bubbles, and a TEAM grid on badges whichever surface it is drawn on. So a
  // key is an OVERRIDE: absent means "use this surface's own default", which
  // the caller supplies as `fallback` (opts.headerNames, forced false for a
  // team grid). One tap and the stored value wins everywhere.
  //
  // TWO KEYS, ONE PER GRID SHAPE, and the split is the whole of why a team
  // grid can have a default of its own. A single value made "solo grids show
  // names, team grids show badges" unexpressible the moment the user tapped
  // anything: the first tap on any competitive play would have carried names
  // into every team play the user ever opened, and the badge default — the one
  // thing that says who is on which side — would have been reachable only by a
  // user who had never touched a header. The shapes answer different
  // questions (a seat column asks "who is this", a side column asks "who is on
  // this"), so they remember different answers.
  const NAMES_PREF_KEYS = {
    solo: "bgb.scoring.headerNames",
    team: "bgb.scoring.headerNames.team",
  };
  // Mirrors the stored values for this page's lifetime. A browser that refuses
  // localStorage (private-mode Safari, blocked site data) would otherwise flip
  // the headers and then snap back on the next repaint, which reads as a
  // broken button rather than as a browser setting.
  const _namesChoice = { solo: null, team: null };
  /** @param {string} [scope] @returns {"solo"|"team"} */
  function namesScope(scope) {
    return scope === "team" ? "team" : "solo";
  }
  const RoundGridNames = {
    /**
     * @param {boolean} [fallback] surface default, used only while the user
     *   has never expressed a preference for this shape of grid.
     * @param {string} [scope] "team" for a grid holding a merged side,
     *   "solo" (the default) for one column per seat.
     * @returns {boolean}
     */
    enabled(fallback, scope) {
      const k = namesScope(scope);
      if (_namesChoice[k] != null) return _namesChoice[k];
      try {
        const v = localStorage.getItem(NAMES_PREF_KEYS[k]);
        if (v === "1") return true;
        if (v === "0") return false;
      } catch (_) {}
      return !!fallback;
    },
    /** @param {boolean} on @param {string} [scope] */
    set(on, scope) {
      const k = namesScope(scope);
      _namesChoice[k] = !!on;
      try { localStorage.setItem(NAMES_PREF_KEYS[k], on ? "1" : "0"); } catch (_) {}
    },
    /** Flip relative to what is on screen (stored value, else `fallback`). */
    toggle(fallback, scope) {
      const next = !this.enabled(fallback, scope);
      this.set(next, scope);
      return next;
    },
    /**
     * Inline-handler entry point: flip the preference, then repaint every
     * column header in the document that answers to it. Document-wide rather
     * than per-table so a grid sitting behind the play-detail popup doesn't
     * read stale until its own next repaint — but scoped, so tapping a team
     * play's header cannot rename the columns of a competitive grid open
     * behind it.
     * @param {boolean} [fallback] @param {string} [scope]
     */
    toggleAll(fallback, scope) {
      const on = this.toggle(fallback, scope);
      this.apply(on, scope);
      return on;
    },
    /** @param {boolean} on @param {string} [scope] */
    apply(on, scope) {
      const k = namesScope(scope);
      // A grid rendered before this shipped carries no data-rg-scope; it is a
      // solo grid by construction (the attribute and the team column model
      // ship together), so the solo selector takes it.
      const sel = k === "team"
        ? '.rg[data-rg-scope="team"] .scoring-head'
        : '.rg:not([data-rg-scope="team"]) .scoring-head';
      const heads = document.querySelectorAll(sel);
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
  window.roundGridColumns = roundGridColumns;
  window.roundGridColumnValue = roundGridColumnValue;
  window.roundGridColumnTotal = roundGridColumnTotal;
  window.roundGridSeatsFor = roundGridSeatsFor;
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
