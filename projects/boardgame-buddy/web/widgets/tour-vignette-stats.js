// widgets/tour-vignette-stats.js — the stats scene, on its own.
//
// Split out of widgets/tour-vignette-ambient.js when this chapter's animation
// grew from one stacked card into four that assemble a board. That file was
// already at the repo's ~300-line guideline with this scene inside it, and
// the note on the change that put it there said the next addition should
// trigger the split. This is that addition.
//
// IT DUPLICATES TWO FOUR-LINE DOM HELPERS RATHER THAN SHARING THEM. The
// alternative was promoting put()/flag() onto ui/tour-vignette.js's public
// API, and .claude/rules/ui-object-design.md §4 is explicit about where that
// line falls: the extracted shell owns the LIFECYCLE — the clock, the
// observer, teardown — and each caller keeps its own markup. Sugar for
// setting text on a scene's own nodes is the caller's side of it. Eight lines
// of duplication buys three scene modules that can be read one at a time.
//
// FOUR CARDS, ONE AT A TIME, THEN ALL FOUR.
// Each card arrives at the centre of the frame at 1.75x and holds while it is
// the only thing to read, then settles into its own quadrant as the next one
// arrives. Three of the four are the claims widgets/tour-chapters.js makes
// under the frame, in the order it makes them — and the last beat leaves
// all four cards up at once.
//
// THE DOCKING IS A TRANSFORM, NOT A CHANGE OF POSITION. Every card sits in
// its own grid cell the whole time; `is-hero` translates it half a cell
// towards the middle and scales it up. A card absolutely positioned while
// centred and then handed back to the grid would jump, because `position` is
// not animatable — and under the beat model that jump would happen on every
// loop, forever.

(function () {
  const V = window.BgbTourVignette;

  /** Set text on one element, idempotently. */
  const put = (root, sel, text) => {
    const el = root.querySelector(sel);
    if (el) el.textContent = text;
  };
  /** Set a custom property on one element, idempotently. */
  const setv = (root, sel, prop, val) => {
    const el = /** @type {HTMLElement} */ (root.querySelector(sel));
    if (el) el.style.setProperty(prop, val);
  };

  /**
   * Put one card centre-stage; everything already arrived stays arrived.
   *
   * Passing null docks whatever is centre-stage without bringing anything
   * new in, which is the last beat: the whole board, nothing singled out.
   * Idempotent by construction — it sets the state of every card from `key`
   * rather than toggling anything.
   */
  const focus = (root, key) => {
    root.querySelectorAll("[data-q]").forEach((el) => {
      if (el.getAttribute("data-q") === key) el.classList.add("is-in", "is-hero");
      else el.classList.remove("is-hero");
    });
    const grid = root.querySelector("[data-grid]");
    if (grid) grid.classList.toggle("has-hero", !!key);
  };

  // The numbers are set from JS rather than counted up in CSS: a count-up is
  // a sequence of values, and a value is exactly what a beat is for.
  const PODIUM = [
    { k: "gold",   label: "1st", to: 18, h: 100 },
    { k: "silver", label: "2nd", to: 11, h: 64 },
    { k: "bronze", label: "3rd", to: 7,  h: 42 },
  ];

  // A real achievement, not an invented one: 002_seed.sql seeds `wins_10` as
  // "Crowned" / "Logged 10 game wins.", and the badge is the same sprite
  // views/achievements-view.js paints. The medallion carries its own dark
  // ground in both themes on purpose (.claude/rules/assets.md) — it is a coin
  // on the table rather than a mark drawn against the surface — so it needs
  // no per-theme variant here either.
  const ACH = {
    name: "Crowned",
    sub: "Logged 10 game wins.",
    art: "assets/sprites/achievements/bgb-ach-crowned.svg",
  };

  V.register({
    id: "stats",
    label: "Four corners of your record: the podium, one game's numbers, a "
      + "head-to-head, and an achievement",
    hold: 2600,
    html: `
      <!-- "Stats" because that is what views/stats-view.js calls the screen,
           and because the top-left card is already titled "Your record" — the
           frame's title bar naming the same thing twice read as a mistake. -->
      <div class="vig-chrome"><span class="vig-chrome__title">Stats</span></div>
      <div class="vstat">
        <div class="vstat__grid" data-grid>

          <article class="vstat__q vstat__q--record" data-q="record">
            <p class="vstat__qt">Your record</p>
            <div class="vstat__podium">
              ${PODIUM.map((p) => `
                <div class="vstat__col">
                  <span class="vstat__n" data-n="${p.k}">0</span>
                  <span class="vstat__bar vstat__bar--${p.k}" data-bar="${p.k}"></span>
                  <span class="vstat__lbl">${p.label}</span>
                </div>`).join("")}
            </div>
            <span class="vstat__rate-track">
              <span class="vstat__rate-fill" data-rate></span>
            </span>
            <p class="vstat__rate-txt"><b data-rate-n>0%</b> win rate · 36 plays</p>
          </article>

          <article class="vstat__q vstat__q--game" data-q="game">
            <p class="vstat__qt">Arboretum</p>
            <dl class="vstat__rows">
              <div><dt>Plays</dt><dd>12</dd></div>
              <div><dt>Wins</dt><dd>5</dd></div>
              <div><dt>Best</dt><dd>87</dd></div>
            </dl>
          </article>

          <article class="vstat__q vstat__q--h2h" data-q="h2h">
            <p class="vstat__qt">Head-to-head</p>
            <div class="vstat__vs">
              <span class="vstat__side">
                <span class="vig-av vig-av--sm">YO</span><span>You</span>
              </span>
              <span class="vstat__score" data-h2h>—</span>
              <span class="vstat__side">
                <span class="vig-av vig-av--sm">MA</span><span>Marcus</span>
              </span>
            </div>
            <p class="vstat__vsnote">Across 11 plays together</p>
          </article>

          <article class="vstat__q vstat__q--ach" data-q="ach">
            <img class="vstat__badge" src="${ACH.art}" alt="" width="46" height="46" />
            <p class="vstat__achname">${ACH.name}</p>
            <p class="vstat__achsub">${ACH.sub}</p>
          </article>

        </div>
      </div>`,
    reset(root) {
      focus(root, null);
      root.querySelectorAll("[data-q]").forEach((el) => el.classList.remove("is-in"));
      PODIUM.forEach((p) => {
        put(root, `[data-n="${p.k}"]`, "0");
        setv(root, `[data-bar="${p.k}"]`, "--vig-h", "0%");
      });
      setv(root, "[data-rate]", "--vig-w", "0%");
      put(root, "[data-rate-n]", "0%");
      put(root, "[data-h2h]", "—");
    },
    beats: [
      // The podium and the win rate.
      { name: "record", at: 700, apply: (r) => {
        focus(r, "record");
        PODIUM.forEach((p) => {
          put(r, `[data-n="${p.k}"]`, String(p.to));
          setv(r, `[data-bar="${p.k}"]`, "--vig-h", p.h + "%");
        });
        setv(r, "[data-rate]", "--vig-w", "50%");
        put(r, "[data-rate-n]", "50%");
      } },
      // One game's own numbers; the head-to-head follows it.
      { name: "per-game", at: 2900, apply: (r) => focus(r, "game") },
      // `nemesis` keeps its name: Docs/STORE_LISTING.md cuts shot 6 from it.
      { name: "nemesis", at: 5100, apply: (r) => {
        focus(r, "h2h");
        put(r, "[data-h2h]", "4–7");
      } },
      // The badge pops.
      { name: "achievement", at: 7300, apply: (r) => focus(r, "ach") },
      // Everything docked, nothing singled out: the four claims side by side,
      // which is the frame the chapter ends on and the one reduced motion
      // holds.
      { name: "board", at: 9500, apply: (r) => focus(r, null) },
    ],
  });
})();
