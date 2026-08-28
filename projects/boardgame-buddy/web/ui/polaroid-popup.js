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
      if (ev.target !== root) return;
      const live = root.__opts || opts;
      if (live && live.saving) return;
      handleDismiss(live);
    });
    document.body.appendChild(root);
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

  function dismiss() {
    const existing = document.getElementById(BACKDROP_ID);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
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
   * Render a small confirm dialog with two buttons. Resolves true when the
   * user picks the destructive action, false on cancel / backdrop click.
   * @param {{title:string, body?:string, confirmLabel?:string, cancelLabel?:string}} opts
   * @returns {Promise<boolean>}
   */
  function confirm({ title, body, confirmLabel = "Discard", cancelLabel = "Keep playing" }) {
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
            <button class="btn btn-primary btn-sm polaroid-popup__confirm">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      `;
      root.addEventListener("click", (ev) => {
        if (ev.target === root) { dismiss(); resolve(false); }
      });
      document.body.appendChild(root);
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
        if (ev.target === root) { dismiss(); resolve(); }
      });
      document.body.appendChild(root);
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
      const start = current || window.BgbBadge.DEFAULT;
      const ITEMS = window.BgbBadge.ITEMS;
      const PALETTE = window.BgbBadge.PALETTE;
      // Start the carousel on the user's current pick if we can find it.
      let index = Math.max(0, ITEMS.findIndex(it => it.key === start.icon));
      if (index < 0) index = 0;
      const state = {
        index,
        iconColor: start.iconColor,
        bgColor: start.bgColor,
        target: "iconColor", // which color the swatch grid is editing
        displayName: String(displayName || ""),
        nameError: null,
      };

      const nameFieldHtml = includeNameField ? `
          <div class="avatar-cust__name">
            <label class="avatar-cust__name-label" for="avatar-cust-name">Display name</label>
            <input id="avatar-cust-name" type="text" class="input input-bordered input-sm avatar-cust__name-input"
                   value="${escapeAttr(state.displayName)}" maxlength="40" autocomplete="off"
                   placeholder="Your name" />
            <div class="avatar-cust__name-error text-error text-xs" hidden></div>
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

            <div class="avatar-cust__carousel">
              <button class="avatar-cust__arrow" data-step="-1" aria-label="Previous">
                <i data-icon="chevron-left" class="w-5 h-5"></i>
              </button>
              <div class="avatar-cust__reel">
                <div class="avatar-cust__badge"></div>
                <div class="avatar-cust__track"></div>
              </div>
              <button class="avatar-cust__arrow" data-step="1" aria-label="Next">
                <i data-icon="chevron-right" class="w-5 h-5"></i>
              </button>
            </div>
            <div class="avatar-cust__name-reel"><div class="avatar-cust__name-track"></div></div>
            <div class="avatar-cust__dots"></div>

            <div class="avatar-cust__target">
              <button class="avatar-cust__tg avatar-cust__tg--icon on" data-target="iconColor">
                <span class="avatar-cust__tg-dot"></span>Icon
              </button>
              <button class="avatar-cust__tg avatar-cust__tg--bg" data-target="bgColor">
                <span class="avatar-cust__tg-dot"></span>Background
              </button>
            </div>
            <div class="avatar-cust__swatches"></div>
            <div class="avatar-cust__note"></div>

            <div class="polaroid-popup__actions">
              <button class="btn btn-ghost btn-sm polaroid-popup__cancel">Cancel</button>
              <button class="btn btn-primary btn-sm polaroid-popup__confirm">${escapeHtml(saveLabel)}</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(root);

      const track = root.querySelector(".avatar-cust__track");
      const nameTrack = root.querySelector(".avatar-cust__name-track");
      const dots = root.querySelector(".avatar-cust__dots");
      const badge = root.querySelector(".avatar-cust__badge");
      const swatchEl = root.querySelector(".avatar-cust__swatches");
      const noteEl = root.querySelector(".avatar-cust__note");
      const tgIcon = root.querySelector(".avatar-cust__tg--icon");
      const tgBg = root.querySelector(".avatar-cust__tg--bg");
      const nameInput = root.querySelector(".avatar-cust__name-input");
      const nameErrorEl = root.querySelector(".avatar-cust__name-error");

      // Initials slot listens to the name input — typing re-paints it live.
      if (nameInput) {
        nameInput.addEventListener("input", () => {
          state.displayName = nameInput.value;
          if (state.nameError) {
            state.nameError = null;
            if (nameErrorEl) { nameErrorEl.hidden = true; nameErrorEl.textContent = ""; }
          }
          const initialsSlot = track.querySelector(".avatar-cust__ini");
          if (initialsSlot) initialsSlot.textContent = initialsForCustomizer(state.displayName);
        });
      }

      // Build the reel (one slot per icon option) + name track + dot row.
      ITEMS.forEach((it, i) => {
        const slot = document.createElement("div");
        slot.className = "avatar-cust__slot";
        slot.dataset.i = String(i);
        slot.innerHTML = it.key === "initials"
          ? `<span class="avatar-cust__ini">${escapeHtml(initialsForCustomizer(state.displayName))}</span>`
          : `<svg viewBox="0 0 24 24">${window.BgbBadge.ICONS[it.key]}</svg>`;
        slot.addEventListener("click", () => { state.index = i; rerender(); });
        track.appendChild(slot);

        const ns = document.createElement("div");
        ns.className = "avatar-cust__name-slot";
        ns.textContent = it.name;
        nameTrack.appendChild(ns);

        const d = document.createElement("div");
        d.className = "avatar-cust__dot";
        d.addEventListener("click", () => { state.index = i; rerender(); });
        dots.appendChild(d);
      });

      // Arrows step the carousel.
      root.querySelectorAll(".avatar-cust__arrow").forEach((btn) => {
        btn.addEventListener("click", () => {
          const dir = Number(btn.getAttribute("data-step")) || 0;
          state.index = clamp(state.index + dir, 0, ITEMS.length - 1);
          rerender();
        });
      });

      // Icon / Background target toggle.
      tgIcon.addEventListener("click", () => { state.target = "iconColor"; rerender(); });
      tgBg.addEventListener("click", () => { state.target = "bgColor"; rerender(); });

      function rerender() {
        // Slide the reel so the active slot lands centered on the badge.
        // The reel can flex-shrink to fit narrow modal widths, so the math
        // has to read the live rendered width — using a hardcoded 240px
        // would land the active slot off-badge whenever flex took over.
        const reelEl = /** @type {HTMLElement} */ (track.parentElement);
        const reelW = reelEl.getBoundingClientRect().width;
        const activeSlot = /** @type {HTMLElement} */ (track.children[state.index]);
        const slotCenter = activeSlot.offsetLeft + activeSlot.offsetWidth / 2;
        const tx = reelW / 2 - slotCenter;
        track.style.transform = `translateX(${tx}px)`;
        // Name reel uses the same reel width so each name slot occupies one
        // full reel page; sliding by -index * reelW snaps the active name.
        const nameSlots = nameTrack.querySelectorAll(".avatar-cust__name-slot");
        nameSlots.forEach((n) => { /** @type {HTMLElement} */ (n).style.width = reelW + "px"; });
        nameTrack.style.transform = `translateX(${-state.index * reelW}px)`;

        // Active styling + colors on the slot SVGs / initials.
        Array.from(track.children).forEach((node, i) => {
          const s = /** @type {HTMLElement} */ (node);
          const active = i === state.index;
          s.classList.toggle("avatar-cust__slot--active", active);
          const g = s.querySelector("svg");
          const ini = s.querySelector(".avatar-cust__ini");
          if (g) /** @type {SVGElement} */ (g).style.color = active ? state.iconColor : "";
          if (ini) /** @type {HTMLElement} */ (ini).style.color = active ? state.iconColor : "";
        });
        badge.style.background = state.bgColor;
        Array.from(dots.children).forEach((d, i) => {
          d.classList.toggle("avatar-cust__dot--on", i === state.index);
        });
        // Target chip dots reflect the live values.
        const iconDot = tgIcon.querySelector(".avatar-cust__tg-dot");
        const bgDot = tgBg.querySelector(".avatar-cust__tg-dot");
        if (iconDot) /** @type {HTMLElement} */ (iconDot).style.background = state.iconColor;
        if (bgDot) /** @type {HTMLElement} */ (bgDot).style.background = state.bgColor;
        tgIcon.classList.toggle("on", state.target === "iconColor");
        tgBg.classList.toggle("on", state.target === "bgColor");
        // Swatch grid.
        swatchEl.innerHTML = "";
        const other = state.target === "iconColor" ? state.bgColor : state.iconColor;
        PALETTE.forEach((p) => {
          const sw = document.createElement("button");
          const taken = p.hex === other;
          const on = state[state.target] === p.hex;
          sw.className = "avatar-cust__sw"
            + (p.light ? " avatar-cust__sw--light" : " avatar-cust__sw--dark")
            + (on ? " avatar-cust__sw--on" : "")
            + (taken ? " avatar-cust__sw--taken" : "");
          sw.style.background = p.hex;
          sw.setAttribute("aria-label", p.hex);
          sw.disabled = taken;
          if (!taken) {
            sw.addEventListener("click", () => {
              state[state.target] = p.hex;
              rerender();
            });
          }
          swatchEl.appendChild(sw);
        });
        noteEl.textContent = state.target === "iconColor"
          ? "Choosing the icon colour"
          : "Choosing the background colour";
      }

      function finish(picked) {
        if (picked) {
          // Validate the name field when it's part of the modal.
          const payload = {
            icon: ITEMS[state.index].key,
            iconColor: state.iconColor,
            bgColor: state.bgColor,
          };
          if (includeNameField) {
            const trimmed = (state.displayName || "").trim();
            if (!trimmed) {
              state.nameError = "Display name can't be empty.";
              if (nameErrorEl) { nameErrorEl.hidden = false; nameErrorEl.textContent = state.nameError; }
              if (nameInput) nameInput.focus();
              return;
            }
            payload.displayName = trimmed;
          }
          dismiss();
          resolve(payload);
        } else {
          dismiss();
          resolve(null);
        }
      }

      root.addEventListener("click", (ev) => {
        if (ev.target === root) finish(false);
      });
      const closeBtn = root.querySelector(".polaroid-popup__close");
      if (closeBtn) closeBtn.addEventListener("click", () => finish(false));
      const cancelBtn = root.querySelector(".polaroid-popup__cancel");
      if (cancelBtn) cancelBtn.addEventListener("click", () => finish(false));
      const saveBtn = root.querySelector(".polaroid-popup__confirm");
      if (saveBtn) saveBtn.addEventListener("click", () => finish(true));

      window.BgbIcons.render(root);
      rerender();
    });
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function initialsForCustomizer(name) {
    return (window.BgbBadge && window.BgbBadge.initialsOf)
      ? window.BgbBadge.initialsOf(name)
      : (String(name || "?").trim().slice(0, 2).toUpperCase() || "?");
  }

  window.PolaroidPopup = { show, update, dismiss, confirm, alert, avatarCustomizer };
})();
