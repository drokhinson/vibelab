// @ts-check
// widgets/achievement-sheet.js — one badge's detail, paging through its row.
//
// Opened from a tile on the Achievements spoke (views/achievements-view.js).
// The pages are the badges of the tapped tile's rail, in the rail's order.
// Every page is painted up front into one scroll-snapped track, so the
// neighbour is under the finger for the whole drag and a turn never creates
// or removes a page; the track's own overscroll is the rubber band at the
// ends. Arrows and an "N of M" count sit above it, and ←/→ turn too. The
// count, the label and the arrows follow the page under the finger, switching
// as the drag crosses halfway rather than when the snap settles. A row of one
// gets none of that.
//
// Its class is named in the theme re-point list in styles.css; a body-level
// sheet lands outside the screen that opened it (.claude/rules/theming.md §8).

(function () {
  const sheet = new window.BgbBottomSheet({
    id: "bgb-ach-sheet",
    className: "ach-sheet",
    label: "Achievement detail",
  });

  /** One page of the sheet. Pure: every page is painted by this. */
  function slide(a) {
    const src = window.Achievements.spriteUrl(a.icon);
    const pct = a.threshold > 1
      ? Math.min(100, Math.round((a.progress / a.threshold) * 100))
      : 0;
    const status = a.earned
      ? `<div class="ach-detail__status ach-detail__status--earned">
           <i data-icon="check" class="w-4 h-4"></i>
           Unlocked ${escapeHtml(formatDate(a.unlocked_at) || "")}
         </div>`
      // The tagline says what the badge is FOR in the past tense ("you've
      // played a game made for two"), so it only belongs on an earned badge;
      // while locked, the same fact is the requirement below, in the
      // imperative. Printing both would say it twice.
      //
      // The key glyph and the desaturated art carry "locked" visually, and
      // the requirement reads as a to-do rather than as something achieved
      // — but none of that reaches a screen reader, which would otherwise
      // hear only the instruction while the earned variant says "Unlocked"
      // outright. The word goes in visually-hidden text rather than on
      // screen, where it would just restate the picture.
      : `<div class="ach-detail__status">
           <i data-icon="key-round" class="w-4 h-4"></i>
           <span class="bgb-vis-hidden">Locked. To earn: </span>
           ${escapeHtml(a.requirement)}
         </div>`;
    // No bar once it is earned: the status pill above already says so, and
    // "10 / 10" on a badge you cleared 37 plays ago is noise.
    const bar = (!a.earned && a.threshold > 1)
      ? `<div class="ach-detail__progress">
           <div class="ach-detail__bar"><div class="ach-detail__bar-fill" style="width:${pct}%"></div></div>
           <div class="ach-detail__count">${a.progress} / ${a.threshold}</div>
         </div>`
      : "";
    return `
      <div class="ach-detail ${a.earned ? "is-earned" : "is-locked"}" data-ach-id="${escapeAttr(a.id)}">
        <img class="ach-detail__art" src="${escapeAttr(src)}" alt="" width="160" height="160" />
        <h3 class="ach-detail__name font-display">${escapeHtml(a.name)}</h3>
        ${a.earned ? `<p class="ach-detail__tagline">${escapeHtml(a.tagline)}</p>` : ""}
        ${status}
        ${bar}
      </div>
    `;
  }

  function label(a) {
    return a.earned ? `${a.name} — unlocked` : `${a.name} — locked`;
  }

  /**
   * @typedef {Object} AchievementSheetOpts
   * @property {any[]} row       The badges of one rail, in rail order.
   * @property {string} startId  The badge that was tapped.
   * @property {(a: any) => void} [onShow]  Each badge that becomes the open
   *   page, the first one included.
   */

  /** @param {AchievementSheetOpts} opts */
  function open(opts) {
    const row = opts.row || [];
    const start = Math.max(0, row.findIndex((x) => x.id === opts.startId));
    if (!row.length) return;
    const paged = row.length > 1;
    const onShow = opts.onShow || (() => {});
    /** @type {HTMLElement|null} */
    let track = null;
    let current = start;

    const width = () => (track ? track.clientWidth : 0);

    function settle(i) {
      const root = sheet.el;
      if (!root || !track) return;
      current = i;
      root.setAttribute("aria-label", label(row[i]));
      const count = root.querySelector(".ach-pager__count");
      if (count) count.textContent = `${i + 1} of ${row.length}`;
      root.querySelectorAll(".ach-pager__btn").forEach((b) => {
        const to = i + Number(b.getAttribute("data-step"));
        /** @type {HTMLButtonElement} */ (b).disabled = to < 0 || to >= row.length;
      });
      track.querySelectorAll(".ach-detail").forEach((el, k) => {
        if (k === i) el.removeAttribute("inert"); else el.setAttribute("inert", "");
      });
      onShow(row[i]);
    }

    function turn(step) {
      const to = current + step;
      if (!track || to < 0 || to >= row.length) return;
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      track.scrollTo({ left: to * width(), behavior: reduce ? "instant" : "smooth" });
    }

    /** @param {KeyboardEvent} e */
    function onKey(e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      turn(e.key === "ArrowLeft" ? -1 : 1);
    }

    const pager = paged
      ? `<div class="ach-pager">
           <button type="button" class="ach-pager__btn" data-step="-1" aria-label="Previous achievement">
             <i data-icon="chevron-left" class="w-5 h-5"></i>
           </button>
           <span class="ach-pager__count" aria-live="polite"></span>
           <button type="button" class="ach-pager__btn" data-step="1" aria-label="Next achievement">
             <i data-icon="chevron-right" class="w-5 h-5"></i>
           </button>
         </div>`
      : "";

    sheet.open({
      label: label(row[start]),
      html: `
        <div class="ach-sheet__panel bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          ${pager}
          <div class="ach-track${paged ? " ach-track--paged" : ""}">
            ${(paged ? row : [row[start]]).map(slide).join("")}
          </div>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Close</button>
        </div>
      `,
      onClick: (e) => {
        const btn = e.target instanceof Element && e.target.closest(".ach-pager__btn");
        if (btn) turn(Number(btn.getAttribute("data-step")));
      },
      onOpen: (root) => {
        track = /** @type {HTMLElement|null} */ (root.querySelector(".ach-track"));
        if (!paged) { onShow(row[start]); return; }
        if (!track) return;
        track.scrollLeft = start * width();
        settle(start);
        // Every scroll frame, not scrollend: the page whose larger half is on
        // screen is the current one, so the count turns at the midpoint.
        track.addEventListener("scroll", () => {
          const w = width();
          if (!w || !track) return;
          const i = Math.max(0, Math.min(row.length - 1, Math.round(track.scrollLeft / w)));
          if (i !== current) settle(i);
        }, { passive: true });
        document.addEventListener("keydown", onKey);
      },
      onClose: () => document.removeEventListener("keydown", onKey),
    });
  }

  window.AchievementSheet = { open, close: () => sheet.close() };
})();
