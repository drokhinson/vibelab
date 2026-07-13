// ui/polaroid-popup.js — Splash polaroid for non-host joiners when the
// host wraps up. A medium cream card lands in the middle of the screen
// showing the game thumbnail + winner with a close (X) in the top-right.
// Dismiss invalidates the feed cache so the just-saved play card appears
// when the user lands back on the feed.

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
   * @property {() => void=} onDismiss — override default feed redirect.
   */

  /** @param {PolaroidPopupOptions} opts */
  function show(opts) {
    dismiss(); // singleton — never stack two
    const root = document.createElement("div");
    root.id = BACKDROP_ID;
    root.className = "polaroid-popup__backdrop"
      + (opts && opts.headline ? " polaroid-popup__backdrop--with-headline" : "");
    root.innerHTML = renderInner(opts);
    root.__opts = opts;
    root.addEventListener("click", (ev) => {
      // Click on the backdrop (but not on the card) dismisses.
      if (ev.target === root) handleDismiss(opts);
    });
    document.body.appendChild(root);
    if (window.lucide) window.lucide.createIcons({ root });
    // Wire the close button + (optional) View play link.
    const closeBtn = root.querySelector(".polaroid-popup__close");
    if (closeBtn) closeBtn.addEventListener("click", () => handleDismiss(opts));
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
  }

  /**
   * Refresh the popup contents in place (e.g. when phase=finalized
   * arrives after settle). Adds a "View play" CTA pointing at the saved
   * play. Safe to call when no popup is open — silently no-ops.
   */
  function update(partial) {
    const root = document.getElementById(BACKDROP_ID);
    if (!root) return;
    // Re-render the card with merged opts. Stash original opts on the
    // backdrop element so we don't lose game/winner on the update.
    const merged = { ...(root.__opts || {}), ...partial };
    root.innerHTML = renderInner(merged);
    root.__opts = merged;
    if (window.lucide) window.lucide.createIcons({ root });
    const closeBtn = root.querySelector(".polaroid-popup__close");
    if (closeBtn) closeBtn.addEventListener("click", () => handleDismiss(merged));
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
  }

  function dismiss() {
    const existing = document.getElementById(BACKDROP_ID);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  }

  function handleDismiss(opts) {
    dismiss();
    if (opts && typeof opts.onDismiss === "function") {
      try { opts.onDismiss(); } catch (_) {}
      return;
    }
    try { window.store.invalidate("feed"); } catch (_) {}
    window.router.go("feed");
  }

  function renderInner(opts) {
    const gameName = escape(opts.gameName || "Game over");
    const headline = opts.headline
      ? `<div class="polaroid-popup__headline">${escape(opts.headline)}</div>`
      : "";
    const winner = opts.winnerName
      ? `<div class="polaroid-popup__winner">
           <i data-lucide="trophy" class="w-4 h-4"></i>
           <span>${escape(opts.winnerName)}</span>
         </div>`
      : `<div class="polaroid-popup__winner polaroid-popup__winner--muted">No winner recorded</div>`;
    const photo = opts.gameThumbnail
      ? `<img class="polaroid-popup__photo" src="${escapeAttr(opts.gameThumbnail)}" alt="" />`
      : `<div class="polaroid-popup__photo polaroid-popup__photo--placeholder">
           <i data-lucide="dice-6" class="w-10 h-10"></i>
         </div>`;
    const viewBtn = opts.playId
      ? `<button class="polaroid-popup__view btn btn-ghost btn-sm" data-play-id="${escapeAttr(opts.playId)}">
           <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
           <span>View play</span>
         </button>`
      : "";
    return `
      ${headline}
      <div class="polaroid-popup__card" role="dialog" aria-modal="true" aria-label="Game wrapped up">
        <button class="polaroid-popup__close" aria-label="Close">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
        ${photo}
        <div class="polaroid-popup__title">${gameName}</div>
        ${winner}
        ${viewBtn}
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
          <div class="polaroid-popup__title">${escape(title)}</div>
          ${body ? `<p class="polaroid-popup__body">${escape(body)}</p>` : ""}
          <div class="polaroid-popup__actions">
            <button class="btn btn-ghost btn-sm polaroid-popup__cancel">${escape(cancelLabel)}</button>
            <button class="btn btn-primary btn-sm polaroid-popup__confirm">${escape(confirmLabel)}</button>
          </div>
        </div>
      `;
      root.addEventListener("click", (ev) => {
        if (ev.target === root) { dismiss(); resolve(false); }
      });
      document.body.appendChild(root);
      if (window.lucide) window.lucide.createIcons({ root });
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
          <div class="polaroid-popup__title">${escape(title)}</div>
          ${body ? `<p class="polaroid-popup__body">${escape(body)}</p>` : ""}
          <div class="polaroid-popup__actions">
            <button class="btn btn-primary btn-sm polaroid-popup__confirm">${escape(label)}</button>
          </div>
        </div>
      `;
      // Backdrop tap also resolves — the alert is informational, no
      // destructive consequence to dismissing it any way.
      root.addEventListener("click", (ev) => {
        if (ev.target === root) { dismiss(); resolve(); }
      });
      document.body.appendChild(root);
      if (window.lucide) window.lucide.createIcons({ root });
      const okBtn = root.querySelector(".polaroid-popup__confirm");
      if (okBtn) okBtn.addEventListener("click", () => { dismiss(); resolve(); });
    });
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }

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
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
          <div class="avatar-cust__body">
            <div class="polaroid-popup__title">${escape(headerTitle)}</div>

            ${nameFieldHtml}

            <div class="avatar-cust__carousel">
              <button class="avatar-cust__arrow" data-step="-1" aria-label="Previous">
                <i data-lucide="chevron-left" class="w-5 h-5"></i>
              </button>
              <div class="avatar-cust__reel">
                <div class="avatar-cust__badge"></div>
                <div class="avatar-cust__track"></div>
              </div>
              <button class="avatar-cust__arrow" data-step="1" aria-label="Next">
                <i data-lucide="chevron-right" class="w-5 h-5"></i>
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
              <button class="btn btn-primary btn-sm polaroid-popup__confirm">${escape(saveLabel)}</button>
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
          ? `<span class="avatar-cust__ini">${escape(initialsForCustomizer(state.displayName))}</span>`
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

      if (window.lucide) window.lucide.createIcons({ root });
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
