// @ts-check
// widgets/scoring-template-editor.js — the body of a scoring-grid chapter.
//
// A scoring grid is a `layout: "scoring_grid"` chapter (migration 018): instead
// of markdown it holds an ordered list of labelled, colour-tagged rows, and the
// play screen opens with those rows already on the grid. This module renders
// the editor for that list, and the read-only preview the browse pool and the
// reference-guide scroll show when such a chapter is expanded.
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

  // Mirrors MAX_SCORING_TEMPLATE_ROWS / MAX_SCORING_ROW_LABEL_CHARS in the
  // backend's constants.py, which in turn answer to the DB CHECKs. Enforced
  // here so the ceiling is a disabled button rather than a 422 after typing 25
  // rows; the server is still the authority.
  const MAX_ROWS = 24;
  const MAX_LABEL = 24;

  /** @returns {{label: string, color: string}} */
  function blankRow() {
    return { label: "", color: "neutral" };
  }

  /**
   * The editor body: title, the row list, and a live preview.
   * @param {{title: string, rows: Array<{label: string, color: string}>,
   *          typeRow: string, error: string}} s
   */
  function render(s) {
    const rows = Array.isArray(s.rows) ? s.rows : [];
    const atMax = rows.length >= MAX_ROWS;
    return `
      ${s.typeRow}

      <div class="chapter-edit__titlerow">
        <input id="chapter-form-title" class="chapter-edit__titlefield"
               maxlength="200" required
               value="${escapeAttr(s.title || "")}"
               oninput="${V}._formTitle = this.value"
               placeholder="Everdell — final scoring" />
      </div>

      <p class="chapter-wiz__lede">
        One row per thing you total at the end. Anyone who adds this chapter
        gets these rows on their scoring grid.
      </p>

      <div class="tmpl-rows" id="tmpl-rows-host">
        ${renderRowList(rows)}
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
   * @param {Array<{label: string, color: string}>} rows
   */
  function renderRowList(rows) {
    if (!rows.length) {
      return `<p class="tmpl-rows__empty">No rows yet — add the first scoring category.</p>`;
    }
    return rows.map((row, i) => renderRow(row, i, rows.length)).join("");
  }

  function renderRow(row, i, total) {
    const color = row.color || "neutral";
    return `
      <div class="tmpl-row" data-row="${i}">
        <div class="tmpl-row__top">
          <span class="tmpl-row__num">${i + 1}</span>
          <input class="tmpl-row__label"
                 id="tmpl-row-label-${i}"
                 maxlength="${MAX_LABEL}"
                 value="${escapeAttr(row.label || "")}"
                 aria-label="Row ${i + 1} label"
                 placeholder="Prosperity"
                 oninput="${V}._tmplSetLabel(${i}, this.value)" />
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
        <div class="tmpl-row__colors" role="radiogroup"
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
      </div>
    `;
  }

  /**
   * Read-only picture of what the rows will look like, rendered by the REAL
   * scoring grid rather than a lookalike — so the author's preview and what a
   * scorer sees cannot disagree (.claude/rules/ui-object-design.md §2). Two
   * unnamed columns stand in for players; the grid needs at least one to draw
   * a table at all.
   *
   * Also used by the browse pool and the reference-guide scroll for the body of
   * an expanded scoring-grid chapter, where `renderMarkdown(content)` would
   * otherwise show the generated bullet mirror.
   * @param {Array<{label: string, color: string}>} rows
   */
  function preview(rows) {
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
    return window.renderRoundGrid(ghosts, "scoringTemplatePreview", {
      editable: false,
      rowLabels: usable,
    });
  }

  window.ScoringTemplateEditor = {
    render,
    renderRowList,
    preview,
    blankRow,
    ROW_COLORS,
    MAX_ROWS,
    MAX_LABEL,
  };
})();
