// @ts-check
// widgets/scoring-template-editor.js — the body of a scoring-grid chapter.
//
// A scoring grid is a `layout: "scoring_grid"` chapter (migration 018): instead
// of markdown it holds an ordered list of labelled, colour-tagged rows, and the
// play screen opens with those rows already on the grid. This module renders
// the editor for that list, and the read-only preview the browse pool and the
// reference-guide scroll show when such a chapter is expanded.
//
// NO TITLE FIELD. A grid is not named by its author — the backend derives its
// title from the game (services/chapter_grid.grid_title) and the pool prints
// the author and the popularity count under every row, which is what a reader
// actually picks between. See the note on grid_title for the full argument.
//
// Pure functions of a state snapshot, same split as chapter-wizard-steps.js:
// the view (views/reference-guide-add-view.js) owns the rows, the handlers and
// the fetches. Unlike the markdown editor — which had to stay in the view
// because its toolbar reads and writes the live textarea's selection — a row
// list touches nothing but its own inputs, so it belongs out here.
//
// Handlers are inline `onclick="window.referenceGuideAddView._foo()"` strings,
// the project idiom, and what lets these functions stay pure.

(function () {
  const V = "window.referenceGuideAddView";

  // Mirrors ScoringRowColor in shared-backend/routes/boardgame_buddy/
  // constants.py and the --row-* custom properties in styles.css. A SLUG, not a
  // hex: the grid lands on the scorepad, which is paper and therefore light in
  // both themes, so the stylesheet owns the ink (.claude/rules/theming.md §10).
  // The hex here is for the swatch chip in this editor ONLY — it never travels
  // to the server and never reaches the grid.
  //
  // Spectrum order, which is also the order the 5x2 swatch grid reads in.
  const ROW_COLORS = [
    { id: "neutral", label: "No colour", hex: null },
    { id: "red", label: "Red", hex: "#B03028" },
    { id: "pink", label: "Pink", hex: "#C2557E" },
    { id: "rust", label: "Rust", hex: "#A65D2C" },
    { id: "brown", label: "Brown", hex: "#6B4423" },
    { id: "gold", label: "Gold", hex: "#C9922A" },
    { id: "yellow", label: "Yellow", hex: "#B5A800" },
    { id: "green", label: "Green", hex: "#4A7A4A" },
    { id: "blue", label: "Blue", hex: "#4A6F94" },
    { id: "purple", label: "Purple", hex: "#7A5293" },
  ];

  // Mirrors MAX_SCORING_TEMPLATE_ROWS / MAX_SCORING_ROW_LABEL_CHARS /
  // MAX_SCORING_ROW_NOTE_CHARS in the backend's constants.py, which in turn
  // answer to the DB CHECKs. Enforced here so the ceiling is a disabled button
  // rather than a 422 after typing 25 rows; the server is still the authority.
  const MAX_ROWS = 24;
  const MAX_LABEL = 24;
  const MAX_NOTE = 200;

  /** @returns {{label: string, color: string, note: string}} */
  function blankRow() {
    return { label: "", color: "neutral", note: "" };
  }

  /** @param {string} slug @returns {{id: string, label: string, hex: string|null}} */
  function colorOf(slug) {
    return ROW_COLORS.find((c) => c.id === (slug || "neutral")) || ROW_COLORS[0];
  }

  // Mirrors ScoringGridMode in the backend's constants.py and the
  // bgb_chapters_grid_mode CHECK (migration 032). Only an EXPANSION's grid has
  // one; see domain/scoring-template.js for what each does at the table.
  const MODE_ADD_ON = "add_on";
  const MODE_REPLACE = "replace";

  /**
   * The one question an expansion's grid asks that a base game's does not:
   * when this box is on the table, do these rows JOIN the base game's score
   * sheet, or ARE they the score sheet?
   *
   * Asked here, of the author, rather than at the table of the host — the
   * author has the expansion in front of them and knows which it is; the host
   * would be guessing on someone else's behalf every single game. That is the
   * whole reason the mode is stored on the grid.
   *
   * Absent entirely for a base game's grid. It has nothing to meet, and a
   * disabled control asking an unanswerable question is worse than no control
   * (.claude/rules/ui-object-design.md §3b).
   *
   * Two radio-behaving buttons rather than a switch: neither is the default
   * state of the other, and a switch labelled "Replace" reads as if off means
   * nothing happens. The descriptions are part of the control because the
   * words alone do not carry it — "add-on" is what the box IS, and the
   * question is what its ROWS do.
   *
   * @param {string|null|undefined} expansionName
   * @param {string|null|undefined} mode
   */
  function renderMode(expansionName, mode) {
    if (!expansionName) return "";
    const active = mode === MODE_REPLACE ? MODE_REPLACE : MODE_ADD_ON;
    const opt = (id, title, body) => `
      <button type="button" role="radio" aria-checked="${id === active ? "true" : "false"}"
              class="tmpl-mode__opt ${id === active ? "tmpl-mode__opt--on" : ""}"
              onclick="${V}._tmplSetMode('${id}')">
        <span class="tmpl-mode__title">${title}</span>
        <span class="tmpl-mode__body">${body}</span>
      </button>
    `;
    const who = escapeHtml(expansionName);
    return `
      <div class="chapter-edit__field tmpl-mode">
        <label class="chapter-edit__label">When ${who} is on the table</label>
        <div class="tmpl-mode__opts" role="radiogroup"
             aria-label="How ${escapeAttr(expansionName)}'s rows meet the base game's">
          ${opt(MODE_ADD_ON, "Add these rows",
                `They join the base game's scoring template, under its rows.`)}
          ${opt(MODE_REPLACE, "Replace the template",
                `These rows are the whole score sheet — the base game's are not used.`)}
        </div>
      </div>
    `;
  }

  /**
   * The one-line badge saying what an EXPANSION's grid does when its box is on
   * the table — adds its rows to the base game's, or stands in for them.
   *
   * Lives here rather than in either caller because three surfaces label the
   * same grids and must not label them differently
   * (.claude/rules/ui-object-design.md §2): the play cascade's offer sheet, the
   * reference-guide scroll, and the browse pool behind it. Empty string for a
   * BASE game's grid, which has no mode — and for a caller that does not know
   * the base game, where "add-on" and "replace" would both be guesses.
   *
   * @param {{grid?: {mode?: string|null}, game_id?: string, source_game_id?: string}} c
   * @param {string|null|undefined} baseGameId
   * @returns {string} html, or "" when there is no mode to show
   */
  function modeTag(c, baseGameId) {
    if (!window.ScoringTemplate || !baseGameId) return "";
    const mode = window.ScoringTemplate.modeOf(c, baseGameId);
    if (!mode) return "";
    const replaces = mode === MODE_REPLACE;
    return `
      <span class="tmpl-modetag ${replaces ? "tmpl-modetag--replace" : ""}">
        <i data-icon="${replaces ? "refresh-cw" : "plus"}" class="w-3 h-3"></i>
        ${replaces ? "Replaces the base game's rows" : "Adds to the base game's rows"}
      </span>
    `;
  }

  /**
   * The editor body: the row list and a live preview.
   * @param {{rows: Array<{label: string, color: string, note?: string}>,
   *          typeRow: string, error: string,
   *          colorOpen?: number|null, noteOpen?: number|null,
   *          expansionName?: string|null, mode?: string|null}} s
   *   `expansionName` is set only when the grid is being saved against an
   *   EXPANSION, and is what makes the mode question appear at all.
   */
  function render(s) {
    const rows = Array.isArray(s.rows) ? s.rows : [];
    const atMax = rows.length >= MAX_ROWS;
    // The mode question goes ABOVE the lede, not under it: on an expansion it
    // is the first thing to answer and it reframes everything below — a
    // replacement sheet wants the base game's categories reprinted among its
    // rows and an add-on wants them left out, so an author who meets it after
    // typing the rows has typed the wrong ones. It renders to nothing on a
    // base game's grid, where the lede stays the first line on the step.
    return `
      ${s.typeRow}

      ${renderMode(s.expansionName, s.mode)}

      <p class="chapter-wiz__lede">
        A custom scoring template. Create row heads with a custom colour, and
        add an optional description to clarify the scoring instructions.
      </p>

      <div class="tmpl-rows" id="tmpl-rows-host">
        ${renderRowList(rows, s)}
      </div>

      <button type="button" class="tmpl-addrow" ${atMax ? "disabled" : ""}
              onclick="${V}._tmplAddRow()">
        <i data-icon="plus" class="w-4 h-4"></i>
        ${atMax ? `Maximum ${MAX_ROWS} rows` : "Add row"}
      </button>

      <div class="tmpl-preview">
        <span class="tmpl-preview__label">Preview</span>
        ${preview(rows)}
      </div>

      ${s.error ? `<div class="text-error text-sm chapter-edit__error">${escapeHtml(s.error)}</div>` : ""}
    `;
  }

  /**
   * Just the rows. Split out so the view can patch `#tmpl-rows-host` on its own
   * rather than re-rendering the editor — a full repaint would blow away the
   * label input the user is typing into, along with its focus and caret
   * (.claude/rules/overlays.md §6).
   *
   * `ui` carries which row currently has its colour picker or its description
   * field open. Both are a single index rather than a per-row flag: one open at
   * a time is what keeps a twenty-four-row list scrollable, and it means the
   * disclosure state lives with the VIEW rather than riding along inside the
   * row objects that get posted to the server.
   * @param {Array<{label: string, color: string, note?: string}>} rows
   * @param {{colorOpen?: number|null, noteOpen?: number|null}} [ui]
   */
  function renderRowList(rows, ui) {
    if (!rows.length) {
      return `<p class="tmpl-rows__empty">No rows yet — add the first scoring category.</p>`;
    }
    const u = ui || {};
    return rows.map((row, i) => renderRow(row, i, rows.length, u)).join("");
  }

  function renderRow(row, i, total, ui) {
    const color = row.color || "neutral";
    const swatch = colorOf(color);
    const colorOpen = ui.colorOpen === i;
    return `
      <div class="tmpl-row" data-row="${i}">
        <div class="tmpl-row__top">
          <span class="tmpl-row__num">${i + 1}</span>
          <input class="tmpl-row__label"
                 id="tmpl-row-label-${i}"
                 maxlength="${MAX_LABEL}"
                 value="${escapeAttr(row.label || "")}"
                 aria-label="Row ${i + 1} name"
                 placeholder="Row Name"
                 oninput="${V}._tmplSetLabel(${i}, this.value)" />
          ${renderColorChip(i, swatch, colorOpen)}
          <button type="button" class="tmpl-row__move" aria-label="Move row ${i + 1} up"
                  ${i === 0 ? "disabled" : ""}
                  onclick="${V}._tmplMoveRow(${i}, -1)">
            <i data-icon="chevron-up" class="w-4 h-4"></i>
          </button>
          <button type="button" class="tmpl-row__move" aria-label="Move row ${i + 1} down"
                  ${i === total - 1 ? "disabled" : ""}
                  onclick="${V}._tmplMoveRow(${i}, 1)">
            <i data-icon="chevron-down" class="w-4 h-4"></i>
          </button>
          <button type="button" class="tmpl-row__del" aria-label="Remove row ${i + 1}"
                  onclick="${V}._tmplRemoveRow(${i})">
            <i data-icon="x" class="w-4 h-4"></i>
          </button>
        </div>
        ${colorOpen ? renderColorGrid(i, color) : ""}
        ${renderNote(row, i, ui.noteOpen === i)}
      </div>
    `;
  }

  /**
   * The collapsed colour control: one disc showing the row's current colour,
   * which expands the ten-swatch picker under the row and collapses again the
   * moment a colour is chosen. The picker used to be permanently open on every
   * row, which cost 52px per row — on a full twenty-four-row grid that is more
   * than a phone screen of swatches for a decision each row is done making
   * after one tap.
   */
  function renderColorChip(i, swatch, open) {
    return `
      <button type="button"
              class="tmpl-row__chip ${swatch.hex ? "" : "tmpl-row__chip--none"} ${open ? "tmpl-row__chip--open" : ""}"
              ${swatch.hex ? `style="--sw: ${escapeAttr(swatch.hex)}"` : ""}
              aria-expanded="${open ? "true" : "false"}"
              aria-controls="tmpl-row-colors-${i}"
              aria-label="Row ${i + 1} colour: ${escapeAttr(swatch.label)}. Change colour"
              title="${escapeAttr(swatch.label)}"
              onclick="${V}._tmplToggleColor(${i})"></button>
    `;
  }

  function renderColorGrid(i, color) {
    return `
      <div class="tmpl-row__colors" id="tmpl-row-colors-${i}" role="radiogroup"
           aria-label="Row ${i + 1} colour">
        ${ROW_COLORS.map((c) => `
          <button type="button" role="radio"
                  aria-checked="${c.id === color ? "true" : "false"}"
                  aria-label="${escapeAttr(c.label)}"
                  title="${escapeAttr(c.label)}"
                  class="tmpl-sw ${c.id === color ? "tmpl-sw--on" : ""} ${c.hex ? "" : "tmpl-sw--none"}"
                  ${c.hex ? `style="--sw: ${escapeAttr(c.hex)}"` : ""}
                  onclick="${V}._tmplSetColor(${i}, '${escapeAttr(jsStr(c.id))}')"></button>
        `).join("")}
      </div>
    `;
  }

  /**
   * The optional per-row description — how this row is scored, in the author's
   * own words. It is a TEMPLATE feature and not a play one: it never renders in
   * the row's own header, only behind the info button the scoring grid puts
   * beside a labelled row that has one (widgets/round-score-grid.js), so a
   * fourteen-row Everdell grid stays as narrow as it was.
   *
   * Three states, and the row's own data picks between them: writing (the
   * field), written (one truncated line that reopens it), and absent (the
   * invitation). Written collapses back to a line rather than staying a live
   * textarea because most rows will never have one and a grid of empty boxes is
   * what this control exists to avoid.
   */
  function renderNote(row, i, open) {
    const note = row.note || "";
    if (open) {
      return `
        <div class="tmpl-row__noteedit">
          <textarea class="tmpl-row__notefield" id="tmpl-row-note-${i}"
                    rows="2" maxlength="${MAX_NOTE}"
                    aria-label="Row ${i + 1} scoring description"
                    placeholder="How is this row scored? Only shown during a game, behind an info button."
                    oninput="${V}._tmplSetNote(${i}, this.value)">${escapeHtml(note)}</textarea>
          <button type="button" class="tmpl-row__notedone"
                  onclick="${V}._tmplToggleNote(${i})">Done</button>
        </div>
      `;
    }
    return `
      <button type="button" class="tmpl-row__noteline ${note ? "tmpl-row__noteline--set" : ""}"
              aria-label="${note ? `Edit row ${i + 1} scoring description` : `Add a scoring description to row ${i + 1}`}"
              onclick="${V}._tmplToggleNote(${i})">
        <i data-icon="info" class="w-3.5 h-3.5"></i>
        <span>${note ? escapeHtml(note) : "Add description (optional)"}</span>
      </button>
    `;
  }

  /**
   * Read-only picture of what the rows will look like, rendered by the REAL
   * scoring grid rather than a lookalike — so the author's preview and what a
   * scorer sees cannot disagree (.claude/rules/ui-object-design.md §2). Two
   * unnamed columns stand in for players; the grid needs at least one to draw
   * a table at all.
   *
   * Descriptions ride along, so a row that has one shows its info button here
   * too. The button does not open — `.tmpl-preview .rg` is
   * `pointer-events: none`, because the preview is a picture and must not steal
   * a tap meant for the editor above it — but seeing the mark appear is how the
   * author knows the description landed on the row they meant.
   *
   * Also used by the browse pool and the reference-guide scroll for the body of
   * an expanded scoring-grid chapter, where `renderMarkdown(content)` would
   * otherwise show the generated bullet mirror, and by the play cascade's
   * template offer, which draws SEVERAL of these at once — hence `host`.
   *
   * @param {Array<{label: string, color: string, note?: string}>} rows
   * @param {string} [host] a name of this preview's own, unique on the screen.
   *   The grid stamps it into data-round-grid and keys its scroll memory off
   *   it, so two previews sharing one name would have the taller of them
   *   scrolled to its last row by the other's paint.
   */
  function preview(rows, host) {
    const usable = (rows || []).filter((r) => (r.label || "").trim());
    if (!usable.length) {
      return `<p class="tmpl-rows__empty">Rows you add show up here.</p>`;
    }
    const ghosts = [
      { name: "Player 1", initials: "1", roundScores: usable.map(() => null) },
      { name: "Player 2", initials: "2", roundScores: usable.map(() => null) },
    ];
    // host is unused in read-only mode (no handlers are emitted), but the
    // renderer stamps it into data-round-grid for its scroll memory, so give it
    // a name of its own rather than borrowing a live grid's.
    return window.renderRoundGrid(ghosts, host || "scoringTemplatePreview", {
      editable: false,
      rowLabels: usable,
    });
  }

  /**
   * Whose grid this is — the one thing that tells two grids for one game apart,
   * since the title is derived from the game and is therefore identical on both
   * (see the NO TITLE FIELD note above). Lives here rather than in either
   * caller because the offer sheet and the reference-guide scroll both label
   * the same grids and must not label them differently
   * (.claude/rules/ui-object-design.md §2).
   *
   * @param {{created_by?: string, created_by_name?: string}} t
   * @returns {string} plain text — callers escape it.
   */
  function authorLabel(t) {
    const me = window.store && window.store.get && window.store.get("user");
    if (me && t.created_by && me.id === t.created_by) return "Your grid";
    return t.created_by_name ? `${t.created_by_name}'s grid` : "Community grid";
  }

  window.ScoringTemplateEditor = {
    render,
    renderMode,
    modeTag,
    MODE_ADD_ON,
    MODE_REPLACE,
    renderRowList,
    preview,
    authorLabel,
    blankRow,
    ROW_COLORS,
    MAX_ROWS,
    MAX_LABEL,
    MAX_NOTE,
  };
})();
