// ui/admin-gate.js — the bits every admin spoke shares.
//
// Three screens now sit behind Settings → Admin tools, and each one needs the
// same two things: a guard that refuses non-admins, and a spoke header that
// walks back to Settings. Extracted at instance #2 rather than pasted three
// times (ui-object-design.md §4), and split the way that rule says to — this
// owns the LIFECYCLE (who may see the screen, where back goes), not how any
// spoke's body looks.
//
// The guard is a usability gate, not a security boundary: every admin endpoint
// re-checks is_admin server-side via get_current_admin. This just stops a
// non-admin who deep-links /admin/images from staring at admin chrome whose
// every fetch 403s.

(function () {
  const AdminGate = {
    /** Is the signed-in user an admin? */
    allowed() {
      const me = window.store.get("user");
      return !!(me && me.is_admin);
    },

    /**
     * The refusal markup, or null when the viewer may proceed.
     *
     * Every admin spoke's render() starts by painting this if non-null. It is
     * deliberately NOT a one-shot paint from onMount: View#mount() calls
     * render() unconditionally after onMount() resolves, so a refusal written
     * during onMount is immediately overwritten by the screen it was meant to
     * replace. (The old combined admin-view.js had exactly that bug — a
     * non-admin who deep-linked /admin got the admin chrome, and only the
     * failing fetches behind it hinted otherwise.) Gating inside render()
     * makes the check hold for every repaint, not just the first.
     */
    refusal() {
      if (AdminGate.allowed()) return null;
      return `
        <div class="p-6 text-center">
          <p class="opacity-60 mb-3">Admin access required.</p>
          <button class="btn btn-primary" onclick="window.router.go('feed')">Back to feed</button>
        </div>
      `;
    },

    /**
     * Paint the refusal into `view` and return true when the viewer isn't an
     * admin. The one line every admin spoke's render() opens with.
     */
    block(view) {
      const html = AdminGate.refusal();
      if (!html) return false;
      view.container.innerHTML = html;
      view.refreshIcons();
      return true;
    },

    /**
     * The spoke header. A back arrow rather than a close x: these screens are
     * reachable only from Settings, so back names a real destination
     * (web-frontend.md "Close vs back"). router.back("settings") still covers
     * the cold deep link, where there is no previous entry.
     */
    head(title) {
      return `
        <header class="spoke-head">
          <button class="spoke-head__back" type="button" aria-label="Back to settings"
                  onclick="window.router.back('settings')">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="spoke-head__title font-display">${escapeHtml(title)}</h2>
        </header>
      `;
    },
  };

  window.AdminGate = AdminGate;
})();
