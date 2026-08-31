// @ts-check
// widgets/onboarding-bgg-modal.js — the onboarding "Link BoardGameGeek" step.
//
// Third and last screen of first-time setup, after the profile card
// (PolaroidPopup.avatarCustomizer) and "Add buddies": offer to pull the user's
// BGG collection, wishlist and play history across so their first minute in
// the app has their own shelf in it rather than an empty one.
//
// Last of the three deliberately. The two steps before it are a tap and a
// batch of taps; this one can sit on screen for minutes while a large
// collection imports, and what waits behind the last card is the user's own
// feed rather than another step.
//
// Two states in one card:
//
//   link    → the pitch, a username + password pair, [Skip] [Link account]
//   import  → the live step log while the import runs, and one button out
//
// Once linked, the import starts immediately and stays visible: a BGG sync
// walks the whole collection and then fetches every game we don't have yet,
// one throttled call each, so the honest thing to say is "this may take a
// while" and let the user leave whenever they want. Nothing here blocks —
// leaving closes the modal, not the import, which finishes server-side.
//
// The log itself is ui/bgg-import-log.js, shared with Settings' Sync button:
// same import, same readout (.claude/rules/ui-object-design.md §2).
//
// Why a modal and not a router view: same reasoning as the sibling
// widgets/onboarding-buddies-modal.js — this is step 3 of 3 in a sequence that
// begins in a modal, it has no URL worth deep-linking, and a real view would
// need a back-stack entry that means nothing once setup is done. It borrows
// the .polaroid-popup__* chrome so the three steps read as one flow.

(function () {
  const BACKDROP_ID = "bgb-onboarding-bgg";
  // Must match the .is-closing animation duration in styles.css.
  const CLOSE_MS = 200;
  // Same cadence as the Settings card's poll — fast enough that game names
  // visibly stream in, slow enough to be cheap against a worker that spends
  // ~1.5s per game anyway.
  const POLL_MS = 2000;

  let _closeTimer = null;

  function teardown() {
    if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; }
    const stale = document.getElementById(BACKDROP_ID);
    if (stale) stale.remove();
    // First-run runs three of these polaroid cards back to back, and a
    // teardown fires 200ms after its own card resolved — by which time the
    // NEXT card may already have locked the scroll. Only the last overlay out
    // restores it, or the closing card silently unlocks the page behind the
    // one that replaced it.
    if (!document.querySelector(".polaroid-popup__backdrop")) {
      document.body.style.overflow = "";
    }
  }

  /**
   * @typedef {Object} OnboardingBggResult
   * @property {"linked"|"skipped"} action
   * @property {string|null} username   the linked BGG handle, if any
   * @property {boolean} importFinished  false when the user left it running
   */

  /**
   * Open the step. Resolves once the user links-and-leaves or skips — never
   * rejects, so the boot path can `await` it without wrapping first-time setup
   * in a try/catch.
   *
   * @returns {Promise<OnboardingBggResult>}
   */
  function open() {
    return new Promise((resolve) => {
      teardown();

      /** @type {"link"|"import"} */
      let step = "link";
      let username = null;
      let linking = false;

      // Import state — the two payloads ui/bgg-import-log.js reads, plus the
      // flags that decide which button the footer shows.
      let syncing = false;
      let summary = null;
      let status = null;
      let syncError = null;
      // Whether the error above is worth another tap. A dead network or a
      // rejected request is; a deadline is not — the import it reports on is
      // still running, so a "Try again" beside it would be telling the user to
      // start a second copy of the sync they were just told is in progress.
      let syncCanRetry = false;
      let pollHandle = null;
      let settled = false;

      const root = document.createElement("div");
      root.id = BACKDROP_ID;
      root.className = "polaroid-popup__backdrop polaroid-popup__backdrop--confirm";
      root.innerHTML = `
        <div class="polaroid-popup__card polaroid-popup__card--confirm onboarding-bgg"
             role="dialog" aria-modal="true" aria-label="Link BoardGameGeek" tabindex="-1">
          <button class="polaroid-popup__close" aria-label="Skip for now" data-act="dismiss">
            <i data-icon="x" class="w-4 h-4"></i>
          </button>
          <div class="onboarding-bgg__body"></div>
        </div>
      `;
      document.body.appendChild(root);
      // The log grows past the viewport on a big collection; stop the page
      // behind it scrolling with it. Restored by teardown() on every exit.
      document.body.style.overflow = "hidden";

      const card = root.querySelector(".onboarding-bgg");
      const body = root.querySelector(".onboarding-bgg__body");
      const closeBtn = root.querySelector(".polaroid-popup__close");

      // ── Rendering ─────────────────────────────────────────────────────────
      // renderStep() swaps the whole body and runs EXACTLY TWICE: once on
      // open, once on link→import. Everything else patches in place —
      // setLinking() and showLinkError() on the form, patchImport() on the
      // log and the footer.
      //
      // That split is not tidiness. Re-rendering the form would wipe the
      // credentials the user is halfway through typing, along with focus and
      // caret; re-rendering the body on a 2s poll would destroy the button
      // under the user's finger before :active could apply
      // (.claude/rules/overlays.md §6, .claude/rules/mobile-web.md §5).

      function linkHtml() {
        return `
          <img src="assets/credits/bgg-logo.svg" alt="Powered by BoardGameGeek"
               class="onboarding-bgg__mark" />
          <div class="polaroid-popup__title">Link BoardGameGeek</div>
          <p class="polaroid-popup__body">
            Already keep your games on BGG? Link it and we'll bring your
            collection, wishlist and play history across. We use your password
            once to sign in, then store it encrypted so later syncs run on
            their own.
          </p>
          <form class="onboarding-bgg__form" novalidate>
            <div class="polaroid-field">
              <label class="polaroid-field__label" for="onboarding-bgg-username">BGG username</label>
              <input id="onboarding-bgg-username" type="text" name="username"
                     class="input input-bordered input-sm polaroid-field__input"
                     autocomplete="username" autocapitalize="none" autocorrect="off"
                     spellcheck="false" placeholder="Your BGG handle" />
            </div>
            <div class="polaroid-field">
              <label class="polaroid-field__label" for="onboarding-bgg-password">BGG password</label>
              <input id="onboarding-bgg-password" type="password" name="password"
                     class="input input-bordered input-sm polaroid-field__input"
                     autocomplete="current-password" placeholder="Your BGG password" />
            </div>
            <div class="onboarding-bgg__error" role="alert" hidden></div>
            <p class="onboarding-bgg__note">
              No BGG account, or rather not right now? Skip — you can link one
              any time from Settings.
            </p>
            <div class="polaroid-popup__actions onboarding-bgg__actions">
              <button type="button" class="btn btn-ghost btn-sm onboarding-bgg__skip"
                      data-act="skip">Skip</button>
              <button type="submit" class="btn btn-primary btn-sm onboarding-bgg__submit">
                Link account
              </button>
            </div>
          </form>
        `;
      }

      function importHtml() {
        return `
          <div class="polaroid-popup__title onboarding-bgg__heading"></div>
          <p class="polaroid-popup__body onboarding-bgg__intro"></p>
          <div class="onboarding-bgg__log" aria-live="polite"></div>
          <div class="onboarding-bgg__foot"></div>
        `;
      }

      // Heading and intro are patched alongside the log, because "Importing…
      // this may take a while" stops being true the moment the import lands —
      // and is a flat contradiction sitting above a message saying it didn't
      // get through.
      function headingText() {
        if (syncError) return syncCanRetry ? "Import didn't finish" : "Still importing";
        return (!syncing && summary) ? "Your games are in" : "Importing your games";
      }

      function introHtml() {
        const linked = username ? `<strong>@${escapeHtml(username)}</strong> is linked. ` : "";
        if (syncError) {
          return linked + (syncCanRetry
            ? "The import didn't get through:"
            : "Your games are on their way:");
        }
        if (!syncing && summary) return linked + "Here's what came across.";
        return linked + "We're pulling your collection and plays from "
          + "BoardGameGeek — this may take a while.";
      }

      // The footer is its own host so the poll can swap "Continue" for "Done"
      // without touching the log above it.
      function footHtml() {
        const finished = !syncing && (!!summary || !!syncError);
        return `
          <p class="onboarding-bgg__note">
            ${finished
              ? "You can sync again any time from Settings."
              : "Feel free to carry on — the import keeps running in the background."}
          </p>
          <div class="polaroid-popup__actions onboarding-bgg__actions">
            ${syncCanRetry ? `
              <button type="button" class="btn btn-ghost btn-sm" data-act="retry">Try again</button>
            ` : ""}
            <button type="button" class="btn btn-primary btn-sm" data-act="done">
              ${finished ? "Done" : "Continue"}
            </button>
          </div>
        `;
      }

      function renderStep() {
        body.innerHTML = step === "link" ? linkHtml() : importHtml();
        // patchImport() fills the heading and re-labels the dialog with it.
        if (step === "import") patchImport();
        else card.setAttribute("aria-label", "Link BoardGameGeek");
        closeBtn.setAttribute("aria-label",
          step === "link" ? "Skip for now" : "Continue in the background");
        window.BgbIcons.render(root);
      }

      function patchImport() {
        const logHost = body.querySelector(".onboarding-bgg__log");
        const footHost = body.querySelector(".onboarding-bgg__foot");
        if (!logHost || !footHost) return;
        const headingHost = body.querySelector(".onboarding-bgg__heading");
        const introHost = body.querySelector(".onboarding-bgg__intro");
        if (headingHost) {
          headingHost.textContent = headingText();
          card.setAttribute("aria-label", headingHost.textContent);
        }
        if (introHost) introHost.innerHTML = introHtml();
        logHost.innerHTML = window.renderBggImportLog({
          syncing,
          summary,
          status,
          error: syncError,
        });
        footHost.innerHTML = footHtml();
        window.BgbIcons.render(body);
      }

      // ── Exit ──────────────────────────────────────────────────────────────
      function finish(action) {
        if (settled) return;
        settled = true;
        stopPoll();
        document.removeEventListener("keydown", onKeydown, true);
        // Even a half-drained import has already written every game we
        // already knew about, so the collection map and the feed the user is
        // about to land on are both stale.
        if (action === "linked") window.Bgg.invalidateImportedData();
        root.classList.add("is-closing");
        _closeTimer = setTimeout(teardown, CLOSE_MS);
        resolve({
          action,
          username,
          importFinished: !syncing && !!summary && window.Bgg.importDrained(status),
        });
      }

      // ── Link ──────────────────────────────────────────────────────────────
      function setLinking(on) {
        linking = on;
        const submit = body.querySelector(".onboarding-bgg__submit");
        const skip = body.querySelector(".onboarding-bgg__skip");
        if (submit) {
          submit.disabled = on;
          submit.textContent = on ? "Linking…" : "Link account";
        }
        if (skip) skip.disabled = on;
        if (closeBtn) closeBtn.disabled = on;
      }

      function showLinkError(message) {
        const el = body.querySelector(".onboarding-bgg__error");
        if (!el) return;
        el.textContent = message || "";
        el.hidden = !message;
      }

      async function submitLink() {
        if (linking) return;
        const userEl = /** @type {HTMLInputElement|null} */ (
          body.querySelector("#onboarding-bgg-username"));
        const passEl = /** @type {HTMLInputElement|null} */ (
          body.querySelector("#onboarding-bgg-password"));
        const handle = ((userEl && userEl.value) || "").trim();
        const password = (passEl && passEl.value) || "";
        if (!handle || !password) {
          showLinkError("Enter your BGG username and password.");
          (handle ? passEl : userEl)?.focus();
          return;
        }
        setLinking(true);
        showLinkError(null);
        try {
          await window.Bgg.link(handle, password);
        } catch (e) {
          setLinking(false);
          // BGG answers 401 for an unknown account and a wrong password
          // alike, and the backend forwards that as a 400 — so say what the
          // user can act on rather than echoing "Bad Request".
          showLinkError((e && e.message)
            ? String(e.message)
            : "Couldn't sign in to BoardGameGeek. Check the username and password.");
          // The handle is almost certainly the right one; the password is the
          // half worth retyping. Clear only that, and put the caret in it.
          if (passEl) { passEl.value = ""; passEl.focus(); }
          return;
        }
        setLinking(false);
        username = handle;
        step = "import";
        renderStep();
        runSync();
      }

      // ── Import ────────────────────────────────────────────────────────────
      async function runSync() {
        syncing = true;
        summary = null;
        syncError = null;
        syncCanRetry = false;
        stopPoll();
        patchImport();

        try {
          summary = await window.Bgg.sync();
        } catch (e) {
          syncing = false;
          // A deadline is not a failure. /bgg/sync walks the whole BGG
          // account inside the handler and hands the rest to a background
          // worker; it finishes whether or not we are still listening, so
          // "sync failed" would be a lie. Say what is actually true.
          if (e && e.timeout) {
            syncError = "BoardGameGeek is taking its time. Your games are still importing in the background — they'll show up in your collection shortly.";
          } else {
            syncError = `Couldn't import from BoardGameGeek: ${(e && e.message) || "please try again."}`;
            syncCanRetry = true;
          }
          patchImport();
          return;
        }

        if (summary && summary.warm_up_retry_pending) {
          syncing = false;
          syncError = "BoardGameGeek is still preparing your collection. Give it a minute, then try again.";
          syncCanRetry = true;
          patchImport();
          return;
        }

        await refreshStatus();
        if (summary.unique_games_to_import > 0 && !window.Bgg.importDrained(status)) {
          startPoll();
          patchImport();
          return;
        }
        syncing = false;
        patchImport();
      }

      async function refreshStatus() {
        try {
          status = await window.Bgg.status();
        } catch (_) {
          // A dropped poll is not worth surfacing — the next tick recovers,
          // and the log simply doesn't advance in the meantime.
        }
      }

      let polling = false;
      function startPoll() {
        if (pollHandle) return;
        pollHandle = setInterval(async () => {
          // A tick that outlives its interval must not stack a second fetch
          // on the first (.claude/rules/web-frontend.md § Async state).
          if (settled || polling) return;
          // Hidden tab: skip the fetch. The modal has no visibilitychange
          // catch-up of its own the way Settings does, because a first-run
          // step the user has backgrounded is exactly the case where the next
          // ordinary tick is soon enough.
          if (document.hidden) return;
          polling = true;
          try { await refreshStatus(); } finally { polling = false; }
          if (settled) return;
          if (window.Bgg.importDrained(status)) {
            stopPoll();
            syncing = false;
          }
          patchImport();
        }, POLL_MS);
      }

      function stopPoll() {
        if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
      }

      // ── Wiring ────────────────────────────────────────────────────────────
      root.addEventListener("input", (ev) => {
        if (step !== "link") return;
        if (!ev.target || !(/** @type {Element} */ (ev.target)).closest(".polaroid-field")) return;
        showLinkError(null);
      });

      root.addEventListener("submit", (ev) => {
        if (!ev.target || !(/** @type {Element} */ (ev.target)).closest(".onboarding-bgg__form")) return;
        ev.preventDefault();
        submitLink();
      });

      root.addEventListener("click", (ev) => {
        const act = ev.target.closest("[data-act]");
        if (act) {
          const what = act.getAttribute("data-act");
          if (what === "retry") { runSync(); return; }
          if (what === "done") { finish("linked"); return; }
          if (what === "skip") { dismiss(); return; }
          if (what === "dismiss") { dismiss(); return; }
          return;
        }
        // Backdrop tap. Nothing is lost either way — skipping leaves the link
        // one tap away in Settings, and leaving an import running does not
        // stop it — so neither needs a confirm.
        if (ev.target === root) dismiss();
      });

      // The one exit that means different things in the two steps: on the
      // form it abandons the step, on the import it just stops watching.
      function dismiss() {
        if (linking) return; // A link is in flight; don't strand it half-done.
        finish(step === "import" ? "linked" : "skipped");
      }

      function onKeydown(ev) {
        if (ev.key !== "Escape") return;
        ev.stopPropagation();
        ev.preventDefault();
        dismiss();
      }
      document.addEventListener("keydown", onKeydown, true);

      renderStep();
      // Focus the card, not the username field: this step is a decision
      // ("do I have a BGG account?") before it is a typing task, and throwing
      // a software keyboard over the pitch answers it for the user. A screen
      // reader lands on the dialog label and Tab walks into the form.
      card.focus();
    });
  }

  window.OnboardingBggModal = { open };
})();
