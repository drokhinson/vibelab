// widgets/release-notice-editor.js — writing ONE release notice.
//
// INLINE ON THE SPOKE, NOT A MODAL, and that is the whole reason this is its
// own file rather than a PolaroidPopup call. A markdown textarea inside a
// centred card fights the software keyboard exactly the way overlays.md §4
// describes — the card is sized against the layout viewport, the keyboard
// shrinks only the visual one, and the overhang goes off the TOP, carrying the
// title field with it. And overlays.md §5 forbids focusing a text input on
// open, which would leave a modal editor you must tap into before you can type.
// Inline, the editor replaces the spoke's list and the screen's own back is
// the way out.
//
// The seam with views/admin-release-notices-view.js: that file owns the SCREEN
// (route, gate, list, filter, refresh), this one owns ONE NOTICE. Same
// host-callback contract widgets/admin-backfill-panel.js uses, so the inline
// handlers below name window.adminReleaseNoticesView.

(function () {
  const HOST = "window.adminReleaseNoticesView";

  // Debounce the live preview. A preview that re-renders on every keystroke of
  // an 8000-character body is work nobody asked for, and the pause is what
  // makes it read as "it caught up" rather than as flicker.
  const PREVIEW_MS = 220;
  let _previewTimer = null;

  let _sheet = null;
  // Mirrors the server's caps (api/routes/constants.py). Stated here so the
  // counter can warn before the request rather than after the 422.
  const MAX_TITLE = 120;
  const MAX_BODY = 8000;

  function _val(sel) {
    const el = document.querySelector(sel);
    return el ? el.value : "";
  }

  /** The notice as it stands in the form, not as it was loaded. */
  function _draft() {
    const route = document.querySelector("#rel-ed-route");
    return {
      title: _val("#rel-ed-title").trim(),
      body_md: _val("#rel-ed-body").trim(),
      link_route: (route && route.dataset.route) || "",
      link_label: _val("#rel-ed-label").trim(),
    };
  }

  function render(notice) {
    const n = notice || {};
    const isNew = !n.id;
    const live = !!n.published_at;
    const routeLabel = n.link_route || "No link";
    return `
      <div class="rel-ed">
        <div class="rel-ed__head">
          <h3 class="rel-ed__heading font-display">
            ${isNew ? "New notice" : live ? "Edit published notice" : "Edit draft"}
          </h3>
          ${live
            ? `<p class="rel-ed__note">
                 Edits don't re-show it. Anyone who's already read this one won't
                 see it again; anyone who hasn't gets the corrected version.
               </p>`
            : ""}
        </div>

        <label class="rel-ed__label" for="rel-ed-title">Title</label>
        <input class="rel-ed__input" id="rel-ed-title" type="text"
               maxlength="${MAX_TITLE}" placeholder="Scoring grids for any game"
               value="${escapeAttr(n.title || "")}" />

        <label class="rel-ed__label" for="rel-ed-body">What changed</label>
        <textarea class="rel-ed__textarea" id="rel-ed-body" rows="8"
                  maxlength="${MAX_BODY}"
                  placeholder="A couple of sentences, or a short list. Say what they can do now, not what you built.">${escapeHtml(n.body_md || "")}</textarea>
        <div class="rel-ed__hint">
          Markdown: <code>**bold**</code>, <code>*italic*</code>, <code>-</code> lists,
          <code>##</code> headings. Links here open a new tab — for somewhere
          inside the app, use the button below instead.
        </div>

        <label class="rel-ed__label">Take me there (optional)</label>
        <div class="rel-ed__linkrow">
          <button class="rel-ed__route" id="rel-ed-route" type="button"
                  data-route="${escapeAttr(n.link_route || "")}"
                  onclick="${HOST}._pickRoute()">
            <span data-route-label>${escapeHtml(routeLabel)}</span>
            <i data-icon="chevron-right" class="w-4 h-4"></i>
          </button>
          <input class="rel-ed__input rel-ed__input--label" id="rel-ed-label" type="text"
                 maxlength="40" placeholder="Button text"
                 value="${escapeAttr(n.link_label || "")}" />
        </div>

        <div class="rel-ed__previewhead">Preview</div>
        <div class="polaroid-popup__card rel-ed__preview" id="rel-ed-preview">
          ${window.ReleaseNoticeBody.render(_previewOf(n))}
        </div>

        <div class="rel-ed__actions">
          <button class="btn btn-ghost" onclick="${HOST}._cancelEdit()">Cancel</button>
          <button class="btn btn-primary" onclick="${HOST}._saveEdit()">
            ${isNew ? "Save draft" : "Save"}
          </button>
        </div>
      </div>
    `;
  }

  /** A notice-shaped object for the preview, stamped so the date line is real. */
  function _previewOf(src) {
    return {
      title: src.title || "Untitled",
      body_md: src.body_md || "",
      link_route: src.link_route || null,
      link_label: src.link_label || null,
      published_at: src.published_at || new Date().toISOString(),
    };
  }

  /**
   * Wire the form up after a paint.
   *
   * The preview is patched on its own host and NOTHING else is touched — the
   * author is typing into this screen, and re-rendering the panel would take
   * the textarea, its focus and its caret with it (overlays.md §6).
   */
  function bind(view) {
    const repaint = () => {
      const host = document.querySelector("#rel-ed-preview");
      if (!host) return;
      host.innerHTML = window.ReleaseNoticeBody.render(_previewOf(_draft()));
      window.BgbIcons.render(host);
    };
    const schedule = () => {
      if (_previewTimer) clearTimeout(_previewTimer);
      _previewTimer = setTimeout(repaint, PREVIEW_MS);
    };
    ["#rel-ed-title", "#rel-ed-body", "#rel-ed-label"].forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) el.addEventListener("input", schedule);
    });
    // Deliberately NOT focusing anything: the author tapped Edit to read what
    // is there as often as to change it, and raising the keyboard over the
    // preview on open would bury the thing the preview exists to show.
    view._editorRepaint = repaint;
  }

  /**
   * Pick the in-app destination.
   *
   * A bottom sheet rather than a <select> or an absolute dropdown
   * (overlays.md §1), opened inline because there is exactly one consumer —
   * the same call achievements-view makes.
   *
   * The options come from router.routeNames(), never a hand-kept list: a typed
   * or stale route name makes pathFor() return null and the button silently go
   * nowhere, in production, on the notice announcing the feature it points at.
   */
  function pickRoute(view) {
    if (!_sheet) {
      _sheet = new window.BgbBottomSheet({
        id: "bgb-rel-route-sheet",
        className: "rel-route-sheet",
        label: "Where should the button go?",
      });
    }
    const btn = document.querySelector("#rel-ed-route");
    const current = (btn && btn.dataset.route) || "";
    const names = (window.router.routeNames && window.router.routeNames()) || [];

    const row = (value, label) => `
      <button class="bgb-sheet__row rel-route-sheet__row" type="button" role="option"
              aria-selected="${value === current}" data-route="${escapeAttr(value)}">
        <span>${escapeHtml(label)}</span>
        ${value === current ? '<i data-icon="check" class="w-4 h-4"></i>' : ""}
      </button>`;

    _sheet.open({
      returnFocus: btn,
      html: `
        <div class="rel-route-sheet__panel bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <div class="bgb-sheet__title font-display">Take me there</div>
          <div class="bgb-sheet__sub">Where the button sends the reader.</div>
          <div class="bgb-sheet__list" role="listbox">
            ${row("", "No link")}
            ${names.map((n) => row(n, n)).join("")}
          </div>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
        </div>
      `,
      onClick: (e) => {
        const hit = e.target.closest && e.target.closest("[data-route]");
        if (!hit) return;
        const value = hit.dataset.route || "";
        if (btn) {
          btn.dataset.route = value;
          const label = btn.querySelector("[data-route-label]");
          if (label) label.textContent = value || "No link";
        }
        _sheet.close();
        if (view && view._editorRepaint) view._editorRepaint();
      },
      onOpen: (root) => {
        // The current selection takes focus, so a screen reader hears where it
        // stands before the alternatives (overlays.md §5).
        const sel = root.querySelector('[aria-selected="true"]');
        if (sel) {
          try { sel.focus(); } catch (_) {}
        }
      },
    });
  }

  /**
   * Read the form, validate, and write. Returns the payload the view sends, or
   * null when it should not send at all.
   */
  function collect() {
    const d = _draft();
    if (!d.title) {
      showToast("Give it a title", "error");
      return null;
    }
    if (!d.body_md) {
      showToast("Say what changed", "error");
      return null;
    }
    return {
      title: d.title,
      body_md: d.body_md,
      link_route: d.link_route || null,
      link_label: d.link_route ? d.link_label || null : null,
    };
  }

  window.ReleaseNoticeEditor = { render, bind, pickRoute, collect };
})();
