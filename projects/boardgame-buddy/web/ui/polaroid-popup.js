// ui/polaroid-popup.js — Wrap-up splash polaroid. A medium cream card lands
// in the middle of the screen showing the game thumbnail + winner with a
// close (X) in the top-right. Every exit from the card — the X, a backdrop
// tap — lands on the feed, so "I'm done here" has exactly one destination.
// Getting the just-finalized play into that feed is the caller's job, done
// behind the still-up card: play-flow's _runSave() re-pulls the first page
// the moment the write lands, session-viewer when it sees phase=finalized.
//
// Two callers, one card:
//   • Non-host joiners (session-viewer) get the plain X-only splash.
//   • The host (play-flow) shows it the instant they hit Save, while the
//     write runs behind it — plus the host-only "Another round?" action and,
//     when there's something to say about the play's fate, a `warning` line.
//     It does NOT set `saving`: the upload queue guarantees delivery, so
//     there is nothing for the host to wait on and the card is live from the
//     first frame. Going to the feed is the X's job.
//
// `saving` and `error` remain the honest way to render a write the user must
// wait on, and renderInner still does — no current caller needs it.

// @ts-check

(function () {
  const BACKDROP_ID = "bgb-polaroid-popup";

  /**
   * @typedef {Object} PolaroidPopupOptions
   * @property {string}  gameName
   * @property {string=} gameThumbnail
   * @property {string=} winnerName
   * @property {string=} headline — orange display-font line rendered above
   *           the card (e.g. "Well played!"). Stacks the backdrop into a
   *           column when set.
   * @property {string=} playId — when present, the splash adds a "View play"
   *           CTA that opens the in-place play-detail popup. Set by the
   *           phase=finalized handler.
   * @property {boolean=} saving — the play is still being written and the user
   *           must wait: the lone bottom button is a disabled spinner +
   *           "Saving…" ("Another round?" isn't offered), and the card can't be
   *           dismissed (no X, inert backdrop). No caller sets this today — the
   *           host's write is backed by the upload queue, so it isn't something
   *           to wait on.
   * @property {string=} error — the save failed with nowhere left to put the
   *           play (play-flow only reaches this when the queue write itself
   *           fails). Renders under the winner pill and swaps the lone bottom
   *           button to "Retry".
   * @property {string=} warning — muted advisory line (e.g. the photo
   *           upload failed but the play itself saved).
   * @property {() => void=} onDismiss — override the default feed redirect
   *           used by the backdrop tap and the corner X.
   * @property {() => void=} onClose — override what the corner X does on its
   *           own. Rarely needed: with neither handler set the X takes the
   *           same feed redirect as every other exit, and when only
   *           `onDismiss` is set the X follows it, so a caller that redirects
   *           dismissal keeps one consistent destination.
   * @property {(() => void)=} onAnotherRound — host-only. When set the card
   *           renders an "Another round?" button that re-seeds a fresh
   *           session with the same game / expansions / players.
   * @property {(() => void)=} onRetry — re-fire a failed save. Wired to the
   *           primary CTA whenever `error` is set.
   */

  // Monotonic id stamped on each splash card. Background work that finishes
  // late (the host's photo attach) passes the id it started with to update()
  // so it can only ever repaint its own card — never a confirm dialog or a
  // later splash that took the singleton slot in the meantime.
  let _cardSeq = 0;

  /**
   * @param {PolaroidPopupOptions} opts
   * @returns {number} the card's id, for guarded update() calls.
   */
  function show(opts) {
    dismiss(); // singleton — never stack two
    const root = document.createElement("div");
    root.id = BACKDROP_ID;
    root.__cardId = ++_cardSeq;
    root.className = "polaroid-popup__backdrop"
      + (opts && opts.headline ? " polaroid-popup__backdrop--with-headline" : "");
    root.innerHTML = renderInner(opts);
    root.__opts = opts;
    root.addEventListener("click", (ev) => {
      // Click on the backdrop (but not on the card) dismisses — unless a
      // save is still in flight, in which case the card is modal. Read the
      // live opts off the element so an update() that clears `saving`
      // re-enables backdrop dismissal without re-binding this listener.
      if (!isOutsideCard(ev.target)) return;
      const live = root.__opts || opts;
      if (live && live.saving) return;
      handleDismiss(live);
    });
    document.body.appendChild(root);
    // Back takes the backdrop's exit — including its refusal to dismiss a card
    // whose save is still in flight, which re-arms the guard rather than
    // spending the press on the screen underneath.
    const backExit = () => {
      const live = root.__opts || opts;
      if (live && live.saving) { armBack(root, backExit); return; }
      handleDismiss(live);
    };
    armBack(root, backExit);
    wire(root, opts);
    return root.__cardId;
  }

  /**
   * Refresh the popup contents in place (e.g. when phase=finalized
   * arrives after settle, or when the host's background save lands). Merges
   * `partial` over the opts stashed on the backdrop so game/winner survive.
   * Safe to call when no popup is open — silently no-ops.
   *
   * @param {Object} partial
   * @param {number=} cardId — when given, the update applies only if this is
   *   still the card that show() returned that id for. Late background work
   *   must pass it; without the guard a slow photo attach could repaint a
   *   confirm dialog that has since claimed the singleton slot.
   */
  function update(partial, cardId) {
    const root = document.getElementById(BACKDROP_ID);
    if (!root) return;
    // confirm()/alert() build their own markup and never stash __opts —
    // re-rendering them through renderInner would replace the dialog and
    // strand its promise.
    if (!root.__opts) return;
    if (cardId != null && root.__cardId !== cardId) return;
    const merged = { ...(root.__opts || {}), ...partial };
    root.innerHTML = renderInner(merged);
    wire(root, merged);
  }

  /**
   * Bind every button inside the card. The single binding path for both
   * show() and update() — each paint re-creates the markup, so exactly one
   * pass wires it.
   */
  function wire(root, opts) {
    root.__opts = opts;
    window.BgbIcons.render(root);
    const closeBtn = root.querySelector(".polaroid-popup__close");
    if (closeBtn) closeBtn.addEventListener("click", () => handleClose(opts));
    const viewBtn = root.querySelector(".polaroid-popup__view");
    if (viewBtn) {
      viewBtn.addEventListener("click", () => {
        const pid = viewBtn.getAttribute("data-play-id");
        dismiss();
        // Open the in-place play-detail popup so the user stays on
        // whichever surface they wrapped up from.
        if (pid && window.PlayDetailPopup) window.PlayDetailPopup.show(pid);
      });
    }
    const againBtn = root.querySelector(".polaroid-popup__another");
    if (againBtn) {
      againBtn.addEventListener("click", () => {
        if (againBtn.disabled) return;
        if (typeof opts.onAnotherRound === "function") opts.onAnotherRound();
      });
    }
    // The save-state slot: only rendered while the write is in flight
    // (disabled "Saving…") or has failed, so the one thing it can do is
    // re-fire the save.
    const retryBtn = root.querySelector(".polaroid-popup__retry");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => {
        if (retryBtn.disabled) return;
        if (typeof opts.onRetry === "function") opts.onRetry();
      });
    }
  }

  // Set by a surface whose promise must not be lost if something else dismisses
  // the singleton out from under it. Every popup here shares one BACKDROP_ID,
  // and alert()/confirm() both dismiss() first — so an unrelated alert fired
  // while the avatar customizer is open removes its node, and without this its
  // promise would never settle. That is a permanent hang for the caller, and
  // first-run setup now parks a continuation behind exactly that promise
  // (see the QR gate in init.js).
  let _orphanHook = null;

  // Device-back guard token for whichever card holds the singleton slot. Every
  // entry point here arms one as it appends its root, and dismiss() — which
  // every exit goes through — releases it. See ui/back-guard.js.
  let _back = 0;

  /**
   * Did this tap land outside the card? Everything that is not the card reads
   * as blurred background and dismisses — including the headline floating
   * ABOVE it, which is a sibling of the card rather than part of the backdrop
   * element, so an `event.target === root` test used to leave a dead strip of
   * "background" right where the wrap-up and achievement cards put their
   * biggest words.
   * @param {any} target
   */
  function isOutsideCard(target) {
    return !(target && target.closest && target.closest(".polaroid-popup__card"));
  }

  /**
   * @param {HTMLElement} root
   * @param {() => void} onBack  the exit the back gesture takes; give it the
   *   same one the backdrop tap takes, so every dismissal means one thing.
   */
  function armBack(root, onBack) {
    _back = window.BgbBackGuard
      ? window.BgbBackGuard.arm({ root: root, close: onBack })
      : 0;
  }

  function dismiss() {
    if (window.BgbBackGuard) window.BgbBackGuard.release(_back);
    _back = 0;
    const existing = document.getElementById(BACKDROP_ID);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
    const hook = _orphanHook;
    _orphanHook = null;
    if (hook) { try { hook(); } catch (e) { console.warn("popup orphan hook:", e); } }
  }

  /** Is one of this module's cards on screen right now? Every entry point here
   *  calls dismiss() first, so the module is a singleton — which is exactly why
   *  a caller that wants to show something *after* the current card (the
   *  achievement queue in ui/achievement-popup.js) has to be able to ask. */
  function isOpen() {
    return !!document.getElementById(BACKDROP_ID);
  }

  /**
   * The X in the card's corner — the wrap-up card's primary exit now that
   * the bottom button is "Another round?". It takes the same feed redirect
   * as a backdrop tap. `onClose` overrides it; absent that it falls back to
   * `onDismiss`, so a caller that redirects dismissal keeps one destination for
   * every exit rather than having the X take a different one.
   */
  function handleClose(opts) {
    if (opts && typeof opts.onClose === "function") {
      dismiss();
      try { opts.onClose(); } catch (_) {}
      return;
    }
    handleDismiss(opts);
  }

  function handleDismiss(opts) {
    dismiss();
    if (opts && typeof opts.onDismiss === "function") {
      try { opts.onDismiss(); } catch (_) {}
      return;
    }
    goToFeed();
  }

  /**
   * The one exit. Deliberately does NOT call Feed.refreshFirstPage() itself:
   * that drops the cached first page, so a card that re-pulled on the way out
   * would hand the user a skeleton instead of the feed. Both callers refresh
   * behind the still-up card instead — play-flow's _runSave() the moment the
   * write lands, session-viewer the moment the host finalizes — so by the
   * time this runs the new page is already warm.
   */
  function goToFeed() {
    try { window.store.invalidate("feed"); } catch (_) {}
    window.router.go("feed");
  }

  function renderInner(opts) {
    const gameName = escapeHtml(opts.gameName || "Game over");
    const headline = opts.headline
      ? `<div class="polaroid-popup__headline">${escapeHtml(opts.headline)}</div>`
      : "";
    const winner = opts.winnerName
      ? `<div class="polaroid-popup__winner">
           <i data-icon="trophy" class="w-4 h-4"></i>
           <span>${escapeHtml(opts.winnerName)}</span>
         </div>`
      : `<div class="polaroid-popup__winner polaroid-popup__winner--muted">No winner recorded</div>`;
    const photo = opts.gameThumbnail
      ? `<img class="polaroid-popup__photo" src="${escapeAttr(opts.gameThumbnail)}" alt="" />`
      : `<div class="polaroid-popup__photo polaroid-popup__photo--placeholder">
           <i data-icon="dice-6" class="w-10 h-10"></i>
         </div>`;
    const viewBtn = opts.playId
      ? `<button class="polaroid-popup__view btn btn-ghost btn-sm" data-play-id="${escapeAttr(opts.playId)}">
           <i data-icon="external-link" class="w-3.5 h-3.5"></i>
           <span>View play</span>
         </button>`
      : "";
    const error = opts.error
      ? `<div class="polaroid-popup__error">${escapeHtml(opts.error)}</div>`
      : "";
    const warning = opts.warning
      ? `<div class="polaroid-popup__warning">${escapeHtml(opts.warning)}</div>`
      : "";
    // The host's wrap-up card carries the save state; the joiner's splash
    // (session-viewer) passes none of these and keeps its X-only chrome.
    //
    // One button, three states. While the write is in flight or has failed
    // the slot belongs to the save itself ("Saving…" / "Retry") — offering
    // "Another round?" there would only be a disabled button asking to be
    // tapped. Once the play has landed the slot is "Another round?", and
    // leaving for the feed is the corner X's job.
    const hasActions = !!(opts.onAnotherRound || opts.saving || opts.error);
    const pending = !!(opts.saving || opts.error);
    const actions = hasActions ? `
      <div class="polaroid-popup__actions polaroid-popup__actions--wrap">
        ${pending ? `
          <button class="polaroid-popup__retry btn btn-primary btn-sm"
                  ${opts.saving ? "disabled" : ""}>
            ${opts.saving
              ? `<span class="loading loading-spinner loading-xs"></span><span>Saving…</span>`
              : `<i data-icon="refresh-cw" class="w-3.5 h-3.5"></i><span>Retry</span>`}
          </button>
        ` : ""}
        ${!pending && opts.onAnotherRound ? `
          <button class="polaroid-popup__another btn btn-primary btn-sm">
            <i data-icon="rotate-ccw" class="w-3.5 h-3.5"></i>
            <span>Another round?</span>
          </button>
        ` : ""}
      </div>
    ` : "";
    // No escape hatch while a write is in flight — the disabled "Saving…"
    // button is the only affordance until the save resolves one way or the
    // other.
    const closeBtn = opts.saving ? "" : `
      <button class="polaroid-popup__close" aria-label="Close">
        <i data-icon="x" class="w-4 h-4"></i>
      </button>
    `;
    return `
      ${headline}
      <div class="polaroid-popup__card" role="dialog" aria-modal="true" aria-label="Game wrapped up">
        ${closeBtn}
        ${photo}
        <div class="polaroid-popup__title">${gameName}</div>
        ${winner}
        ${error}
        ${warning}
        ${viewBtn}
        ${actions}
      </div>
    `;
  }

  /**
   * "Achievement unlocked" polaroid — the badge's medallion as the photo, its
   * name and flavour line as the caption, and one CTA that jumps straight to
   * the Achievements spoke.
   *
   * A sibling of show() rather than a variant of it: it shares this module's
   * chrome (backdrop, card, headline, corner X) and its singleton lifecycle,
   * but none of show()'s play-shaped state — no winner, no save, no retry.
   * Queueing and "wait until nothing else is on screen" belong to the caller
   * (ui/achievement-popup.js), because this function, like every other entry
   * point here, dismisses whatever card is currently up.
   *
   * @param {Object} opts
   * @param {string} opts.name         badge name, the polaroid's title
   * @param {string} opts.description  its flavour line, under the name
   * @param {string} opts.spriteUrl    the medallion, used as the photo
   * @param {number=} opts.index       1-based position when several unlocked
   * @param {number=} opts.total       how many unlocked in this batch
   * @param {() => void=} opts.onView  the "See my achievements" CTA
   * @param {() => void=} opts.onDismiss  X or backdrop tap
   */
  function achievement(opts) {
    dismiss(); // singleton — never stack two
    const root = document.createElement("div");
    root.id = BACKDROP_ID;
    root.className = "polaroid-popup__backdrop polaroid-popup__backdrop--with-headline";

    const counter = (opts.total || 1) > 1
      ? `<div class="polaroid-popup__count">${opts.index} of ${opts.total}</div>`
      : "";

    root.innerHTML = `
      <div class="polaroid-popup__headline">Achievement unlocked!</div>
      <div class="polaroid-popup__card polaroid-popup__card--achievement"
           role="dialog" aria-modal="true"
           aria-label="${escapeAttr(`Achievement unlocked: ${opts.name}`)}">
        <button class="polaroid-popup__close" aria-label="Close">
          <i data-icon="x" class="w-4 h-4"></i>
        </button>
        <img class="polaroid-popup__photo polaroid-popup__photo--badge"
             src="${escapeAttr(opts.spriteUrl)}" alt="" width="160" height="160" />
        <div class="polaroid-popup__title">${escapeHtml(opts.name)}</div>
        <p class="polaroid-popup__caption">${escapeHtml(opts.description || "")}</p>
        ${counter}
        <div class="polaroid-popup__actions">
          <button class="polaroid-popup__view btn btn-primary btn-sm">
            <i data-icon="trophy" class="w-3.5 h-3.5"></i>
            <span>See my achievements</span>
          </button>
        </div>
      </div>
    `;

    const close = () => {
      dismiss();
      if (typeof opts.onDismiss === "function") opts.onDismiss();
    };
    root.addEventListener("click", (ev) => {
      const t = /** @type {any} */ (ev.target);
      if (isOutsideCard(t)) { close(); return; }
      if (t.closest(".polaroid-popup__close")) { close(); return; }
      if (t.closest(".polaroid-popup__view")) {
        dismiss();
        if (typeof opts.onView === "function") opts.onView();
      }
    });
    document.body.appendChild(root);
    armBack(root, close);
    window.BgbIcons.render(root);
  }

  /**
   * Render a small confirm dialog with two buttons. Resolves true when the
   * user picks the destructive action, false on cancel / backdrop click.
   *
   * This is the project's ONE confirm surface (.claude/rules/web-frontend.md,
   * ui-object-design.md §3c), so a variant is an opt rather than a second
   * dialog: `destructive` paints the confirm button as the thing it does.
   * Most callers here are "discard a draft" — recoverable in the sense that
   * nothing existed yet — and read fine in the accent. Reserve `destructive`
   * for an action that removes something the user already has, where the rule
   * is explicit that the button must look dangerous at a glance in both
   * themes.
   *
   * @param {{title:string, body?:string, confirmLabel?:string,
   *          cancelLabel?:string, destructive?:boolean}} opts
   * @returns {Promise<boolean>}
   */
  function confirm({
    title,
    body,
    confirmLabel = "Discard",
    cancelLabel = "Keep playing",
    destructive = false,
  }) {
    return new Promise((resolve) => {
      dismiss();
      const root = document.createElement("div");
      root.id = BACKDROP_ID;
      root.className = "polaroid-popup__backdrop polaroid-popup__backdrop--confirm";
      root.innerHTML = `
        <div class="polaroid-popup__card polaroid-popup__card--confirm"
             role="alertdialog" aria-modal="true">
          <div class="polaroid-popup__title">${escapeHtml(title)}</div>
          ${body ? `<p class="polaroid-popup__body">${escapeHtml(body)}</p>` : ""}
          <div class="polaroid-popup__actions">
            <button class="btn btn-ghost btn-sm polaroid-popup__cancel">${escapeHtml(cancelLabel)}</button>
            <button class="btn btn-sm polaroid-popup__confirm${destructive ? " polaroid-popup__confirm--danger" : " btn-primary"}">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      `;
      root.addEventListener("click", (ev) => {
        if (isOutsideCard(ev.target)) { dismiss(); resolve(false); }
      });
      document.body.appendChild(root);
      // Back cancels — the same answer a backdrop tap gives, and the safe one
      // for a dialog whose other button is destructive.
      armBack(root, () => { dismiss(); resolve(false); });
      window.BgbIcons.render(root);
      const cancelBtn = root.querySelector(".polaroid-popup__cancel");
      const confirmBtn = root.querySelector(".polaroid-popup__confirm");
      if (cancelBtn) cancelBtn.addEventListener("click", () => { dismiss(); resolve(false); });
      if (confirmBtn) confirmBtn.addEventListener("click", () => { dismiss(); resolve(true); });
    });
  }

  /**
   * One-button information modal. Returns a Promise that resolves when the
   * user acknowledges. Used for warnings the user MUST see (e.g. "your
   * photo couldn't be uploaded but the rest of the save went through") —
   * a transient toast risks the user navigating away before they read it.
   * @param {{title:string, body?:string, label?:string}} opts
   * @returns {Promise<void>}
   */
  function alert({ title, body, label = "OK" }) {
    return new Promise((resolve) => {
      dismiss();
      const root = document.createElement("div");
      root.id = BACKDROP_ID;
      root.className = "polaroid-popup__backdrop polaroid-popup__backdrop--confirm";
      root.innerHTML = `
        <div class="polaroid-popup__card polaroid-popup__card--confirm"
             role="alertdialog" aria-modal="true">
          <div class="polaroid-popup__title">${escapeHtml(title)}</div>
          ${body ? `<p class="polaroid-popup__body">${escapeHtml(body)}</p>` : ""}
          <div class="polaroid-popup__actions">
            <button class="btn btn-primary btn-sm polaroid-popup__confirm">${escapeHtml(label)}</button>
          </div>
        </div>
      `;
      // Backdrop tap also resolves — the alert is informational, no
      // destructive consequence to dismissing it any way.
      root.addEventListener("click", (ev) => {
        if (isOutsideCard(ev.target)) { dismiss(); resolve(); }
      });
      document.body.appendChild(root);
      armBack(root, () => { dismiss(); resolve(); });
      window.BgbIcons.render(root);
      const okBtn = root.querySelector(".polaroid-popup__confirm");
      if (okBtn) okBtn.addEventListener("click", () => { dismiss(); resolve(); });
    });
  }

  /**
   * Avatar customizer modal. Reuses the polaroid card chrome (cream bg,
   * close button, backdrop blur) and the confirm-style footer for the
   * Save / Cancel buttons. Resolves with the chosen avatar config (plus
   * the typed displayName when includeNameField is on) when the user
   * taps Save, or null on Cancel / backdrop / close.
   *
   * @param {Object} opts
   * @param {{icon:string,iconColor:string,bgColor:string}|null} opts.current
   *   The user's existing badge — used as the starting point. null means
   *   "still on BGB default" and we seed with BgbBadge.DEFAULT.
   * @param {string} opts.displayName  Starting display name. Drives the
   *   initials preview and seeds the name input when includeNameField=true.
   * @param {string=} opts.headerTitle  Modal title (default "Customize avatar").
   * @param {boolean=} opts.includeNameField  Render a display-name input
   *   above the carousel. Typing into it re-paints the "Initials" slot
   *   live. The resolved object includes a `displayName` field.
   * @param {string=} opts.saveLabel  Footer save button label
   *   (default "Save avatar").
   * @returns {Promise<{icon:string,iconColor:string,bgColor:string,displayName?:string}|null>}
   */
  function avatarCustomizer({
    current,
    displayName,
    headerTitle = "Customize avatar",
    includeNameField = false,
    saveLabel = "Save avatar",
  }) {
    return new Promise((resolve) => {
      dismiss();

      // .polaroid-field* is the shared look for a labelled field on a polaroid
      // card (also the first-run BGG step); .avatar-cust__name* stays as this
      // card's layout offset and as the JS hooks below.
      //
      // maxlength stops NEW typing at the ceiling; a name saved before the
      // ceiling existed is longer and the browser keeps it in the field
      // untouched (maxlength only constrains user edits). finish() is what
      // holds the line for those — see the length check there.
      const nameMax = window.User.DISPLAY_NAME_MAX;
      const seededName = String(displayName || "");
      const nameFieldHtml = includeNameField ? `
          <div class="polaroid-field avatar-cust__name">
            <label class="polaroid-field__label" for="avatar-cust-name">Display name</label>
            <input id="avatar-cust-name" type="text" class="input input-bordered input-sm polaroid-field__input avatar-cust__name-input"
                   value="${escapeAttr(seededName)}" maxlength="${nameMax}" autocomplete="off"
                   placeholder="Your name" />
            <div class="polaroid-field__count avatar-cust__name-count"></div>
            <div class="polaroid-field__error avatar-cust__name-error text-error text-xs" hidden></div>
          </div>
        ` : "";

      const root = document.createElement("div");
      root.id = BACKDROP_ID;
      root.className = "polaroid-popup__backdrop polaroid-popup__backdrop--confirm";
      root.innerHTML = `
        <div class="polaroid-popup__card polaroid-popup__card--confirm avatar-cust"
             role="dialog" aria-modal="true" aria-label="${escapeAttr(headerTitle)}">
          <button class="polaroid-popup__close" aria-label="Close">
            <i data-icon="x" class="w-4 h-4"></i>
          </button>
          <div class="avatar-cust__body">
            <div class="polaroid-popup__title">${escapeHtml(headerTitle)}</div>

            ${nameFieldHtml}

            <div class="avatar-cust__picker"></div>

            <div class="polaroid-popup__actions">
              <button class="btn btn-ghost btn-sm polaroid-popup__cancel">Cancel</button>
              <button class="btn btn-primary btn-sm polaroid-popup__confirm">${escapeHtml(saveLabel)}</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(root);

      // The carousel, the colour toggle and the swatch grid all live in
      // ui/avatar-picker.js — this card and the onboarding deck's first slide
      // mount the same one (.claude/rules/ui-object-design.md §4).
      const picker = window.BgbAvatarPicker.mount(
        root.querySelector(".avatar-cust__picker"),
        { current: current, displayName: displayName },
      );

      const nameInput = root.querySelector(".avatar-cust__name-input");
      const nameErrorEl = root.querySelector(".avatar-cust__name-error");
      const nameCountEl = root.querySelector(".avatar-cust__name-count");
      let nameError = null;

      function showNameError(message) {
        nameError = message;
        if (nameErrorEl) { nameErrorEl.hidden = false; nameErrorEl.textContent = message; }
        if (nameInput) nameInput.focus();
      }

      // The counter is the only warning a legacy over-length name gets before
      // Save: typing is already capped, so what it tells the user is how much
      // room is left and — in the over state — that this name is above the
      // ceiling and any edit has to bring it back under.
      function paintNameCount() {
        if (!nameCountEl || !nameInput) return;
        const len = nameInput.value.trim().length;
        nameCountEl.textContent = `${len}/${nameMax}`;
        nameCountEl.classList.toggle("polaroid-field__count--over", len > nameMax);
      }

      // Initials slot listens to the name input — typing re-paints it live.
      if (nameInput) {
        paintNameCount();
        nameInput.addEventListener("input", () => {
          picker.setDisplayName(nameInput.value);
          paintNameCount();
          if (nameError) {
            nameError = null;
            if (nameErrorEl) { nameErrorEl.hidden = true; nameErrorEl.textContent = ""; }
          }
        });
      }

      function finish(picked) {
        if (!picked) { settle(null); return; }
        const payload = picker.value();
        if (includeNameField) {
          const trimmed = ((nameInput && nameInput.value) || "").trim();
          if (!trimmed) {
            showNameError("Display name can't be empty.");
            return;
          }
          // Names saved before the ceiling existed stay as they are — leaving
          // the field alone saves the avatar and nothing else (the caller only
          // sends display_name when it changed). Touching the name is what
          // opts into the ceiling, and then it has to come all the way under.
          if (trimmed.length > nameMax && trimmed !== seededName.trim()) {
            showNameError(`Display name can't be longer than ${nameMax} characters.`);
            return;
          }
          payload.displayName = trimmed;
        }
        settle(payload);
      }

      // One exit for every path — the buttons, the X, the backdrop, and a
      // dismiss() fired by some other popup. Idempotent, so the orphan hook
      // racing a real click cannot resolve twice.
      let settled = false;
      function settle(value) {
        if (settled) return;
        settled = true;
        _orphanHook = null;
        dismiss();
        resolve(value);
      }
      _orphanHook = () => settle(null);

      root.addEventListener("click", (ev) => {
        if (isOutsideCard(ev.target)) finish(false);
      });
      const closeBtn = root.querySelector(".polaroid-popup__close");
      if (closeBtn) closeBtn.addEventListener("click", () => finish(false));
      const cancelBtn = root.querySelector(".polaroid-popup__cancel");
      if (cancelBtn) cancelBtn.addEventListener("click", () => finish(false));
      const saveBtn = root.querySelector(".polaroid-popup__confirm");
      if (saveBtn) saveBtn.addEventListener("click", () => finish(true));
      // Back cancels, and dismisses the display-name keyboard first.
      armBack(root, () => finish(false));

      window.BgbIcons.render(root);
      // The card is in the DOM now, so the reel can measure itself.
      picker.refresh();
    });
  }


  window.PolaroidPopup = {
    show, update, dismiss, isOpen, achievement, confirm, alert, avatarCustomizer,
  };
})();
