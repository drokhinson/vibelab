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
  /**
   * Move a track by N steps; the stylesheet decides what a step is.
   *
   * THE PROPERTY NAME IS AN ARGUMENT BECAUSE CUSTOM PROPERTIES INHERIT. The
   * feed nests one track inside another — the vertical one scrolls between
   * game nights and each night holds a horizontal rail of polaroids — and
   * with both reading `--vig-step` the value set on the outer track
   * inherited into every inner rail. Scrolling to the third night therefore
   * also shoved that night's cards two card-widths sideways, out of the clip:
   * a section with a header, a Good game pill and no games. Two axes, two
   * property names.
   */
  const shift = (root, sel, n, prop) => {
    const el = /** @type {HTMLElement} */ (root.querySelector(sel));
    if (el) el.style.setProperty(prop || "--vig-step", String(n));
  };

  const avatar = (initials, cls) =>
    `<span class="vig-av ${cls || ""}">${initials}</span>`;

  /**
   * A miniature of ui/play-card.js — the polaroid, scaled to about a third.
   *
   * Faithful in the four things that make it one: a PAPER body (cream in both
   * themes) with the app's ground showing around it, a photo frame carrying
   * stand-in box art,
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
   * THE COVERS ARE INVENTED, and they have to be. The real card's no-art state
   * is a flat --polaroid-line rectangle, which is honest in the app and reads
   * as a broken image in a marketing mock — six grey holes where the reason to
   * care should be. Each fixture carries a `hue` instead and the stylesheet
   * builds an abstract cover from it, so the rail reads as six different games
   * at a glance. A hue is data-derived and rides as a custom property, which
   * is the one legitimate inline-colour case (.claude/rules/theming.md §10).
   *
   * @param {{game: string, winner: string, score: string, mine?: boolean,
   *          hue: number}} p
   */
  const playCard = (p) => `
    <article class="vfeed-card">
      <div class="vfeed-card__photo">
        <span class="vfeed-card__art" style="--vig-hue:${p.hue}" aria-hidden="true"></span>
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

  // ── 1. Community — the feed, scrolling, as feed-view.js lays it out ──────
  //
  // Three sessions across three days, because one game night demonstrates a
  // rail and the feature is a FEED. What the real screen does, and therefore
  // what this mirrors (views/feed-view.js):
  //
  //   • A day divider above that day's first session — Today / Yesterday /
  //     a short date (helpers.js#formatRelativeDay).
  //   • A header naming who played. Names join as "You and Priya" or
  //     "You, Marcus, and Ada", with "You" floated to the front, and the
  //     trailing clause is the GAME NAME when the night is one play and
  //     "N games" otherwise — never "1 game".
  //   • A sideways rail of polaroids. A one-game night uses the SAME rail and
  //     only centres its lone tile (styles.css:4110); it does not get a
  //     second layout, so neither does this.
  //   • One "Good game" pill per night — and none at all when every play in
  //     the night is the viewer's own, which is why Yesterday has none.
  const TODAY = [
    { game: "Arboretum", winner: "You",    score: "87",  mine: true, hue: 104 },
    { game: "Wingspan",  winner: "Priya",  score: "102",             hue: 196 },
    { game: "Cascadia",  winner: "You",    score: "94",  mine: true, hue: 28  },
    { game: "Sagrada",   winner: "Marcus", score: "71",              hue: 268 },
    { game: "Azul",      winner: "You",    score: "68",  mine: true, hue: 220 },
    { game: "Calico",    winner: "Priya",  score: "55",              hue: 340 },
  ];
  const SOLO = [
    { game: "Cascadia",  winner: "You",    score: "104", mine: true, hue: 28  },
  ];
  const SATURDAY = [
    { game: "Verdant",   winner: "Ada",    score: "63",              hue: 128 },
    { game: "Sky Team",  winner: "You",    score: "9",   mine: true, hue: 202 },
  ];

  const goodGame = () => `
    <div class="vfeed__foot" data-kudos>
      <span class="vfeed__gg">
        <i data-icon="handshake" class="w-3 h-3"></i><span>Good game</span>
      </span>
      <span class="vfeed__faces">
        ${avatar("PR", "vig-av--xs")}${avatar("MA", "vig-av--xs")}
      </span>
      <span class="vfeed__ggwho" data-ggwho></span>
    </div>`;

  /**
   * One day's session. `single` centres the lone card and drops the rail's
   * travel, exactly as .play-session--single does.
   */
  const session = (day, header, plays, opts) => {
    const o = opts || {};
    return `
      <section class="vfeed__sec">
        <p class="vfeed__day">${day}</p>
        <p class="vfeed__header">${header}</p>
        <div class="vfeed__railclip">
          <div class="vfeed__rail${o.single ? " vfeed__rail--single" : ""}"
               ${o.rail ? "data-rail" : ""}>
            ${plays.map(playCard).join("")}
          </div>
        </div>
        ${o.foot ? goodGame() : ""}
      </section>`;
  };

  V.register({
    id: "community",
    label: "Three game nights in the feed, scrolling, with the table saying good game",
    hold: 2800,
    html: `
      <div class="vig-chrome"><span class="vig-chrome__title">Feed</span></div>
      <div class="vfeed">
        <div class="vfeed__track" data-feed>
          ${session("Today", "<b>You</b> and <b>Priya</b> played 6 games",
                    TODAY, { rail: true, foot: true })}
          ${session("Yesterday", "<b>You</b> played Cascadia",
                    SOLO, { single: true })}
          ${session("Sat 13", "<b>You</b>, <b>Marcus</b>, and <b>Ada</b> played 2 games",
                    SATURDAY, { foot: true })}
        </div>
      </div>`,
    reset(root) {
      shift(root, "[data-feed]", 0, "--vig-vstep");
      shift(root, "[data-rail]", 0);
      flag(root, "[data-kudos]", "is-on", false);
      put(root, "[data-ggwho]", "");
    },
    beats: [
      // Sideways first, on the night that has somewhere to go. One step is one
      // card plus its gap; the stylesheet turns --vig-step into the travel, so
      // this never has to know a pixel measurement that lives there.
      { name: "slide", at: 1600, apply: (r) => shift(r, "[data-rail]", 1) },
      { name: "kudos", at: 3200, apply: (r) => {
        flag(r, "[data-kudos]", "is-on", true);
        put(r, "[data-ggwho]", "Priya and Marcus said good game");
      } },
      // Then down the feed. Sections are a uniform height, so one vertical
      // step is one section and the arithmetic is the rail's again.
      { name: "scroll", at: 5000, apply: (r) => shift(r, "[data-feed]", 1, "--vig-vstep") },
      { name: "more",   at: 7000, apply: (r) => shift(r, "[data-feed]", 2, "--vig-vstep") },
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
    { name: "Sagrada", hue: 268, why: "Plays like Azul, which you've logged 9 times" },
    { name: "Calico", hue: 340, why: "Tile-laying, 2 players — your usual table" },
    { name: "Verdant", hue: 128, why: "Same designers as Cascadia, on your shelf" },
    { name: "Sky Team", hue: 202, why: "Co-op for two, and you're 6–1 at co-ops" },
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
              <span class="vdisc__cover" style="--vig-hue:${p.hue}" aria-hidden="true"></span>
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
