// ui/bgg-diff-list.js — the BgB <-> BGG comparison, rendered.
//
// One renderer, two variants, because there are two surfaces from day one:
//   "card"  the inline result under Check status — counts and a few names
//   "sheet" the review list inside a sync sheet — every row, grouped
//
// THEMING: both surfaces are paper. Settings is .bgb-spoke-screen and
// .bgb-sheet__panel is background: var(--polaroid-bg), which is light in BOTH
// themes. Everything here reads polaroid tokens; never oklch(var(--b1)) and
// never --accent-hover as ink (.claude/rules/theming.md §6).

(function () {
  // BgB's status vocabulary and BGG's flag names are NOT the same words. The
  // push writes flags, so a push row reads in BGG's language; the pull writes
  // shelf rows, so a pull row reads in BgB's.
  const BGG_FLAG = { owned: "own", prev_owned: "prevowned", wishlist: "wishlist" };
  const BGB_LABEL = { owned: "Owned", prev_owned: "Prev. owned", wishlist: "Wishlist" };

  const PUSH_GROUPS = [
    { key: "add",    tone: "add",   label: "Add to your BGG collection" },
    { key: "update", tone: "change", label: "Change status there" },
    { key: "clear",  tone: "clear", label: "Clear from your BGG shelf" },
  ];
  const PULL_GROUPS = [
    { key: "add",    tone: "add",   label: "Add to your BgB shelf" },
    { key: "update", tone: "change", label: "Overwrite status in BgB" },
    // Not a change — a refusal to make one. It must not wear the destructive
    // stripe, or the sheet reads as though it is about to delete the thing it
    // is promising to keep.
    { key: "held",   tone: "held",  label: "Protected — kept as you set it" },
  ];

  function pushMove(item) {
    const to = BGG_FLAG[item.local_status] || item.local_status;
    if (item.change === "clear") return `clear <em>${escapeHtml(BGG_FLAG[item.remote_status] || "")}</em>`;
    if (item.change === "add") return `add <em>${escapeHtml(to)}</em>`;
    return `${escapeHtml(BGG_FLAG[item.remote_status] || "")} &rarr; <em>${escapeHtml(to)}</em>`;
  }

  function pullMove(item) {
    const to = BGB_LABEL[item.remote_status] || item.remote_status;
    if (item.change === "held") return `stays <em>${escapeHtml(BGB_LABEL[item.local_status] || "")}</em>`;
    if (item.change === "add") return `as <em>${escapeHtml(to)}</em>`;
    return `${escapeHtml(BGB_LABEL[item.local_status] || "")} &rarr; <em>${escapeHtml(to)}</em>`;
  }

  function row(item, moveFn) {
    const tag = item.newly_catalogued
      ? `<span class="bgg-diff__new" title="Imported into BgB's catalog by this check">new</span>`
      : "";
    return `<li class="bgg-diff__row">
      <span class="bgg-diff__game">${escapeHtml(item.game_name || "Untitled")}${tag}</span>
      <span class="bgg-diff__move">${moveFn(item)}</span>
    </li>`;
  }

  function group(def, items, moveFn) {
    if (!items.length) return "";
    return `<div class="bgg-diff__group bgg-diff__group--${def.tone}">
      <div class="bgg-diff__group-hd">
        <span class="bgg-diff__stripe"></span>
        <span class="bgg-diff__group-label">${def.label}</span>
        <span class="bgg-diff__group-n">${items.length}</span>
      </div>
      <ul class="bgg-diff__list">${items.map((i) => row(i, moveFn)).join("")}</ul>
    </div>`;
  }

  /**
   * @typedef {Object} BggDiffListOpts
   * @property {"card"|"sheet"=} variant
   * @property {"push"|"pull"=} direction  which half of the comparison to show
   * @property {number=} max   card variant only: names before "…and N more"
   */

  /**
   * @param {BggDiffResponse|null} diff
   * @param {BggDiffListOpts=} opts
   * @returns {string}
   */
  function renderBggDiffList(diff, opts) {
    if (!diff) return "";
    const o = opts || {};
    const direction = o.direction || "push";
    const isPull = direction === "pull";
    const items = (isPull ? diff.pull_changes : diff.push_changes) || [];
    const total = (isPull ? diff.pull_total : diff.push_total) || 0;
    const defs = isPull ? PULL_GROUPS : PUSH_GROUPS;
    const moveFn = isPull ? pullMove : pushMove;
    const unpushable = diff.unpushable || [];

    // ── Card: a summary, not a list ────────────────────────────────────────
    if ((o.variant || "card") === "card") {
      const inSync = diff.in_sync_count || 0;
      if (!total && !unpushable.length) {
        return `<div class="bgg-diff bgg-diff--card">
          <p class="bgg-diff__headline bgg-diff__headline--ok">
            <i data-icon="check" class="w-4 h-4"></i>
            Everything matches — ${inSync} ${inSync === 1 ? "game" : "games"} in sync.
          </p>
        </div>`;
      }
      const counts = defs
        .map((d) => ({ d, n: items.filter((i) => i.change === d.key).length }))
        .filter((c) => c.n > 0)
        .map((c) => `<span class="bgg-diff__count bgg-diff__count--${c.d.tone}">
            <span class="bgg-diff__stripe"></span>${c.n} to ${c.d.key}
          </span>`)
        .join("");
      const max = o.max || 6;
      const names = items.slice(0, max).map((i) => escapeHtml(i.game_name)).join(", ");
      const more = total > max ? ` and ${total - max} more` : "";
      const catalogNote = diff.catalog_pending
        ? `<p class="bgg-diff__note">${diff.catalog_pending} ${diff.catalog_pending === 1 ? "game" : "games"}
            new to BgB's catalog ${diff.catalog_pending === 1 ? "is" : "are"} being imported so
            ${diff.catalog_pending === 1 ? "it" : "they"} can be listed by name. Check again in a moment.</p>`
        : "";
      const unpushNote = unpushable.length
        ? `<p class="bgg-diff__note">${unpushable.length}
            ${unpushable.length === 1 ? "game has" : "games have"} no BoardGameGeek entry and
            can't be pushed: ${unpushable.map((u) => escapeHtml(u.game_name)).join(", ")}.</p>`
        : "";
      return `<div class="bgg-diff bgg-diff--card">
        <p class="bgg-diff__headline">${total} ${total === 1 ? "difference" : "differences"}
          <span class="bgg-diff__insync">${inSync} already in sync</span></p>
        <div class="bgg-diff__counts">${counts}</div>
        ${names ? `<p class="bgg-diff__names">${names}${more}.</p>` : ""}
        ${catalogNote}${unpushNote}
      </div>`;
    }

    // ── Sheet: every row, grouped ──────────────────────────────────────────
    const groups = defs.map((d) => group(d, items.filter((i) => i.change === d.key), moveFn)).join("");
    const truncated = diff.truncated
      ? `<p class="bgg-diff__note">Showing the first ${items.length} of ${total}. All ${total} will be synced.</p>`
      : "";
    const footnote = isPull
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
    return `<div class="bgg-diff bgg-diff--sheet">${groups}${truncated}${footnote}</div>`;
  }

  window.renderBggDiffList = renderBggDiffList;
})();
