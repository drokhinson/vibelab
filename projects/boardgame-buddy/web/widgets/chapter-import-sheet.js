// @ts-check
// widgets/chapter-import-sheet.js — "import a file into this chapter" sheet.
//
// Opened from the upload button in the chapter editor's toolbar
// (views/reference-guide-add-view.js). Picking a file hands it straight back to
// the caller, which parses it and fills the editor; this file never touches the
// form.
//
// Lifecycle — backdrop, scroll lock, Escape, the device back gesture, focus
// return — is all ui/bottom-sheet.js. What lives here is the panel markup, and
// the only class it needs of its own: the panel, grip, title, sub and cancel
// are the shared .bgb-sheet__* chrome, so the one bespoke rule is the
// choose-a-file row. Per .claude/rules/ui-object-design.md §4.

(function () {
  /** @type {any} */
  let sheet = null;

  const ChapterImportSheet = {
    /**
     * @param {{ onFile: (file: File) => void, returnFocus?: Element|null }} opts
     *   onFile — called with the picked File; the sheet closes itself first, so
     *   a confirm or a re-render in the handler can't fight the close animation.
     */
    open(opts) {
      if (!sheet) {
        sheet = new window.BgbBottomSheet({
          id: "bgb-chapter-import-sheet",
          className: "chapter-import-sheet",
          label: "Import a chapter file",
        });
      }

      sheet.open({
        returnFocus: opts.returnFocus || null,
        html: `
          <div class="bgb-sheet__panel chapter-import-sheet__panel">
            <div class="bgb-sheet__grip" aria-hidden="true"></div>
            <h3 class="bgb-sheet__title">Import a file</h3>
            <p class="bgb-sheet__sub">
              Pick a <b>.md</b> or <b>.txt</b> file and its text drops straight
              into the editor. A first line starting with <code># </code>
              becomes the chapter title.
            </p>

            <label class="chapter-import-sheet__pick" id="chapter-import-pick" tabindex="0">
              <input type="file" accept=".md,.txt,text/markdown,text/plain" />
              <i data-icon="upload" class="w-5 h-5"></i>
              <span>Choose a file</span>
            </label>

            <button type="button" class="bgb-sheet__cancel" data-action="close">Cancel</button>
          </div>
        `,
        onOpen(root) {
          const pick = root.querySelector("#chapter-import-pick");
          // The row, never the file input: focusing a control that opens the
          // system file picker on open would fire it unasked, and the sheet
          // must not raise anything over itself (.claude/rules/overlays.md §5).
          if (pick) {
            try { /** @type {any} */ (pick).focus(); } catch (_) {}
          }

          const input = root.querySelector('input[type="file"]');
          if (!input) return;
          input.addEventListener("change", (ev) => {
            const t = /** @type {any} */ (ev.target);
            const file = t && t.files && t.files[0];
            if (!file) return;
            ChapterImportSheet.close();
            opts.onFile(file);
          });
          // A label wrapping the input already forwards a click; the keyboard
          // path does not, so Enter/Space on the focused row opens the picker.
          if (pick) {
            pick.addEventListener("keydown", (ev) => {
              const k = /** @type {any} */ (ev).key;
              if (k !== "Enter" && k !== " ") return;
              ev.preventDefault();
              /** @type {any} */ (input).click();
            });
          }
        },
      });
    },

    close() {
      if (sheet) sheet.close();
    },

    get isOpen() {
      return !!(sheet && sheet.isOpen);
    },
  };

  window.ChapterImportSheet = ChapterImportSheet;
})();
