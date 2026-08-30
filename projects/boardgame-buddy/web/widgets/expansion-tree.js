// widgets/expansion-tree.js — the Collection spoke's Expansions tab: a
// two-level list of base game → the expansions you own, with a per-group
// affordance for adding another.
//
// Render + surgical patching only. The rows come from ExpansionShelf
// (domain/expansion-tree.js does the grouping); the add flow lives in
// views/collection-view.js, which owns the optimistic write.
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
      ? `${group.kids.length} of ${group.catalogCount}`
      : `${group.kids.length}`;
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

  function _renderKid(item, baseName) {
    const g = (item && item.game) || {};
    // The group header already says the base game, so the leaf drops the
    // prefix — the same trim the game page's expansion reel does.
    const label = baseName ? stripBaseGameName(g.name, baseName) : g.name;
    const dot = g.expansion_color
      ? `<span class="exp-tree__dot" style="background:${escapeAttr(g.expansion_color)}"></span>`
      : `<span class="exp-tree__dot exp-tree__dot--none"></span>`;
    return `
      <li class="exp-tree__child">
        ${dot}
        ${window.renderGamePolaroid({ ...g, name: label }, {
          variant: "row",
          showStatus: false,
          meta: "",
          clickHandler: `window.router.go('game-detail',{gameId:'${jsStr(g.id || "")}',gameName:'${jsStr(g.name || "")}'})`,
        })}
      </li>`;
  }

  function _renderGroup(group, open, i) {
    const key = _groupKey(group);
    const kids = group.kids.map((k) => _renderKid(k, group.base ? group.name : "")).join("");
    const addRow = group.canAdd
      ? `<li class="exp-tree__add-row">
           <button type="button" class="exp-tree__add" data-exp-add="${escapeAttr(key)}">
             <i data-icon="plus" class="w-4 h-4"></i><span>Add expansion</span>
           </button>
         </li>`
      : "";
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
   * @param {{open?: Object<string, boolean>}} [opts]
   */
  function renderExpansionTree(tree, { open = {} } = {}) {
    const groups = (tree && tree.groups) || [];
    if (!groups.length) return "";
    return `
      <ul class="exp-tree">
        ${groups.map((g, i) => _renderGroup(g, !!open[_groupKey(g)], i)).join("")}
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
