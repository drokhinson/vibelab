// ui/avatar-picker.js — the badge picker: icon carousel, colour target toggle,
// swatch grid.
//
// Extracted from PolaroidPopup.avatarCustomizer the moment it acquired a second
// caller — the onboarding deck's first slide (.claude/rules/ui-object-design.md
// §4, "extract at instance #2"). The split follows the rule's shape: this file
// owns the picker's own markup, state and behaviour; each caller keeps its own
// chrome (a polaroid card with Cancel/Save, or a slide with Continue) and
// decides when to read the value.
//
// The class family is unchanged — `.avatar-cust__*` — because the CSS was
// already right and moving it would have been a rename with no reader. What
// used to be one modal's private carousel is now a mountable component; that is
// the whole change.

(function () {
  /**
   * @typedef {Object} AvatarValue
   * @property {string} icon
   * @property {string} iconColor
   * @property {string} bgColor
   */

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function initialsOf(name) {
    return (window.BgbBadge && window.BgbBadge.initialsOf)
      ? window.BgbBadge.initialsOf(name)
      : (String(name || "?").trim().slice(0, 2).toUpperCase() || "?");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  /**
   * Mount the picker into `host`, replacing its contents.
   *
   * @param {HTMLElement} host
   * @param {Object} [opts]
   * @param {AvatarValue|null} [opts.current]  the user's badge; null = default
   * @param {string} [opts.displayName]  seeds the Initials slot
   * @returns {{value: function(): AvatarValue,
   *            setDisplayName: function(string): void,
   *            refresh: function(): void}}
   */
  function mount(host, opts) {
    const o = opts || {};
    const start = o.current || window.BgbBadge.DEFAULT;
    const ITEMS = window.BgbBadge.ITEMS;
    const PALETTE = window.BgbBadge.PALETTE;

    let index = ITEMS.findIndex((it) => it.key === start.icon);
    if (index < 0) index = 0;

    const state = {
      index,
      iconColor: start.iconColor,
      bgColor: start.bgColor,
      target: "iconColor",       // which colour the swatch grid is editing
      displayName: String(o.displayName || ""),
    };

    host.innerHTML = `
      <div class="avatar-cust__carousel">
        <button type="button" class="avatar-cust__arrow" data-step="-1" aria-label="Previous">
          <i data-icon="chevron-left" class="w-5 h-5"></i>
        </button>
        <div class="avatar-cust__reel">
          <div class="avatar-cust__badge"></div>
          <div class="avatar-cust__track"></div>
        </div>
        <button type="button" class="avatar-cust__arrow" data-step="1" aria-label="Next">
          <i data-icon="chevron-right" class="w-5 h-5"></i>
        </button>
      </div>
      <div class="avatar-cust__name-reel"><div class="avatar-cust__name-track"></div></div>
      <div class="avatar-cust__dots"></div>

      <div class="avatar-cust__target">
        <button type="button" class="avatar-cust__tg avatar-cust__tg--icon on" data-target="iconColor">
          <span class="avatar-cust__tg-dot"></span>Icon
        </button>
        <button type="button" class="avatar-cust__tg avatar-cust__tg--bg" data-target="bgColor">
          <span class="avatar-cust__tg-dot"></span>Background
        </button>
      </div>
      <div class="avatar-cust__swatches"></div>
      <div class="avatar-cust__note"></div>
    `;

    const track = host.querySelector(".avatar-cust__track");
    const nameTrack = host.querySelector(".avatar-cust__name-track");
    const dots = host.querySelector(".avatar-cust__dots");
    const badge = host.querySelector(".avatar-cust__badge");
    const swatchEl = host.querySelector(".avatar-cust__swatches");
    const noteEl = host.querySelector(".avatar-cust__note");
    const tgIcon = host.querySelector(".avatar-cust__tg--icon");
    const tgBg = host.querySelector(".avatar-cust__tg--bg");

    // Build the reel (one slot per icon option) + name track + dot row.
    ITEMS.forEach((it, i) => {
      const slot = document.createElement("div");
      slot.className = "avatar-cust__slot";
      slot.dataset.i = String(i);
      slot.innerHTML = it.key === "initials"
        ? `<span class="avatar-cust__ini">${escapeHtml(initialsOf(state.displayName))}</span>`
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

    host.querySelectorAll(".avatar-cust__arrow").forEach((btn) => {
      btn.addEventListener("click", () => {
        const dir = Number(btn.getAttribute("data-step")) || 0;
        state.index = clamp(state.index + dir, 0, ITEMS.length - 1);
        rerender();
      });
    });

    tgIcon.addEventListener("click", () => { state.target = "iconColor"; rerender(); });
    tgBg.addEventListener("click", () => { state.target = "bgColor"; rerender(); });

    function rerender() {
      // Slide the reel so the active slot lands centered on the badge. The
      // reel can flex-shrink to fit narrow widths, so the math has to read the
      // live rendered width — a hardcoded 240px would land the active slot
      // off-badge whenever flex took over. It also reads 0 while the host is
      // detached or display:none, which is why callers get refresh().
      const reelEl = /** @type {HTMLElement} */ (track.parentElement);
      const reelW = reelEl.getBoundingClientRect().width;
      const activeSlot = /** @type {HTMLElement} */ (track.children[state.index]);
      const slotCenter = activeSlot.offsetLeft + activeSlot.offsetWidth / 2;
      track.style.transform = `translateX(${reelW / 2 - slotCenter}px)`;
      // Name reel uses the same reel width so each name slot occupies one full
      // reel page; sliding by -index * reelW snaps the active name.
      nameTrack.querySelectorAll(".avatar-cust__name-slot").forEach((n) => {
        /** @type {HTMLElement} */ (n).style.width = reelW + "px";
      });
      nameTrack.style.transform = `translateX(${-state.index * reelW}px)`;

      Array.from(track.children).forEach((node, i) => {
        const el = /** @type {HTMLElement} */ (node);
        const active = i === state.index;
        el.classList.toggle("avatar-cust__slot--active", active);
        const g = el.querySelector("svg");
        const ini = el.querySelector(".avatar-cust__ini");
        if (g) /** @type {SVGElement} */ (g).style.color = active ? state.iconColor : "";
        if (ini) /** @type {HTMLElement} */ (ini).style.color = active ? state.iconColor : "";
      });
      badge.style.background = state.bgColor;
      Array.from(dots.children).forEach((d, i) => {
        d.classList.toggle("avatar-cust__dot--on", i === state.index);
      });

      const iconDot = tgIcon.querySelector(".avatar-cust__tg-dot");
      const bgDot = tgBg.querySelector(".avatar-cust__tg-dot");
      if (iconDot) /** @type {HTMLElement} */ (iconDot).style.background = state.iconColor;
      if (bgDot) /** @type {HTMLElement} */ (bgDot).style.background = state.bgColor;
      tgIcon.classList.toggle("on", state.target === "iconColor");
      tgBg.classList.toggle("on", state.target === "bgColor");

      swatchEl.innerHTML = "";
      const other = state.target === "iconColor" ? state.bgColor : state.iconColor;
      PALETTE.forEach((p) => {
        const sw = document.createElement("button");
        sw.type = "button";
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
          sw.addEventListener("click", () => { state[state.target] = p.hex; rerender(); });
        }
        swatchEl.appendChild(sw);
      });
      noteEl.textContent = state.target === "iconColor"
        ? "Choosing the icon colour"
        : "Choosing the background colour";
    }

    window.BgbIcons.render(host);
    rerender();

    return {
      value() {
        return {
          icon: ITEMS[state.index].key,
          iconColor: state.iconColor,
          bgColor: state.bgColor,
        };
      },
      /** Typing in the caller's own name field repaints the Initials slot. */
      setDisplayName(name) {
        state.displayName = String(name || "");
        const slot = track.querySelector(".avatar-cust__ini");
        if (slot) slot.textContent = initialsOf(state.displayName);
      },
      /**
       * Re-run the reel maths. Call after the host becomes visible or changes
       * width — a picker built off-screen measured its reel as 0 and left the
       * active slot parked at the left edge.
       */
      refresh() { rerender(); },
    };
  }

  window.BgbAvatarPicker = { mount };
})();
