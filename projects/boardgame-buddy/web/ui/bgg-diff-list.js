// @ts-check
// ui/bgg-diff-list.js — the BgB <-> BGG comparison, rendered as a table.
//
// WHY A TABLE. The old renderer grouped rows under a verb ("18 to add") without
// naming the side being written, so the single most important question — do I
// need to push these up, or pull them down? — was unanswerable from the card.
// A three-column table (game, what BgB has, what BGG has) answers it by
// construction: a column of "Owned" next to a column of "—" is a push, the
// mirror image is an import. Nobody has to trust a verb.
//
// One renderer, two variants, because there are two surfaces:
//   "card"  the inline result under Check status — the table, capped, + legend
//   "sheet" the review list inside a sync sheet — every row, with the column
//           this direction writes marked as the one that changes
//
// THEMING: both surfaces are paper. Settings is .bgb-spoke-screen and
// .bgb-sheet__panel is background: var(--polaroid-bg), which is light in BOTH
// themes. Everything here reads polaroid tokens; never oklch(var(--b1)) and
// never --accent-hover as ink (.claude/rules/theming.md §6).

(function () {
  // ONE vocabulary for both columns. BGG's own flag names (own / prevowned /
  // wishlist) are what the API writes, but printing them opposite BgB's labels
  // makes two spellings of the same state look like a disagreement — exactly
  // the confusion the table exists to kill. The push footnote still names the
  // real flags, which is where that detail actually matters.
  const LABEL = { owned: "Owned", prev_owned: "Prev. owned", wishlist: "Wishlist" };

  // Row kinds, in render order. Each one is stated as a DIRECTION, not a verb.
  // `n` is null when the server truncated the row list: the rule still holds,
  // but a count taken from a partial list would contradict the headline.
  const KINDS = [
    {
      key: "bgb-only", tone: "add",
      legend: (n) => `${n === null ? "Only in BgB" : `${n} only in BgB`}
        — <b>BgB &rarr; BGG</b> adds ${n === 1 ? "it" : "them"} to BoardGameGeek`,
    },
    {
      key: "differs", tone: "change",
      legend: (n) => `${n === null ? "Status differs" : `${n} ${n === 1 ? "status differs" : "statuses differ"}`}
        — whichever direction you run overwrites the other side`,
    },
    {
      key: "bgg-only", tone: "clear",
      legend: (n) => `${n === null ? "Only on BGG" : `${n} only on BGG`}
        — <b>BGG &rarr; BgB</b> adds ${n === 1 ? "it" : "them"} here;
        <b>BgB &rarr; BGG</b> clears ${n === 1 ? "it" : "them"} there`,
    },
  ];
  const KIND_ORDER = KINDS.reduce((m, k, i) => ((m[k.key] = i), m), /** @type {any} */ ({}));

  /**
   * @typedef {Object} CmpRow
   * @property {number} bgg_id
   * @property {string} name
   * @property {string|null} local        BgB's status, null = not on the shelf
   * @property {string|null} remote       BGG's status, null = not in the collection
   * @property {string|null} push         what a push would do to this row
   * @property {string|null} pull         what an import would do to this row
   * @property {boolean} newly_catalogued
   * @property {string} kind
   */

  /**
   * Both change lists describe the SAME set of disagreeing games read opposite
   * ways, so they are merged by bgg_id into one row per game. push_changes is
   * the complete set today (it carries add/update/clear, i.e. every case);
   * pull_changes is merged in anyway rather than assumed redundant, so a future
   * pull-only case cannot silently vanish from the table.
   * @param {any} diff
   * @returns {CmpRow[]}
   */
  function buildRows(diff) {
    /** @type {Map<number, CmpRow>} */
    const byId = new Map();
    const put = (item, key, change) => {
      const existing = byId.get(item.bgg_id);
      if (existing) {
        existing[key] = change;
        return;
      }
      byId.set(item.bgg_id, {
        bgg_id: item.bgg_id,
        name: item.game_name || "Untitled",
        local: item.local_status || null,
        remote: item.remote_status || null,
        push: key === "push" ? change : null,
        pull: key === "pull" ? change : null,
        newly_catalogued: !!item.newly_catalogued,
        kind: "",
      });
    };
    for (const p of diff.push_changes || []) put(p, "push", p.change);
    for (const p of diff.pull_changes || []) put(p, "pull", p.change);

    const rows = Array.from(byId.values());
    for (const r of rows) {
      r.kind = r.remote === null ? "bgb-only" : r.local === null ? "bgg-only" : "differs";
    }
    rows.sort((a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
    return rows;
  }

  function statusCell(status) {
    if (!status) {
      return `<span class="bgg-cmp__none" title="Not there">&mdash;<span class="bgb-vis-hidden">not there</span></span>`;
    }
    return `<span class="bgg-cmp__val">${escapeHtml(LABEL[status] || status)}</span>`;
  }

  /**
   * A pull HELD row: BgB keeps what it has, so the written column shows the
   * value it is keeping rather than the one BGG would have written. It must
   * not read like every other row in the column, or the sheet promises to
   * protect the row and then appears to overwrite it anyway.
   */
  function heldCell(status) {
    return `${statusCell(status)}<span class="bgg-cmp__kept">kept</span>`;
  }

  function mark(which) {
    return which === "bgg"
      ? `<span class="bgb-mark bgb-mark--sm bgb-mark--bgg"><img src="assets/credits/bgg-mark.svg" alt="" /></span>`
      : `<span class="bgb-mark bgb-mark--sm bgb-mark--bgb"><img src="assets/brand/bgb-logo.svg" alt="" /></span>`;
  }

  /**
   * @param {CmpRow[]} rows
   * @param {{direction?: "push"|"pull"|null}} o
   */
  function table(rows, o) {
    const dir = o.direction || null;
    const head = (which, label) => {
      const writes = dir && ((dir === "push" && which === "bgg") || (dir === "pull" && which === "bgb"));
      return `<th scope="col" class="bgg-cmp__th bgg-cmp__th--${which}${writes ? " bgg-cmp__th--writes" : ""}">
        ${mark(which)}
        <span class="bgb-vis-hidden">${label}${writes ? " — the side this sync writes" : ""}</span>
        ${writes ? `<span class="bgg-cmp__writes" aria-hidden="true">changes</span>` : ""}
      </th>`;
    };
    const body = rows.map((r) => {
      const tag = r.newly_catalogued
        ? `<span class="bgg-cmp__new" title="Imported into BgB's catalog by this check">new</span>`
        : "";
      // No before -> after in the cells: the written column BECOMES the other
      // one on every row (a cleared push row becomes BgB's dash just as much as
      // an added one becomes BgB's status), so the two columns already say the
      // outcome and the rule line below states it once. Cramming an arrow and a
      // second status into a 5.6rem column only overflowed it.
      const bgb = dir === "pull" && r.pull === "held" ? heldCell(r.local) : statusCell(r.local);
      const bgg = statusCell(r.remote);
      return `<tr class="bgg-cmp__row bgg-cmp__row--${r.kind}">
        <th scope="row" class="bgg-cmp__game" title="${escapeHtml(r.name)}">
          <div class="bgg-cmp__gamein">
            <span class="bgg-cmp__stripe" aria-hidden="true"></span>
            <span class="bgg-cmp__name">${escapeHtml(r.name)}</span>${tag}
          </div>
        </th>
        <td class="bgg-cmp__cell${dir === "pull" ? " bgg-cmp__cell--writes" : ""}">${bgb}</td>
        <td class="bgg-cmp__cell${dir === "push" ? " bgg-cmp__cell--writes" : ""}">${bgg}</td>
      </tr>`;
    }).join("");
    return `<table class="bgg-cmp">
      <thead><tr>
        <th scope="col" class="bgg-cmp__th bgg-cmp__th--game">Game</th>
        ${head("bgb", "BoardgameBuddy")}
        ${head("bgg", "BoardGameGeek")}
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  /**
   * The direction key: what each row kind means for each button. This is the
   * part that actually answers "which way do I sync?".
   * @param {CmpRow[]} rows
   * @param {boolean} exact  false when the row list is truncated — see KINDS
   */
  function legend(rows, exact) {
    const items = KINDS
      .map((k) => ({ k, n: rows.filter((r) => r.kind === k.key).length }))
      .filter((c) => c.n > 0)
      .map((c) => `<li class="bgg-cmp__legend-item bgg-cmp__legend-item--${c.k.tone}">
        <span class="bgg-cmp__stripe" aria-hidden="true"></span>
        <span>${c.k.legend(exact ? c.n : null)}</span>
      </li>`)
      .join("");
    return items ? `<ul class="bgg-cmp__legend">${items}</ul>` : "";
  }

  function unpushableNote(unpushable) {
    if (!unpushable.length) return "";
    const n = unpushable.length;
    return `<p class="bgg-diff__note">${n} ${n === 1 ? "game has" : "games have"} no
      BoardGameGeek entry and can't be pushed:
      ${unpushable.map((u) => escapeHtml(u.game_name)).join(", ")}.</p>`;
  }

  function catalogNote(diff) {
    if (!diff.catalog_pending) return "";
    const n = diff.catalog_pending;
    return `<p class="bgg-diff__note">${n} ${n === 1 ? "game" : "games"} new to BgB's catalog
      ${n === 1 ? "is" : "are"} being imported so ${n === 1 ? "it" : "they"} can be listed by
      name. Check again in a moment.</p>`;
  }

  /**
   * @typedef {Object} BggDiffListOpts
   * @property {"card"|"sheet"=} variant
   * @property {"push"|"pull"=} direction  sheet only: which column is written
   * @property {number=} max   card variant only: rows before "…and N more"
   */

  /**
   * @param {any} diff
   * @param {BggDiffListOpts=} opts
   * @returns {string}
   */
  function renderBggDiffList(diff, opts) {
    if (!diff) return "";
    const o = opts || {};
    const variant = o.variant || "card";
    const unpushable = diff.unpushable || [];
    const allRows = buildRows(diff);

    // ── Card: the whole comparison, both directions, no verb ───────────────
    if (variant === "card") {
      const inSync = diff.in_sync_count || 0;
      if (!allRows.length && !unpushable.length) {
        return `<div class="bgg-diff bgg-diff--card">
          <p class="bgg-diff__headline bgg-diff__headline--ok">
            <i data-icon="check" class="w-4 h-4"></i>
            Everything matches — ${inSync} ${inSync === 1 ? "game" : "games"} in sync.
          </p>
        </div>`;
      }
      // push_total is the authoritative count; the row list can be truncated
      // server-side, so never derive "N differences" from allRows.length.
      const total = Math.max(diff.push_total || 0, diff.pull_total || 0, allRows.length);
      const max = o.max || 10;
      const shown = allRows.slice(0, max);
      const hidden = total - shown.length;
      const more = hidden > 0
        ? `<p class="bgg-diff__note">…and ${hidden} more. Either sync button below lists
            every game before it commits.</p>`
        : "";
      return `<div class="bgg-diff bgg-diff--card">
        <p class="bgg-diff__headline">${total} ${total === 1 ? "difference" : "differences"}
          <span class="bgg-diff__insync">${inSync} already in sync</span></p>
        <div class="bgg-cmp__scroll">${table(shown, { direction: null })}</div>
        ${more}
        ${legend(allRows, !diff.truncated)}
        ${catalogNote(diff)}${unpushableNote(unpushable)}
      </div>`;
    }

    // ── Sheet: the same table, with the written column marked ──────────────
    const direction = o.direction === "pull" ? "pull" : "push";
    const rows = allRows.filter((r) => !!r[direction]);
    const total = (direction === "pull" ? diff.pull_total : diff.push_total) || 0;
    const held = rows.filter((r) => r.pull === "held").length;
    const rule = direction === "pull"
      ? `<p class="bgg-cmp__rule">Every row's <b>BgB</b> value is overwritten to match
          <b>BGG</b>${held ? ", except the rows marked <b>kept</b>" : ""}.</p>`
      : `<p class="bgg-cmp__rule">Every row's <b>BGG</b> value is overwritten to match
          <b>BgB</b> — including the rows where BgB has nothing, which come off your
          BGG shelf.</p>`;
    const truncated = diff.truncated
      ? `<p class="bgg-diff__note">Showing the first ${rows.length} of ${total}. All ${total} will be synced.</p>`
      : "";
    const footnote = direction === "pull"
      ? `<p class="bgg-diff__warn">An import never removes anything from your shelf, and never
          resurrects a game you marked Prev. owned — BGG's own flag goes stale in a way your tap
          doesn't.</p>`
      : `<p class="bgg-diff__warn">Cleared games keep their BGG rating, comment and purchase
          details — only the owned, prev-owned and wishlist flags come off.${
            unpushable.length
              ? ` ${unpushable.map((u) => escapeHtml(u.game_name)).join(", ")}
                  ${unpushable.length === 1 ? "has" : "have"} no BGG entry and stay${
                    unpushable.length === 1 ? "s" : ""} behind.`
              : ""
          }</p>`;
    return `<div class="bgg-diff bgg-diff--sheet">
      <div class="bgg-cmp__scroll">${table(rows, { direction })}</div>
      ${rule}${truncated}${footnote}
    </div>`;
  }

  window.renderBggDiffList = renderBggDiffList;
})();
