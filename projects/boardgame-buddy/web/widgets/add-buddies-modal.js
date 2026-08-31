// widgets/add-buddies-modal.js — the "Add buddies" card, shared by two callers.
//
// Both of them put the same question to the user — who do you want to add? —
// so they get the same screen rather than two that drift:
//   • first-run setup, as step 2 of 3: the user has just saved a display name
//     and a badge in PolaroidPopup.avatarCustomizer, and this offers a grid of
//     people they may know before the BoardGameGeek step closes the sequence
//     (widgets/onboarding-bgg-modal.js).
//   • the Buddies screen's Add button, which replaced the profile-search bar
//     that used to sit at the top of that page (views/buddies-view.js).
//
// Tiles multi-select; one button sends every tick as a single batch
// (POST /buddies/requests/bulk), the other backs out. The search field above
// the grid reaches past the ranked suggestions to anyone in the app, by display
// name or username (GET /profiles/search).
//
// What the two callers do NOT share is the dismiss wording — see dismissLabel.
// "Skip" is honest inside a sequence and wrong outside one.
//
// Why a modal and not a router view: it began as step 2 of 3 in a sequence that
// starts in a modal, it has no URL worth deep-linking, and a real view would
// need a back-stack entry that means nothing once setup is done. It borrows
// the .polaroid-popup__* chrome so the three steps read as one flow — the same
// thing widgets/onboarding-bgg-modal.js does.
//
// The tiles are NOT bespoke markup: they are the canonical buddy-suggestion
// tile in its "select" mode (ui/buddy-suggestion-rail.js), which is what the
// Feed and Buddies rails render in "add" mode. One object, one component —
// .claude/rules/ui-object-design.md §2.

(function () {
  const BACKDROP_ID = "bgb-add-buddies";
  // Must match the .is-closing animation duration in styles.css.
  const CLOSE_MS = 200;

  let _closeTimer = null;

  function teardown() {
    if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; }
    const stale = document.getElementById(BACKDROP_ID);
    if (stale) stale.remove();
    // First-run runs three of these polaroid cards back to back, and a
    // teardown fires 200ms after its own card resolved — by which time the
    // NEXT card may already have locked the scroll. Only the last overlay out
    // restores it, or the closing card silently unlocks the page behind the
    // one that replaced it. The same guard covers the QR sheet, which carries
    // .polaroid-popup__backdrop too, and covers teardown()'s other caller —
    // the top of open(), which would otherwise unlock on the way IN.
    if (!document.querySelector(".polaroid-popup__backdrop")) {
      document.body.style.overflow = "";
    }
  }

  /**
   * @typedef {Object} OnboardingBuddiesResult
   * @property {"sent"|"skipped"} action
   * @property {string[]} sent          user ids that now have a pending edge
   * @property {{user_id:string, detail:string}[]} failed
   */

  /**
   * Open the step. Resolves once the user sends or skips — never rejects, so
   * the boot path can `await` it without a try/catch around the whole of
   * first-time setup.
   *
   * The caller is responsible for not opening this with an empty list: an
   * "Add buddies" screen with nothing to add is worse than no screen at all.
   *
   * @param {Object} opts
   * @param {import("../ui/buddy-suggestion-rail.js").SuggestedBuddy[]} opts.suggestions
   * @returns {Promise<OnboardingBuddiesResult>}
   */
  function open({ suggestions }) {
    return new Promise((resolve) => {
      teardown();

      const list = suggestions || [];
      /** @type {Set<string>} */
      const selected = new Set();
      let sending = false;
      let settled = false;

      const root = document.createElement("div");
      root.id = BACKDROP_ID;
      root.className = "polaroid-popup__backdrop polaroid-popup__backdrop--confirm";
      root.innerHTML = `
        <div class="polaroid-popup__card polaroid-popup__card--confirm add-buddies"
             role="dialog" aria-modal="true" aria-label="Add buddies" tabindex="-1">
          <button class="polaroid-popup__close" aria-label="Skip for now" data-act="skip">
            <i data-icon="x" class="w-4 h-4"></i>
          </button>
          <div class="add-buddies__body">
            <div class="polaroid-popup__title">Add buddies</div>
            <p class="polaroid-popup__body">
              Pick anyone you know. They'll get a request, and once they accept
              their plays show up in your feed.
            </p>
            <div class="add-buddies__grid" role="group" aria-label="Suggested buddies">
              ${list.map((s) => window.renderBuddySuggestionTile(s, { mode: "select" })).join("")}
            </div>
            <div class="add-buddies__error" role="alert" hidden></div>
            <div class="polaroid-popup__actions add-buddies__actions">
              <button class="btn btn-ghost btn-sm add-buddies__skip" data-act="skip">Skip</button>
              <button class="btn btn-primary btn-sm add-buddies__send" data-act="send" disabled>
                Send requests
              </button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(root);
      // The grid can outrun the viewport; stop the page behind it scrolling
      // with it. teardown() releases it, but only once no other polaroid
      // backdrop is left — see the note there.
      document.body.style.overflow = "hidden";
      window.BgbIcons.render(root);

      const grid = root.querySelector(".add-buddies__grid");
      const sendBtn = root.querySelector(".add-buddies__send");
      const skipBtn = root.querySelector(".add-buddies__skip");
      const errorEl = root.querySelector(".add-buddies__error");

      function finish(result) {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKeydown, true);
        root.classList.add("is-closing");
        _closeTimer = setTimeout(teardown, CLOSE_MS);
        resolve(result);
      }

      // ── Selection ─────────────────────────────────────────────────────────
      // Toggling repaints the one tile and the footer label, never the grid:
      // rebuilding it would destroy the tile under the user's finger before
      // :active could apply (.claude/rules/mobile-web.md §5) and would lose
      // scroll position on a list that scrolls.
      function syncFooter() {
        const n = selected.size;
        sendBtn.disabled = sending || n === 0;
        sendBtn.textContent = sending
          ? "Sending…"
          : n === 0
            ? "Send requests"
            : `Send ${n} request${n === 1 ? "" : "s"}`;
      }

      function toggle(tile) {
        const id = tile.getAttribute("data-user-id");
        if (!id) return;
        const nowOn = !selected.has(id);
        if (nowOn) selected.add(id); else selected.delete(id);
        tile.classList.toggle("is-selected", nowOn);
        tile.setAttribute("aria-pressed", nowOn ? "true" : "false");
        syncFooter();
      }

      // ── Send ──────────────────────────────────────────────────────────────
      async function send() {
        if (sending || selected.size === 0) return;
        sending = true;
        errorEl.hidden = true;
        skipBtn.disabled = true;
        syncFooter();
        const ids = Array.from(selected);
        try {
          const res = await window.Buddy.sendRequests(ids);
          // The cached buddies bundle carries a pending-request flag per row,
          // so a stale copy would show an Add button for a request that has
          // just gone out.
          if (window.Buddy.invalidate) window.Buddy.invalidate();
          finish({
            action: "sent",
            sent: (res && res.sent) || [],
            failed: (res && res.failed) || [],
          });
        } catch (e) {
          // A throw here is the transport failing, not a rejected target —
          // per-target rejections come back inside a 200. Nothing was sent, so
          // keep the screen up with the ticks intact and let them try again.
          sending = false;
          skipBtn.disabled = false;
          syncFooter();
          errorEl.textContent = (e && e.message)
            ? `Couldn't send: ${e.message}`
            : "Couldn't send those requests. Check your connection and try again.";
          errorEl.hidden = false;
        }
      }

      function skip() {
        if (sending) return; // A send is in flight; don't strand the requests.
        finish({ action: "skipped", sent: [], failed: [] });
      }

      // ── Wiring ────────────────────────────────────────────────────────────
      root.addEventListener("click", (ev) => {
        const act = ev.target.closest("[data-act]");
        if (act) {
          if (act.getAttribute("data-act") === "send") send();
          else skip();
          return;
        }
        const tile = ev.target.closest(".buddy-tile--select");
        if (tile && grid.contains(tile)) { toggle(tile); return; }
        // Backdrop tap. Skipping is non-destructive and every suggestion is
        // still one tap away on the Buddies screen, so this needs no confirm.
        if (ev.target === root) skip();
      });

      function onKeydown(ev) {
        if (ev.key !== "Escape") return;
        ev.stopPropagation();
        ev.preventDefault();
        skip();
      }
      document.addEventListener("keydown", onKeydown, true);

      // Move focus into the dialog so a screen reader lands on its label and
      // Tab walks the grid rather than the page behind it. NOT sendBtn: it
      // starts disabled, and a disabled button cannot take focus, so focus
      // would have stayed on whatever opened the modal.
      root.querySelector(".add-buddies").focus();
    });
  }

  window.AddBuddiesModal = { open };
})();
