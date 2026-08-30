// @ts-check
// widgets/game-search-sheet.js — the library search, in a bottom sheet.
//
// Distinct from widgets/game-picker-sheet.js, which filters a list the caller
// already holds in memory. This one hosts the real widgets/game-finder.js:
// debounced /search calls, the stale-response token, the BoardGameGeek
// escalation and import, and the offline "on this device" branch all keep
// working exactly as they do inline — the sheet only changes where they are
// drawn.
//
// Why: on Gather the finder's dropdown is position:absolute, so it has to be
// measured and clamped by ui/dropdown-fit.js against whatever space happens to
// be below the input. Mounted here with `inlineDropdown`, the results are an
// ordinary block inside a panel that is already sized off --bgb-vv-h, so the
// list is as tall as the screen allows, the keyboard shrinks it correctly, and
// there is no fit pass and no flip.
//
// The shell is ui/bottom-sheet.js and the panel chrome is the shared
// .bgb-sheet__* family.

(function () {
  const MOUNT_SEL = "[data-finder-mount]";

  /**
   * @typedef {Object} GameSearchOpts
   * @property {(game: any, ctx: any) => any} onPick  Same contract as
   *   GameFinder's: return `{refuse, reason}` to keep the sheet open with the
   *   row showing `reason`; anything else closes it.
   * @property {string} [title]
   * @property {string} [placeholder]
   * @property {(err: Error) => void} [onError]
   * @property {Element|null} [returnFocus]
   */

  class GameSearchSheet {
    constructor() {
      this._finder = /** @type {any} */ (null);
      this._sheet = new window.BgbBottomSheet({
        id: "bgb-game-search-sheet",
        className: "game-search-sheet",
        label: "Pick a game",
      });
    }

    /** @param {GameSearchOpts} opts */
    open(opts) {
      const title = opts.title || "Pick a game";

      this._sheet.open({
        html: `
          <div class="bgb-sheet__panel">
            <div class="bgb-sheet__grip" aria-hidden="true"></div>
            <h3 class="bgb-sheet__title">${escapeHtml(title)}</h3>
            <div class="bgb-sheet__finder" data-finder-mount></div>
            <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
          </div>
        `,
        label: title,
        returnFocus: opts.returnFocus || null,
        onOpen: (root) => {
          const mount = root.querySelector(MOUNT_SEL);
          if (!mount) return;
          this._finder = new window.GameFinder({
            placeholder: opts.placeholder || "Search for a game…",
            includeRecentlyPlayed: true,
            inlineDropdown: true,
            onError: opts.onError,
            onPick: async (game, ctx) => {
              const res = await opts.onPick(game, ctx);
              // The refusal contract is the finder's: hand it straight back so
              // the row can show its reason and the sheet stays put.
              if (res && res.refuse) return res;
              // Next tick, so the finder finishes its own post-pick teardown
              // against nodes that still exist.
              setTimeout(() => this.close(), 0);
              return res;
            },
          });
          this._finder.mount(/** @type {HTMLElement} */ (mount));
          // Focus opens the finder's list, which is the recently-played seed
          // on an empty query — the sheet lands showing something useful.
          this._finder.focus();
        },
        onClose: () => {
          // unmount() also invalidates any in-flight search, so a late
          // response can't resolve against a sheet that is gone.
          if (this._finder) {
            try { this._finder.unmount(); } catch (_) {}
            this._finder = null;
          }
        },
      });
    }

    close() {
      this._sheet.close();
    }

    isOpen() {
      return this._sheet.isOpen;
    }
  }

  window.GameSearchSheet = new GameSearchSheet();
})();
