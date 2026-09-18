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
  /** Move a track by N steps; the stylesheet decides what a step is. */
  const shift = (root, sel, n) => {
    const el = /** @type {HTMLElement} */ (root.querySelector(sel));
    if (el) el.style.setProperty("--vig-step", String(n));
  };

  const avatar = (initials, cls) =>
    `<span class="vig-av ${cls || ""}">${initials}</span>`;

  /**
   * A miniature of ui/play-card.js — the polaroid, scaled to about a third.
   *
   * Faithful in the four things that make it one: a PAPER body (cream in both
   * themes) with the app's ground showing around it, a photo frame whose empty
   * state is a flat --polaroid-line rectangle exactly as the real one's is,
   * the game name in the display face below it, and the winner on its own row
   * under a hairline reading "Won by <name> · <score>". No tilt — styles.css
   * says the nth-child rotations were removed on purpose and cards sit square.
   *
   * THE CROWN IS THE ONE THING THE REAL CARD DOES NOT HAVE, and it is here
   * deliberately: at ~100px wide the caption's winner line is 8px of muted
   * rust, which reads as texture rather than as a fact. So the crown marks the
   * plays the VIEWER won — not "this play has a winner", which is true of
   * every card and would make the mark say nothing.
   *
   * @param {{game: string, winner: string, score: string, mine?: boolean}} p
   */
  const playCard = (p) => `
    <article class="vfeed-card">
      <div class="vfeed-card__photo">
        <span class="vfeed-card__art" aria-hidden="true"></span>
        ${p.mine ? `<span class="vfeed-card__crown" aria-hidden="true">
          <i data-icon="crown" class="w-3 h-3"></i>
        </span>` : ""}
      </div>
      <div class="vfeed-card__cap">
        <span class="vfeed-card__name">${p.game}</span>
        <span class="vfeed-card__meta"><span class="vfeed-win"><span
          class="vfeed-win__label">Won by</span>${p.winner}<span
          class="vfeed-win__sep" aria-hidden="true"></span><span
          class="vfeed-win__score">${p.score}</span></span></span>
      </div>
    </article>`;

  // ── 1. Community — a game night, as the feed actually lays it out ─────────
  //
  // The real feed is not a vertical list of rows. views/feed-view.js emits a
  // day divider, then a session header naming who played, then a SIDEWAYS RAIL
  // of polaroids (.play-session__scroll), then one "Good game" pill for the
  // whole night — the pill sits outside the cards on purpose, because it
  // reacts to the night rather than to any one play. This mirrors that,
  // including the part that carries the most: the cards are paper and
  // everything around them is ground.
  // SIX, and the count is geometry rather than taste: the rail has to be
  // meaningfully wider than its clip or the slide beats move a rail that had
  // already fitted, leaving a third of the frame empty at the end of the loop.
  // styles.css caps the clip at 330px so this holds on every layout tier;
  // six 96px cards plus their gaps come to 616px, so both slide steps land
  // well inside the content.
  const NIGHT = [
    { game: "Arboretum", winner: "You",    score: "87",  mine: true },
    { game: "Wingspan",  winner: "Priya",  score: "102" },
    { game: "Cascadia",  winner: "You",    score: "94",  mine: true },
    { game: "Sagrada",   winner: "Marcus", score: "71" },
    { game: "Azul",      winner: "You",    score: "68",  mine: true },
    { game: "Calico",    winner: "Priya",  score: "55" },
  ];

  V.register({
    id: "community",
    label: "A game night in the feed: three plays, and the table saying good game",
    hold: 2600,
    html: `
      <div class="vig-chrome"><span class="vig-chrome__title">Feed</span></div>
      <div class="vfeed">
        <p class="vfeed__day">Saturday</p>
        <p class="vfeed__header"><b>You</b> and <b>Priya</b> played 6 games</p>
        <div class="vfeed__railclip">
          <div class="vfeed__rail" data-rail>
            ${NIGHT.map(playCard).join("")}
          </div>
        </div>
        <div class="vfeed__foot" data-kudos>
          <span class="vfeed__gg">
            <i data-icon="handshake" class="w-3 h-3"></i><span>Good game</span>
          </span>
          <span class="vfeed__faces">
            ${avatar("PR", "vig-av--xs")}${avatar("MA", "vig-av--xs")}
          </span>
          <span class="vfeed__ggwho" data-ggwho></span>
        </div>
      </div>`,
    reset(root) {
      shift(root, "[data-rail]", 0);
      flag(root, "[data-kudos]", "is-on", false);
      put(root, "[data-ggwho]", "");
    },
    beats: [
      // Sideways, because the rail is sideways. One step is one card plus its
      // gap; styles.css turns --vig-step into the travel, so this never has to
      // know a pixel measurement that lives there. Two steps is as far as the
      // rail can go without running out of cards — see NIGHT above.
      { name: "slide", at: 1800, apply: (r) => shift(r, "[data-rail]", 1) },
      { name: "kudos", at: 3400, apply: (r) => {
        flag(r, "[data-kudos]", "is-on", true);
        put(r, "[data-ggwho]", "Priya and Marcus said good game");
      } },
      { name: "more", at: 5200, apply: (r) => shift(r, "[data-rail]", 2) },
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
