// @ts-check
// widgets/buddy-alias-sheet.js — rename a buddy, for your eyes only.
//
// Two people in your buddy list called "Dave R." are indistinguishable in every
// list the app renders, and the one that actually costs you something is the
// Gather player picker: pick the wrong Dave and the play is logged against the
// wrong person. This sheet sets a PRIVATE alias — stored on the viewer's own
// side of the buddy edge (migration 012), never shown to the person it names.
//
// Opened from three places, all through the same open(): the Buddies row, a
// seated player in Gather, and a player row in the play-detail popup. It takes
// the edge id rather than a user id because that is what the endpoint addresses
// and what the caller already has (or can get from Buddy.edgeIdFor).
//
// A sheet on ui/bottom-sheet.js rather than a fourth hand-rolled modal: the
// shell already owns scroll lock, delegated clicks, Escape, focus return, the
// close animation and the device back gesture, which is exactly the lifecycle
// .claude/rules/overlays.md §7 names the existing bespoke modals as debt for
// re-implementing. It is also the right geometry — this overlay's whole content
// is a text field, so it WILL raise the software keyboard, and .bgb-sheet
// already has the visible-viewport rules that survive one.
//
// Its class is named in the theme re-point list in styles.css; a body-level
// sheet lands outside the screen that opened it (.claude/rules/theming.md §8).

(function () {
  /**
   * @typedef {Object} AliasSheetOpts
   * @property {string} edgeId                 The buddy edge to write.
   * @property {string} displayName            Their REAL display name, always —
   *   the sheet says whose alias this is, and an alias titling its own editor
   *   would leave the user no way back to who they actually renamed.
   * @property {string|null} [alias]           The alias already set, if any.
   * @property {Element|null} [returnFocus]    Focus goes back here on close.
   * @property {(alias: string|null) => void} [onSave]  Fired with the trimmed
   *   value, or null for a clear. The caller owns the write and the repaint —
   *   this widget never touches the network, so the three hosts keep their own
   *   optimistic + rollback shape.
   */

  const INPUT_ID = "buddy-alias-input";
  // Matches MAX_BUDDY_ALIAS_CHARS in the backend's constants.py. A longer value
  // is rejected there with a 400; this stops the user typing one in the first
  // place rather than letting them find out on save.
  const MAX_CHARS = 60;

  const sheet = new window.BgbBottomSheet({
    id: "bgb-buddy-alias-sheet",
    className: "alias-sheet",
    label: "Rename a buddy",
  });

  /** @type {AliasSheetOpts|null} */
  let _opts = null;

  /** @param {AliasSheetOpts} opts */
  function render(opts) {
    const name = escapeHtml(opts.displayName || "this buddy");
    const current = opts.alias || "";
    return `
      <div class="bgb-sheet__panel alias-sheet__panel" tabindex="-1">
        <div class="bgb-sheet__grip" aria-hidden="true"></div>
        <h3 class="bgb-sheet__title">Rename ${name}</h3>
        <p class="bgb-sheet__sub">Only you see this. ${name} is never told.</p>

        <div class="alias-sheet__field">
          <input id="${INPUT_ID}" class="input input-bordered alias-sheet__input"
                 type="text" maxlength="${MAX_CHARS}"
                 value="${escapeAttr(current)}"
                 placeholder="e.g. Tuesday Dave"
                 autocomplete="off" autocapitalize="words"
                 autocorrect="off" spellcheck="false"
                 aria-label="Private alias for ${escapeAttr(opts.displayName || "this buddy")}" />
          <p class="alias-sheet__hint">
            Shown instead of their name on your buddies list, the player picker
            and your plays. Their account keeps its real name everywhere else.
          </p>
        </div>

        <div class="bgb-sheet__foot alias-sheet__foot">
          <button class="bgb-sheet__confirm" type="button" data-alias-action="save">
            Save
          </button>
          ${current ? `
            <button class="alias-sheet__remove" type="button" data-alias-action="remove">
              Remove alias
            </button>
          ` : ""}
        </div>
        <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
      </div>
    `;
  }

  /**
   * Hand the value back and close. Close FIRST, in the shape of the player
   * picker's _answer(): the caller's own re-render then lands on a screen the
   * sheet has already let go of, rather than under it.
   * @param {string|null} value
   */
  function commit(value) {
    const opts = _opts;
    sheet.close();
    if (opts && opts.onSave) opts.onSave(value);
  }

  function save() {
    const input = /** @type {HTMLInputElement|null} */ (
      document.getElementById(INPUT_ID)
    );
    const typed = ((input && input.value) || "").trim();
    // An emptied field and the Remove button are the same act — the backend
    // treats null and blank identically, so the UI must not invent a
    // difference the storage doesn't have.
    commit(typed || null);
  }

  /** @param {AliasSheetOpts} opts */
  function open(opts) {
    _opts = opts;
    sheet.open({
      html: render(opts),
      label: `Rename ${opts.displayName || "buddy"}`,
      returnFocus: opts.returnFocus || null,
      onClick: (e) => {
        const btn = e.target.closest("[data-alias-action]");
        if (!btn) return;
        if (btn.dataset.aliasAction === "save") save();
        else if (btn.dataset.aliasAction === "remove") commit(null);
      },
      // No layered Escape. The first press closes, because there is no list
      // underneath to get back to — clearing the field first is the behaviour
      // a SEARCH sheet wants (overlays.md §5), and here it would cost a second
      // press to leave a sheet whose only state is one half-typed word.
      onEscape: () => false,
      onOpen: (root) => {
        const panel = root.querySelector(".alias-sheet__panel");
        // The PANEL takes focus, never the input: focusing a text field on open
        // raises the software keyboard over the sheet the instant it lands
        // (overlays.md §5). Tapping the field is the opt-in.
        if (panel && /** @type {HTMLElement} */ (panel).focus) {
          /** @type {HTMLElement} */ (panel).focus({ preventScroll: true });
        }
        const input = root.querySelector("#" + INPUT_ID);
        if (input) {
          input.addEventListener("keydown", (ev) => {
            if (ev.key !== "Enter") return;
            ev.preventDefault();
            save();
          });
        }
      },
      onClose: () => { _opts = null; },
    });
  }

  window.BuddyAliasSheet = { open, close: () => sheet.close() };
})();
