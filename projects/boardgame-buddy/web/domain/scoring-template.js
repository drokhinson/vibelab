// @ts-check
// domain/scoring-template.js — how several scoring grids become one scorepad.
//
// A scoring grid is a chapter and a chapter belongs to ONE game (migration
// 018). Expansions are games, so an expansion can carry a grid of its own —
// and the play a host is scoring is base game PLUS the expansions on the
// table, which means the grids have to meet somewhere. Migration 032 says
// where: every expansion grid declares a MODE.
//
//   * "add_on"  — its rows are APPENDED to the base game's grid. Everdell +
//                 Pearlbrook: the fourteen base rows, then Pearls and Wonders.
//   * "replace" — its rows ARE the scorepad and the base game's grid sits this
//                 one out. A legacy box that reprints the whole score sheet.
//
// A base game's own grid has no mode: the question is "how does this meet the
// base game's grid", which it cannot be asked.
//
// WHAT THIS MODULE IS FOR. The play screen used to treat two adopted grids as
// two rival scorepads and make the host pick — which is wrong for both modes.
// An add-on's rows are not an ALTERNATIVE to the base game's, and a
// replacement is not a choice the host should have to remember to make every
// game. So the two questions are separated here:
//
//   split()   — which grids are CANDIDATES for the scorepad (rivals, and the
//               only thing the picker sheet ever shows), and which are ADD-ONS
//               that fold into whichever candidate wins.
//   compose() — one candidate + the add-ons -> the flat row list the grid
//               renders, plus the seam list that says where each row came from.
//
// Pure functions of their arguments — no fetch, no DOM, no store. That is what
// lets the play screen, the picker sheet and the reference guide all describe
// the same composition without three of them deriving it differently
// (.claude/rules/ui-object-design.md §2).

(function () {
  /**
   * @typedef {Object} GridChapter A layout='scoring_grid' chapter.
   * @property {string} id
   * @property {string} [game_id]
   * @property {string} [source_game_id]
   * @property {string} [source_game_name]
   * @property {string} [source_color]
   * @property {string} [title]
   * @property {{v?: number, mode?: string|null,
   *             rows: Array<{label: string, color?: string, note?: string}>}} grid
   */

  /**
   * @typedef {Object} TemplatePart One grid's contribution to a composition.
   * @property {string|null} chapter_id
   * @property {string|null} game_id
   * @property {string|null} game_name
   * @property {string|null} mode  null for the scorepad part, add_on for the rest
   * @property {number} row_count
   */

  const MODE_ADD_ON = "add_on";
  const MODE_REPLACE = "replace";

  // Mirrors MAX_SCORING_TEMPLATE_ROWS in the backend's constants.py and the
  // bgb_chapters_grid_shape CHECK — which cap ONE AUTHORED grid, where this
  // caps the COMPOSITION of several. Same number for the same reason:
  // boardgamebuddy_play_session_scores.round_index is CHECK'd 0..63 and
  // template rows take the low indexes, so 24 leaves 40 rounds of headroom
  // before a live-scores write starts failing — silently, because those writes
  // are fire-and-forget.
  //
  // Nothing in SQL enforces it on a composition (plays.scoring_template is a
  // free JSONB document), so this constant IS the ceiling and compose() is the
  // only thing that applies it.
  const MAX_ROWS = 24;

  /** Which game a chapter belongs to, however the response tagged it. */
  function gameIdOf(c) {
    return (c && (c.source_game_id || c.game_id)) || null;
  }

  function rowsOf(c) {
    const rows = c && c.grid && c.grid.rows;
    return Array.isArray(rows) && rows.length ? rows : null;
  }

  /**
   * The mode a grid ACTS in, which is not quite the mode it stores.
   *
   * Stored: NULL on a base game's grid, add_on|replace on an expansion's. But
   * a grid written against an expansion before migration 032 stored nothing at
   * all, and a base game's grid served from a cache written before the guide
   * knew about expansions can arrive with no source tagging. So the mode is
   * resolved against the BASE GAME the composition is for, not read off the
   * document alone:
   *
   *   * the base game's own grid is always the scorepad, whatever it stores —
   *     a stray mode on it (an older client, a hand-edited row) is ignored
   *     rather than allowed to turn the base game into an add-on to itself;
   *   * an expansion's grid with no mode is an add-on, matching
   *     services/chapter_grid.resolve_grid_mode's default and the behaviour
   *     those pre-032 grids already had.
   *
   * @param {GridChapter} c
   * @param {string} baseGameId
   * @returns {string|null} MODE_ADD_ON, MODE_REPLACE, or null for the base game
   */
  function modeOf(c, baseGameId) {
    const gid = gameIdOf(c);
    if (!gid || !baseGameId || gid === baseGameId) return null;
    const raw = c && c.grid && c.grid.mode;
    return raw === MODE_REPLACE ? MODE_REPLACE : MODE_ADD_ON;
  }

  /** The name to print for a grid's game — the expansion's, or nothing. */
  function gameNameOf(c) {
    return (c && c.source_game_name) || null;
  }

  /**
   * Sort expansion grids into the order their expansions sit in on the play.
   *
   * The guide's my-chapters response merges base + expansions and orders by
   * chapter type, which is right for a reference scroll and arbitrary for a
   * scorepad. Composing in the play's own expansion order instead means two
   * hosts with the same box on the table get the same rows in the same order,
   * and that adding a third expansion appends its rows rather than
   * reshuffling the two already there.
   *
   * Grids for a game not in `order` sort last, keeping their relative order —
   * that is the guide showing a grid for an expansion the host has since
   * unticked, which _activeAddOns filters out before it ever gets here.
   */
  function byExpansionOrder(order) {
    const rank = new Map((order || []).map((id, i) => [id, i]));
    return (a, b) => {
      const ra = rank.has(gameIdOf(a)) ? rank.get(gameIdOf(a)) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(gameIdOf(b)) ? rank.get(gameIdOf(b)) : Number.MAX_SAFE_INTEGER;
      return ra - rb;
    };
  }

  /**
   * Sort the adopted grids into scorepad candidates and add-ons.
   *
   * The rule the two modes come down to: a REPLACE grid in play is a scorepad
   * in its own right, so it does not compete with the base game's grid — it
   * DISPLACES it. With one on the table the base game's grids are not
   * candidates at all, which is what "completely replaces the base game
   * template" has to mean if it means anything.
   *
   * That leaves `bases` as a genuine list of rivals only in two cases: several
   * community grids adopted for one base game (the case the picker sheet was
   * written for), or two expansions on the table each bringing a replacement.
   * The second is a real ambiguity — two boxes that each claim the whole score
   * sheet — and it is answered the same way as the first, by asking, rather
   * than by a rule nobody would be able to predict.
   *
   * @param {GridChapter[]} templates every adopted scoring grid, base + expansions
   * @param {{baseGameId: string, expansionIds?: string[]}} opts
   * @returns {{bases: GridChapter[], addOns: GridChapter[], replacing: boolean}}
   */
  function split(templates, opts) {
    const baseGameId = (opts && opts.baseGameId) || null;
    const order = (opts && opts.expansionIds) || [];
    const usable = (templates || []).filter((c) => rowsOf(c));

    const base = [];
    const replace = [];
    const addOns = [];
    for (const c of usable) {
      const mode = modeOf(c, baseGameId);
      if (mode === null) base.push(c);
      else if (mode === MODE_REPLACE) replace.push(c);
      else addOns.push(c);
    }
    replace.sort(byExpansionOrder(order));
    addOns.sort(byExpansionOrder(order));
    return {
      bases: replace.length ? replace : base,
      addOns,
      replacing: replace.length > 0,
    };
  }

  /**
   * One scorepad + its add-ons -> the rows the grid actually draws.
   *
   * `base` may be null: a host who has adopted an expansion's add-on grid and
   * nothing for the base game still gets those rows, which is more useful than
   * refusing to compose because half the pair is missing. The result then has
   * no leading part and reads as a scorepad of just the expansion's rows.
   *
   * Rows are concatenated VERBATIM — no dedupe by label. Two grids that both
   * name a row "Bonus" mean two different bonuses (that is what makes them two
   * grids), and silently collapsing them would lose a scoring category from
   * the table with nothing to show the host it happened.
   *
   * @param {GridChapter|null} base
   * @param {GridChapter[]} addOns
   * @returns {{rows: Array<any>, parts: TemplatePart[], dropped: number}}
   */
  function compose(base, addOns) {
    /** @type {Array<any>} */
    const rows = [];
    /** @type {TemplatePart[]} */
    const parts = [];
    let dropped = 0;

    const layers = [];
    if (base && rowsOf(base)) layers.push({ c: base, mode: null });
    for (const c of addOns || []) {
      if (rowsOf(c)) layers.push({ c, mode: MODE_ADD_ON });
    }

    for (const layer of layers) {
      const src = rowsOf(layer.c) || [];
      // The ceiling is applied per LAYER as the rows go on, so a composition
      // that overruns keeps every earlier grid whole and loses only the tail
      // of the last one to fit — rather than the whole last grid, or a
      // proportional slice of each, both of which lose rows the host could
      // have had room for.
      const room = MAX_ROWS - rows.length;
      const take = src.slice(0, Math.max(0, room));
      dropped += src.length - take.length;
      if (!take.length) continue;
      for (const r of take) {
        rows.push({
          label: r.label,
          color: r.color || "neutral",
          ...(r.note ? { note: r.note } : {}),
        });
      }
      parts.push({
        chapter_id: layer.c.id || null,
        game_id: gameIdOf(layer.c),
        game_name: gameNameOf(layer.c),
        mode: layer.mode,
        row_count: take.length,
      });
    }
    return { rows, parts, dropped };
  }

  /**
   * What a composition is CALLED — the scorepad's own title, plus the
   * expansions folded into it.
   *
   * The backend derives every grid's title from its game
   * (services/chapter_grid.grid_title), so a base grid is already "Everdell
   * score sheet" and naming the add-ons beside it gives "Everdell score sheet
   * + Pearlbrook". Past two add-ons it counts them instead, because this
   * string lands in the scoring bar's one line on a 390px phone.
   *
   * @param {{rows: Array<any>, parts: TemplatePart[]}} composed
   * @param {GridChapter|null} base
   */
  function composedTitle(composed, base) {
    const parts = (composed && composed.parts) || [];
    const lead = base ? (base.title || "Custom rows") : null;
    const extras = parts
      .filter((p) => p.mode === MODE_ADD_ON)
      .map((p) => p.game_name)
      .filter(Boolean);
    if (!lead) {
      // No base grid — the add-ons ARE the scorepad, so they name it.
      if (!extras.length) return "Custom rows";
      return extras.length <= 2 ? extras.join(" + ") : `${extras.length} expansions`;
    }
    if (!extras.length) return lead;
    if (extras.length <= 2) return `${lead} + ${extras.join(" + ")}`;
    return `${lead} + ${extras.length} expansions`;
  }

  /**
   * The document a play or a live session stores: composed rows, the id of
   * whichever grid led them, and the seam list.
   *
   * `parts` is omitted when one grid supplied the whole thing, so an
   * uncomposed template is byte-identical to what shipped before migration
   * 032 and every reader of a pre-032 snapshot keeps reading it unchanged.
   *
   * @param {GridChapter|null} base
   * @param {GridChapter[]} addOns
   * @returns {any|null} null when there is nothing to score on
   */
  function snapshot(base, addOns) {
    const composed = compose(base, addOns);
    if (!composed.rows.length) return null;
    const doc = {
      v: 1,
      chapter_id: base ? base.id : null,
      title: composedTitle(composed, base),
      rows: composed.rows,
    };
    if (composed.parts.length > 1) doc.parts = composed.parts;
    return doc;
  }

  /**
   * Rebuild a chapter-shaped object from a stored snapshot, so a template the
   * host had on a moment ago can be put back without the guide answering
   * again. The inverse of snapshot() as far as the rows go — the seams are not
   * reconstructed, because what comes back is ONE grid standing for the whole
   * composition and re-composing it would fold the add-ons in twice.
   *
   * @param {any} snap a plays/session scoring_template document
   * @returns {GridChapter|null}
   */
  function fromSnapshot(snap) {
    if (!snap || !Array.isArray(snap.rows) || !snap.rows.length) return null;
    return {
      id: snap.chapter_id,
      title: snap.title,
      grid: { v: 1, rows: snap.rows },
    };
  }

  /** Does this snapshot draw on more than one grid? */
  function isComposed(snap) {
    return !!(snap && Array.isArray(snap.parts) && snap.parts.length > 1);
  }

  window.ScoringTemplate = {
    MODE_ADD_ON,
    MODE_REPLACE,
    MAX_ROWS,
    gameIdOf,
    modeOf,
    split,
    compose,
    composedTitle,
    snapshot,
    fromSnapshot,
    isComposed,
  };
})();
