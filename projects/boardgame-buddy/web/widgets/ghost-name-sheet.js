// @ts-check
// widgets/ghost-name-sheet.js — fix the spelling of a ghost player's name.
//
// A ghost is a name typed at the table, usually in a hurry, usually on a phone:
// "Micheal", "dave", "Sarah " with a trailing space. Every one of those is a
// separate player for ever — it is the join key, so the misspelling splits one
// friend's history in two and there has been no way to say so. The Link button
// beside it answers a different question ("who IS this person"), and its sheet
// only ever offers names that already exist, so the one thing it cannot express
// is the name nobody has typed correctly yet.
//
// This sheet is that one thing: the same name, spelled right. The plays follow
// it — the backend rewrites every row that carries the old spelling — and no
// account is involved on either side, which is the whole difference between
// this and Link.
//
// Typing a name another ghost already has is NOT blocked here. It is the merge
// the user has just asked for in the only words this screen gives them, so the
// sheet says what will happen (the hint under the field, live as they type) and
// the caller confirms it before writing. Refusing it would leave "I meant Dave"
// unsayable in the field that exists precisely to say it.
//
// Built on ui/bottom-sheet.js for the reasons widgets/buddy-alias-sheet.js
// gives at length: the shell owns scroll lock, Escape, focus return, the close
// animation and the device back gesture, and .bgb-sheet already has the
// visible-viewport rules that survive the software keyboard this sheet raises.
// Its class is named in the theme re-point list in styles.css; a body-level
// sheet lands outside the screen that opened it (.claude/rules/theming.md §8).

(function () {
  /**
   * @typedef {Object} GhostNameSheetOpts
   * @property {string} displayName            The ghost's name as it stands.
   * @property {number} [playCount]            Plays carrying that name, for the
   *   sub-line — what the rename is about to move.
   * @property {{name: string, playCount: number}[]} [others]  The viewer's
   *   OTHER ghosts, so typing one of their names can warn that the two are
   *   about to become one player. Names only; this widget never fetches.
   * @property {Element|null} [returnFocus]    Focus goes back here on close.
   * @property {(name: string, mergesInto: {name: string, playCount: number}|null) => void} [onSave]
   *   Fired with the trimmed name, and with the ghost it collides with when it
   *   collides with one. The caller owns the confirm, the write and the
   *   repaint — this widget never touches the network.
   */

  const INPUT_ID = "ghost-name-input";
  const HINT_ID = "ghost-name-hint";
  // Mirrors MAX_IMPORT_NAME_CHARS in the backend's constants.py, which is the
  // ceiling /ghost-players/rename enforces. Stopping the 81st character here
  // beats a 400 the user only meets after tapping Save.
  const MAX_CHARS = 80;

  const sheet = new window.BgbBottomSheet({
    id: "bgb-ghost-name-sheet",
    className: "ghost-name-sheet",
    label: "Fix a player's name",
  });

  /** @type {GhostNameSheetOpts|null} */
  let _opts = null;

  /**
   * The other ghost this typed name would land on, if any. Case-insensitive
   * and trimmed, because that is exactly how the backend matches rows — two
   * spellings differing only in case are already one ghost to it.
   * @param {string} typed
   * @returns {{name: string, playCount: number}|null}
   */
  function collision(typed) {
    const key = typed.trim().toLowerCase();
    if (!key || !_opts) return null;
    // The ghost being renamed is not a collision with itself: a case fix
    // ("dave" → "Dave") is the single most likely edit on this screen.
    if (key === String(_opts.displayName || "").trim().toLowerCase()) return null;
    return (_opts.others || []).find(
      (o) => String(o.name || "").trim().toLowerCase() === key
    ) || null;
  }

  /** @param {string} typed */
  function hintFor(typed) {
    const hit = collision(typed);
    if (!hit) {
      return "Every play with this player updates to the new spelling. Nobody's account is involved — they're still a custom player.";
    }
    const n = hit.playCount || 0;
    return `You already have a player called “${hit.name}”${n ? ` with ${n} ${n === 1 ? "play" : "plays"}` : ""}. Saving puts both under that one name.`;
  }

  /** @param {GhostNameSheetOpts} opts */
  function render(opts) {
    const name = opts.displayName || "";
    const plays = opts.playCount || 0;
    return `
      <div class="bgb-sheet__panel ghost-name-sheet__panel" tabindex="-1">
        <div class="bgb-sheet__grip" aria-hidden="true"></div>
        <h3 class="bgb-sheet__title">Fix this name</h3>
        <p class="bgb-sheet__sub">${plays
          ? `${plays} ${plays === 1 ? "play" : "plays"} logged as “${escapeHtml(name)}”.`
          : `Logged as “${escapeHtml(name)}”.`}</p>

        <div class="ghost-name-sheet__field">
          <input id="${INPUT_ID}" class="input input-bordered ghost-name-sheet__input"
                 type="text" maxlength="${MAX_CHARS}"
                 value="${escapeAttr(name)}"
                 placeholder="Their name"
                 autocomplete="off" autocapitalize="words"
                 autocorrect="off" spellcheck="false"
                 aria-describedby="${HINT_ID}"
                 aria-label="Name for this player" />
          <p id="${HINT_ID}" class="ghost-name-sheet__hint">${escapeHtml(hintFor(name))}</p>
        </div>

        <div class="bgb-sheet__foot">
          <button class="bgb-sheet__confirm" type="button" data-ghost-name-action="save">
            Save
          </button>
        </div>
        <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
      </div>
    `;
  }

  /**
   * Hand the value back and close. Close FIRST, in the shape of the alias
   * sheet's commit(): the caller's own confirm and re-render then land on a
   * screen this sheet has already let go of, rather than under it.
   * @param {string} value
   * @param {{name: string, playCount: number}|null} mergesInto
   */
  function commit(value, mergesInto) {
    const opts = _opts;
    sheet.close();
    if (opts && opts.onSave) opts.onSave(value, mergesInto);
  }

  function save() {
    const input = /** @type {HTMLInputElement|null} */ (
      document.getElementById(INPUT_ID)
    );
    const typed = ((input && input.value) || "").trim();
    const current = String((_opts && _opts.displayName) || "").trim();
    // A blank field is not "delete this player" — there is no such act here,
    // and a ghost with no name is not a row the app can render. Both it and an
    // unchanged name are the user backing out, so they close as Cancel does.
    if (!typed || typed === current) {
      sheet.close();
      return;
    }
    commit(typed, collision(typed));
  }

  /** @param {GhostNameSheetOpts} opts */
  function open(opts) {
    _opts = opts;
    sheet.open({
      html: render(opts),
      label: `Fix the name “${opts.displayName || ""}”`,
      returnFocus: opts.returnFocus || null,
      onClick: (e) => {
        const btn = e.target.closest("[data-ghost-name-action]");
        if (btn && btn.dataset.ghostNameAction === "save") save();
      },
      // No layered Escape, for the same reason as the alias sheet: there is no
      // list underneath to get back to, so clearing the field first would only
      // cost a second press to leave (overlays.md §5).
      onEscape: () => false,
      onOpen: (root) => {
        const panel = root.querySelector(".ghost-name-sheet__panel");
        // The PANEL takes focus, never the input: focusing a text field on open
        // raises the software keyboard over the sheet the instant it lands
        // (overlays.md §5). Tapping the field is the opt-in.
        if (panel && /** @type {HTMLElement} */ (panel).focus) {
          /** @type {HTMLElement} */ (panel).focus({ preventScroll: true });
        }
        const input = root.querySelector("#" + INPUT_ID);
        if (!input) return;
        const hint = root.querySelector("#" + HINT_ID);
        input.addEventListener("input", () => {
          // Live, because the merge it warns about is not visible anywhere
          // else: the names are two rows apart on the screen underneath, and
          // the user typing "Dave" has no reason to look for the other one.
          if (hint) hint.textContent = hintFor(input.value || "");
        });
        input.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter") return;
          ev.preventDefault();
          save();
        });
      },
      onClose: () => { _opts = null; },
    });
  }

  window.GhostNameSheet = { open, close: () => sheet.close() };
})();
