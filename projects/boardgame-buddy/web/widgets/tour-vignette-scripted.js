// widgets/tour-vignette-scripted.js — the two tour scenes that tell a story.
//
// GUIDES and SCORING. These two are scripted rather than ambient because a
// single frame of either one is a lie:
//
//   • A scorepad is just a grid until you watch a community template turn it
//     into THIS game's scorepad. That transformation is the feature; a
//     screenshot of the finished grid looks like a spreadsheet.
//   • A reference guide is just text until you watch a chapter somebody else
//     wrote land in yours.
//
// Beat names are a published contract — Docs/STORE_LISTING.md cites
// `scoring @ template-on` as the frame a store screenshot is cut from, and
// tools/check-tour.mjs pins them. Renaming one is a doc change too.
//
// The cast (Priya, Marcus, You) is shared with the ambient scenes so the tour
// reads as one evening rather than five unrelated demos. The game is Arboretum
// throughout, which is also what makes the expansion beat legible: you can see
// which rows were not there a moment ago.

(function () {
  const V = window.BgbTourVignette;

  const put = (root, sel, text) => {
    const el = root.querySelector(sel);
    if (el) el.textContent = text;
  };
  const mark = (root, sel, cls, on) => {
    root.querySelectorAll(sel).forEach((el) => el.classList.toggle(cls, on !== false));
  };
  /**
   * The element a scene's own state classes belong on.
   *
   * ui/tour-vignette.js hands reset() and apply() the SCREEN wrapper
   * (.vig__screen), which holds the scene's title bar and its body as
   * siblings. Every state selector in styles.css is written against the body
   * — `.vscore[data-stage="pad"]`, `.vguide.is-open` — so putting a class on
   * what apply() was handed silently matches nothing: the scene advances, the
   * title bar updates, and the stage underneath it stays blank. Resolve the
   * body first.
   */
  const body = (root, sel) => root.querySelector(sel) || root;
  const stage = (root, name) => { body(root, ".vscore").dataset.stage = name; };

  // ── Guides — a community chapter lands in your own guide ───────────────────
  const POOL = [
    { title: "Setup, 2–4 players", by: "used by 310", kind: "box" },
    { title: "Scoring, walked through", by: "used by 142", kind: "trophy" },
    { title: "The path rule, plainly", by: "used by 96", kind: "lightbulb" },
  ];

  V.register({
    id: "guides",
    label: "Adding a community-written chapter to your own reference guide",
    hold: 2400,
    html: `
      <div class="vig-chrome"><span class="vig-chrome__title">Arboretum · Guide</span></div>
      <div class="vguide">
        <div class="vguide__pool">
          <p class="vguide__poolhead">From the community</p>
          ${POOL.map((c, i) => `
            <div class="vguide__row" data-row="${i}">
              <i data-icon="${c.kind}" class="w-4 h-4"></i>
              <span class="vguide__rowtitle">${c.title}</span>
              <span class="vguide__rowby">${c.by}</span>
              <span class="vguide__tick" aria-hidden="true">
                <i data-icon="check" class="w-3 h-3"></i>
              </span>
            </div>`).join("")}
        </div>
        <div class="vguide__scroll" data-scroll>
          <div class="vguide__scrollinner">
            <h4>Scoring, walked through</h4>
            <p>Count each species you have the longest path of. Ties go to the
               player whose path has the higher-value end card.</p>
            <p>A path scores its full value only if every card in it shares a
               suit with the species you're claiming.</p>
          </div>
        </div>
      </div>`,
    reset(root) {
      mark(root, ".vguide__row", "is-picked", false);
      mark(root, ".vguide__row", "is-added", false);
      body(root, ".vguide").classList.remove("is-open", "is-read");
    },
    beats: [
      { name: "pick", at: 900, apply: (r) => {
        const row = r.querySelector('[data-row="1"]');
        if (row) row.classList.add("is-picked");
      } },
      { name: "added", at: 1700, apply: (r) => {
        const row = r.querySelector('[data-row="1"]');
        if (row) row.classList.add("is-added");
        put(r, '[data-row="1"] .vguide__rowby', "in your guide");
      } },
      { name: "open", at: 2400, apply: (r) => body(r, ".vguide").classList.add("is-open") },
      { name: "read", at: 3600, apply: (r) => body(r, ".vguide").classList.add("is-read") },
    ],
  });

  // ── Scoring — Gather, then a template, then an expansion, then a winner ────
  //
  // The scorepad is a PAPER surface (.claude/rules/theming.md §6) sitting on a
  // chrome screen, so .vscore__pad is a paper island in styles.css with its
  // class doubled to out-specify the (0,3,0) dark chrome branch. Read that
  // rule before touching its colours — a ground token here is a black box on
  // cream in one theme and invisible in the other.
  const SEATS = ["Priya", "Marcus", "You"];
  // [row label, class, the three scores]
  const ROWS = [
    ["Score", "", ["—", "—", "—"]],
    ["Species", "is-tmpl", ["12", "9", "15"]],
    ["Largest path", "is-tmpl", ["6", "8", "6"]],
    ["Cards in hand", "is-tmpl", ["3", "4", "2"]],
    ["Promo trees", "is-exp", ["0", "2", "4"]],
  ];
  const TOTALS = ["21", "23", "27"];

  const cells = (vals) => vals
    .map((v) => `<span class="vscore__c" data-v="${v}">·</span>`).join("");

  V.register({
    id: "scoring",
    label: "A live game: a blank scorepad becomes Arboretum's, then settles up",
    hold: 2600,
    html: `
      <div class="vig-chrome"><span class="vig-chrome__title" data-step>Play · Gather</span></div>
      <div class="vscore">

        <div class="vscore__stage vscore__stage--lobby">
          <span class="vscore__codelbl">Join code</span>
          <span class="vscore__code">RPX4</span>
          <div class="vscore__seats">
            ${SEATS.map((n, i) => `
              <span class="vscore__seat" data-seat="${i}">
                <span class="vig-av vig-av--sm">${n.slice(0, 2).toUpperCase()}</span>
                <span>${n}</span>
              </span>`).join("")}
          </div>
        </div>

        <div class="vscore__stage vscore__stage--pad">
          <div class="vscore__pills">
            <span class="vscore__pill is-base">Arboretum</span>
            <span class="vscore__pill" data-pill="tmpl">Community scoring</span>
            <span class="vscore__pill" data-pill="exp">+ Promo trees</span>
          </div>
          <div class="vscore__pad vscore__pad">
            <div class="vscore__row vscore__row--head">
              <span class="vscore__lbl"></span>${SEATS
                .map((n) => `<span class="vscore__c">${n.slice(0, 3)}</span>`).join("")}
            </div>
            ${ROWS.map(([label, cls, vals]) => `
              <div class="vscore__row ${cls}">
                <span class="vscore__lbl">${label}</span>${cells(vals)}
              </div>`).join("")}
            <div class="vscore__row vscore__row--total">
              <span class="vscore__lbl">Total</span>${cells(TOTALS)}
            </div>
          </div>
        </div>

        <div class="vscore__stage vscore__stage--settle">
          <i data-icon="crown" class="w-6 h-6"></i>
          <p class="vscore__winner">You win, 27</p>
          <p class="vscore__settlesub">Logged for all three of you</p>
        </div>

      </div>`,
    reset(root) {
      stage(root, "lobby");
      put(root, "[data-step]", "Play · Gather");
      mark(root, ".vscore__seat", "is-in", false);
      mark(root, "[data-pill]", "is-on", false);
      body(root, ".vscore").classList.remove("has-tmpl", "has-exp", "is-scored");
      root.querySelectorAll(".vscore__c[data-v]").forEach((c) => { c.textContent = "·"; });
    },
    beats: [
      { name: "lobby", at: 400, apply: (r) => mark(r, ".vscore__seat", "is-in", true) },
      { name: "play", at: 1400, apply: (r) => {
        stage(r, "pad");
        put(r, "[data-step]", "Play · Scoring");
      } },
      { name: "template-on", at: 2400, apply: (r) => {
        const p = r.querySelector('[data-pill="tmpl"]');
        if (p) p.classList.add("is-on");
        body(r, ".vscore").classList.add("has-tmpl");
      } },
      { name: "expansion-on", at: 3400, apply: (r) => {
        const p = r.querySelector('[data-pill="exp"]');
        if (p) p.classList.add("is-on");
        body(r, ".vscore").classList.add("has-exp");
      } },
      { name: "scored", at: 4300, apply: (r) => {
        body(r, ".vscore").classList.add("is-scored");
        r.querySelectorAll(".vscore__c[data-v]").forEach((c) => {
          c.textContent = /** @type {HTMLElement} */ (c).dataset.v || "·";
        });
      } },
      { name: "settle", at: 5600, apply: (r) => {
        stage(r, "settle");
        put(r, "[data-step]", "Play · Settle up");
      } },
    ],
  });
})();
