// widgets/tour-vignette-ambient.js — the three looping tour scenes.
//
// Community, Stats and Discover. Each is a short ambient loop rather than a
// narrative: the feature is legible from one frame, so the motion's job is to
// say "this is live data", not to tell a story. The two features that DO need
// a story — a scoring template turning a blank scorepad into a specific game's,
// and a community chapter landing in your guide — are in the scripted module.
//
// Loaded lazily by views/tour-view.js via ui/lazy-script.js. See that file's
// header for why these are <link rel=prefetch> in index.html rather than
// <script src>: it keeps them out of the bundler's manifest and still inside
// the service worker's precache sweep.
//
// Everything here paints from the app's own tokens, so both themes work by
// construction and nothing needs a per-theme rule.

(function () {
  const V = window.BgbTourVignette;

  /** Set text on one element, idempotently. */
  const put = (root, sel, text) => {
    const el = root.querySelector(sel);
    if (el) el.textContent = text;
  };
  /** Toggle a state class on one element, idempotently. */
  const flag = (root, sel, cls, on) => {
    const el = root.querySelector(sel);
    if (el) el.classList.toggle(cls, on !== false);
  };
  /** Move the feed track by N cards. */
  const shift = (root, sel, n) => {
    const el = /** @type {HTMLElement} */ (root.querySelector(sel));
    if (el) el.style.setProperty("--vig-step", String(n));
  };

  const avatar = (initials, cls) =>
    `<span class="vig-av ${cls || ""}">${initials}</span>`;

  const playCard = (game, who, meta, extra) => `
    <article class="vfeed-card">
      <div class="vfeed-card__top">
        ${avatar(who.slice(0, 2).toUpperCase())}
        <div class="vfeed-card__who">
          <b>${who}</b>
          <span>${meta}</span>
        </div>
      </div>
      <div class="vfeed-card__game">
        <span class="vfeed-card__cover" aria-hidden="true"></span>
        <span class="vfeed-card__name">${game}</span>
      </div>
      ${extra || ""}
    </article>`;

  // ── 1. Community — the feed, and a kudos landing ───────────────────────────
  V.register({
    id: "community",
    label: "A shared feed of plays, with buddies reacting",
    hold: 1800,
    html: `
      <div class="vig-chrome"><span class="vig-chrome__title">Feed</span></div>
      <div class="vig-scroll">
        <div class="vfeed-track" data-track>
          <div class="vfeed-sec">Game night · Saturday</div>
          ${playCard("Arboretum", "Priya", "won · 3 players", `
            <div class="vfeed-kudos" data-kudos>
              <span class="vfeed-kudos__btn"><i data-icon="handshake" class="w-3 h-3"></i></span>
              <span class="vfeed-kudos__n" data-kudos-n>3</span>
            </div>`)}
          ${playCard("Wingspan", "Marcus", "2nd · 4 players")}
          <div class="vfeed-sec">Thursday</div>
          ${playCard("Cascadia", "You", "won · 2 players")}
        </div>
      </div>`,
    reset(root) {
      shift(root, "[data-track]", 0);
      flag(root, "[data-kudos]", "is-on", false);
      put(root, "[data-kudos-n]", "3");
    },
    beats: [
      { name: "scroll", at: 1100, apply: (r) => shift(r, "[data-track]", 1) },
      { name: "kudos", at: 2100, apply: (r) => {
        flag(r, "[data-kudos]", "is-on", true);
        put(r, "[data-kudos-n]", "4");
      } },
      { name: "more", at: 3300, apply: (r) => shift(r, "[data-track]", 2) },
    ],
  });

  // ── 2. Stats — the podium, the rate, the head-to-head ──────────────────────
  // The numbers are set from JS rather than animated in CSS: a count-up is a
  // sequence of values, and a value is exactly what a beat is for.
  const PODIUM = [
    { k: "gold", label: "1st", to: 18, h: 100 },
    { k: "silver", label: "2nd", to: 11, h: 64 },
    { k: "bronze", label: "3rd", to: 7, h: 42 },
  ];

  V.register({
    id: "stats",
    label: "A podium, a win rate and a head-to-head record",
    hold: 2000,
    html: `
      <div class="vig-chrome"><span class="vig-chrome__title">Your record</span></div>
      <div class="vstat">
        <div class="vstat__podium">
          ${PODIUM.map((p) => `
            <div class="vstat__col">
              <span class="vstat__n" data-n="${p.k}">0</span>
              <span class="vstat__bar vstat__bar--${p.k}" data-bar="${p.k}"></span>
              <span class="vstat__lbl">${p.label}</span>
            </div>`).join("")}
        </div>
        <div class="vstat__rate">
          <span class="vstat__rate-track"><span class="vstat__rate-fill" data-rate></span></span>
          <span class="vstat__rate-txt"><b data-rate-n>0%</b> win rate · 36 plays</span>
        </div>
        <div class="vstat__h2h" data-h2h>
          <span class="vstat__h2h-lbl">Nemesis</span>
          ${avatar("MA", "vig-av--sm")}
          <span class="vstat__h2h-name">Marcus</span>
          <span class="vstat__h2h-score" data-h2h-score>—</span>
        </div>
      </div>`,
    reset(root) {
      PODIUM.forEach((p) => {
        put(root, `[data-n="${p.k}"]`, "0");
        const bar = /** @type {HTMLElement} */ (root.querySelector(`[data-bar="${p.k}"]`));
        if (bar) bar.style.setProperty("--vig-h", "0%");
      });
      const fill = /** @type {HTMLElement} */ (root.querySelector("[data-rate]"));
      if (fill) fill.style.setProperty("--vig-w", "0%");
      put(root, "[data-rate-n]", "0%");
      flag(root, "[data-h2h]", "is-on", false);
      put(root, "[data-h2h-score]", "—");
    },
    beats: [
      { name: "podium", at: 500, apply: (r) => PODIUM.forEach((p) => {
        put(r, `[data-n="${p.k}"]`, String(p.to));
        const bar = /** @type {HTMLElement} */ (r.querySelector(`[data-bar="${p.k}"]`));
        if (bar) bar.style.setProperty("--vig-h", p.h + "%");
      }) },
      { name: "rate", at: 1500, apply: (r) => {
        const fill = /** @type {HTMLElement} */ (r.querySelector("[data-rate]"));
        if (fill) fill.style.setProperty("--vig-w", "50%");
        put(r, "[data-rate-n]", "50%");
      } },
      { name: "nemesis", at: 2500, apply: (r) => {
        flag(r, "[data-h2h]", "is-on", true);
        put(r, "[data-h2h-score]", "4–7");
      } },
    ],
  });

  // ── 3. Discover — a rail, and the reason under it ──────────────────────────
  // The reason line is the point, not the cover art: "Label a suggestion by its
  // reason, not by the number that ranked it" (.claude/rules/web-frontend.md).
  const PICKS = [
    { name: "Sagrada", why: "Plays like Azul, which you've logged 9 times" },
    { name: "Calico", why: "Tile-laying, 2 players — your usual table" },
    { name: "Verdant", why: "Same designers as Cascadia, on your shelf" },
    { name: "Sky Team", why: "Co-op for two, and you're 6–1 at co-ops" },
  ];

  // The four picks all fit the frame, so the motion is the ATTENTION moving
  // along them rather than the rail sliding: a rail that scrolls past its own
  // last tile leaves half the scene empty, and the tiles are not the point
  // anyway — the reason line under them is.
  const pickOn = (root, i) => {
    root.querySelectorAll(".vdisc__tile").forEach((el, n) => {
      el.classList.toggle("is-on", n === i);
    });
  };

  V.register({
    id: "discover",
    label: "Suggested games, each with the reason it was picked",
    hold: 1800,
    html: `
      <div class="vig-chrome"><span class="vig-chrome__title">Discover</span></div>
      <div class="vdisc">
        <div class="vdisc__rail" data-rail>
          ${PICKS.map((p) => `
            <div class="vdisc__tile">
              <span class="vdisc__cover" aria-hidden="true"></span>
              <span class="vdisc__name">${p.name}</span>
            </div>`).join("")}
        </div>
        <p class="vdisc__why" data-why>${PICKS[0].why}</p>
      </div>`,
    reset(root) {
      pickOn(root, 0);
      put(root, "[data-why]", PICKS[0].why);
    },
    beats: PICKS.slice(1).map((p, i) => ({
      name: "pick-" + (i + 2),
      at: 1300 * (i + 1),
      apply: (r) => { pickOn(r, i + 1); put(r, "[data-why]", p.why); },
    })),
  });
})();
