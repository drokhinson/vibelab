// widgets/expansion-tree.js — the Collection spoke's Expansions tab: a
// two-level list of base game → the expansions you own, with a per-group
// affordance for adding another.
//
// Render + surgical patching only. The grouping is domain/expansion-tree.js;
// the add flow lives in views/collection-view.js, which owns the optimistic
// write.
//
// In "show all" mode a group lists every expansion BgB has for that base game.
// The ones you don't own are dimmed and carry a + that adds them in place, so
// the row is both the answer to "what else is there" and the way to get it.
//
// Rows carry no expansion-colour dot. That colour is an identity marker whose
// job is attribution somewhere else — a rule in the reference-guide scroll, an
// expansion chip on the Gather screen — and it has nothing to attribute here,
// where the name is already on the row. The space goes to owned-vs-not.
//
// Both levels render through window.renderGamePolaroid's "row" variant
// (.claude/rules/ui-object-design.md §2) rather than a bespoke tile — the
// audit in Docs/UI_AUDIT.md already counts six of those and this would have
// been the seventh.
//
// Accessibility is the disclosure pattern (aria-expanded + aria-controls), not
// role="tree". A real tree obliges full roving-tabindex keyboard handling
// (arrows, Home/End, typeahead), and a half-built one is worse for screen
// reader users than none; WAI-ARIA APG recommends disclosure for a flat
// two-level hierarchy like this.

// @ts-check

(function () {
  // 130 rows x 40ms would run a 5.2s entrance. The stagger reads as one
  // gesture over the first dozen and adds nothing after that.
  const MAX_STAGGER = 12;

  function _groupKey(group) {
    return String(group.baseId);
  }

  /** The base game's header row — disclosure only; it does not navigate. */
  function _renderHead(group, open, i) {
    const key = _groupKey(group);
    const tally = group.canAdd
      ? `${group.ownedCount} of ${group.catalogCount}`
      : `${group.ownedCount}`;
    // The orphan bucket has no base game to show, so it gets a plain label.
    const body = group.base
      ? window.renderGamePolaroid(group.base.game, {
          variant: "row",
          showStatus: false,
          interactive: false,
          meta: "",
        })
      : `<span class="exp-tree__orphan-label">${escapeHtml(group.name)}</span>`;
    return `
      <button type="button" class="exp-tree__head"
              aria-expanded="${open}" aria-controls="exp-group-${escapeAttr(key)}"
              data-exp-toggle="${escapeAttr(key)}">
        <i data-icon="chevron-right" class="w-4 h-4 exp-tree__chev"></i>
        ${body}
        <span class="exp-tree__tally">${escapeHtml(tally)}</span>
      </button>`;
  }

  function _renderKid(kid, baseName) {
    const g = (kid && kid.game) || {};
    // The group header already says the base game, so the leaf drops the
    // prefix — the same trim the game page's expansion reel does.
    const label = baseName ? stripBaseGameName(g.name, baseName) : g.name;
    // An unowned row still navigates: opening the game page is how you decide
    // whether you want it. The + is a separate target so the two don't fight.
    const add = kid.owned ? "" : `
        <button type="button" class="exp-tree__own"
                data-exp-add-one="${escapeAttr(g.id || "")}"
                aria-label="Add ${escapeAttr(label || g.name || "")} to your collection">
          <i data-icon="plus" class="w-4 h-4"></i>
        </button>`;
    return `
      <li class="exp-tree__child${kid.owned ? "" : " exp-tree__child--unowned"}">
        ${window.renderGamePolaroid({ ...g, name: label }, {
          variant: "row",
          showStatus: false,
          meta: "",
          clickHandler: `window.router.go('game-detail',{gameId:'${jsStr(g.id || "")}',gameName:'${jsStr(g.name || "")}'})`,
        })}
        ${add}
      </li>`;
  }

  function _renderGroup(group, open, i, showAll) {
    const key = _groupKey(group);
    const kids = group.kids.map((k) => _renderKid(k, group.base ? group.name : "")).join("");
    // Showing all, the catalog is already on screen with a + on each unowned
    // row, so the picker would just repeat it — the only thing left to reach
    // is what BgB doesn't have yet. Showing owned only, the picker IS how you
    // see the rest, and it carries the same BGG route inside itself.
    const addRow = !group.canAdd ? "" : (showAll
      ? `<li class="exp-tree__add-row">
           <button type="button" class="exp-tree__add" data-exp-import="${escapeAttr(key)}">
             <i data-icon="download" class="w-4 h-4"></i><span>Import from BoardGameGeek</span>
           </button>
         </li>`
      : `<li class="exp-tree__add-row">
           <button type="button" class="exp-tree__add" data-exp-add="${escapeAttr(key)}">
             <i data-icon="plus" class="w-4 h-4"></i><span>Add expansion</span>
           </button>
         </li>`);
    return `
      <li class="exp-tree__group" style="--i:${Math.min(i, MAX_STAGGER)}">
        ${_renderHead(group, open, i)}
        <ul class="exp-tree__children" id="exp-group-${escapeAttr(key)}" ${open ? "" : "hidden"}>
          ${kids}
          ${addRow}
        </ul>
      </li>`;
  }

  /**
   * @param {{groups: any[]}} tree
   * @param {{open?: Object<string, boolean>, showAll?: boolean}} [opts]
   */
  function renderExpansionTree(tree, { open = {}, showAll = false } = {}) {
    const groups = (tree && tree.groups) || [];
    if (!groups.length) return "";
    return `
      <ul class="exp-tree">
        ${groups.map((g, i) => _renderGroup(g, !!open[_groupKey(g)], i, showAll)).join("")}
      </ul>`;
  }

  /**
   * Flip one group open/closed without repainting the tree. A full re-render
   * on every disclosure tap is the "laggy / it reloaded" feel that
   * .claude/rules/web-frontend.md calls out, and it would also drop the
   * scroll position under the user's thumb.
   */
  function toggleGroup(root, key, open) {
    if (!root) return;
    const head = root.querySelector(`[data-exp-toggle="${CSS.escape(String(key))}"]`);
    const kids = root.querySelector(`#exp-group-${CSS.escape(String(key))}`);
    if (head) head.setAttribute("aria-expanded", String(!!open));
    if (kids) kids.hidden = !open;
  }

  window.renderExpansionTree = renderExpansionTree;
  window.expansionTreeToggle = toggleGroup;
})();
