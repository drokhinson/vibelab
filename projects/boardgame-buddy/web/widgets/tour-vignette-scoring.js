// widgets/tour-vignette-scoring.js — chapter 3's scene: Gather, live rounds,
// then a community scoring grid.
//
// Scripted rather than ambient, because a single frame of it is a lie. A
// scorepad is just a grid until you watch a community grid turn it into THIS
// game's scorepad — that transformation is the feature, and a screenshot of
// the finished table looks like a spreadsheet.
//
// It was tour-vignette-scripted.js and held the guides scene too, until the
// pair crossed the repo's ~300-line guideline and guides left for
// tour-vignette-guides.js. The file is named for what it contains now: a
// module called "scripted" holding one of the two scripted scenes would be
// the kind of name that outlives what it described
// (.claude/rules/ui-object-design.md §5).
//
// Beat names are a published contract — Docs/STORE_LISTING.md cuts three
// screenshots from this scene by name, and tools/check-tour.mjs pins them.
// Renaming one is a doc change too.
//
// The cast (Priya, Marcus, You) is shared with the other scenes so the tour
// reads as one evening rather than five unrelated demos. The game is
// Arboretum throughout, which is also what makes the expansion beat legible:
// you can see which rows were not there a moment ago.

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

  // ── Scoring — Gather, live rounds, then a community grid ──────────────────
  //
  // THREE STAGES: Gather, the live rounds, and a community grid. They are
  // the three claims widgets/tour-chapters.js makes under the frame, in the
  // order it makes them. Beat NAMES are a published contract —
  // Docs/STORE_LISTING.md cuts three screenshots from this scene by name,
  // and tools/check-tour.mjs pins them — so renaming one is a doc change.
  //
  // The scorepad is a PAPER surface (.claude/rules/theming.md §6) sitting on a
  // chrome screen, so .vscore__pad is a paper island in styles.css with its
  // class doubled to out-specify the (0,3,0) dark chrome branch. Read that
  // rule before touching its colours — a ground token here is a black box on
  // cream in one theme and invisible in the other.
  //
  // A TEMPLATE RELABELS ROWS, IT DOES NOT ADD A SECOND KIND OF ROW.
  // A scoring grid's `rowLabels` are index-aligned to the round index, so
  // applying one renames R1/R2 in place and may make the table longer. The
  // scores already typed stay exactly where they are — which is what the
  // confirm sheet promises in so many words, and why this scene can keep its
  // numbers across the template beat instead of re-entering them.
  const SEATS = ["Priya", "Marcus", "You"];
  // Per round, then what the template and the expansion each add. The running
  // total is precomputed rather than summed at runtime: a beat is a state
  // application, and a beat that accumulates is a beat that cannot be applied
  // twice.
  const R1 = ["8", "6", "11"];
  const R2 = ["4", "3", "4"];
  const T3 = ["3", "4", "2"];
  const E1 = ["0", "2", "4"];
  const TOT = {
    r1:   ["8", "6", "11"],
    r2:   ["12", "9", "15"],
    tmpl: ["15", "13", "17"],
    exp:  ["15", "15", "21"],
  };

  const cells = () => SEATS
    .map(() => '<span class="vscore__c" data-v>·</span>').join("");
  /** Write a row's cells left to right; anything unnamed goes back to the dot. */
  const fill = (root, sel, vals) => {
    root.querySelectorAll(sel).forEach((c, i) => {
      c.textContent = vals[i] == null ? "·" : vals[i];
    });
  };

  V.register({
    id: "scoring",
    label: "A live game: rounds scored as they happen, then a community "
      + "scoring grid and its expansion",
    // PACING IS THE POINT OF THIS SCENE, NOT DECORATION.
    //
    // It ran at roughly one beat a second and read as a flicker: one second to
    // take in a join code and three names, and one second on the GENERIC
    // scorepad before a template rewrote it. That second one is the whole
    // scene — you have to register "this grid is R1, R2 and nothing else"
    // before it changes, or the change is just a grid appearing. The gaps
    // between the three STAGES are ~2s each.
    //
    // The two round beats inside the play stage are the deliberate exception,
    // at 1.4s and 1.2s: typing a score and adding a round is one continuous
    // action at a table, and stretching it to the stage cadence made the
    // scorepad look slow to use, which is the opposite of the claim.
    hold: 3000,
    html: `
      <div class="vig-chrome"><span class="vig-chrome__title" data-step>Play · Gather</span></div>
      <div class="vscore">

        <div class="vscore__stage vscore__stage--lobby">
          <div class="vscore__picks">
            <span class="vscore__pick" data-pick="0">Arboretum</span>
            <span class="vscore__pick vscore__pick--exp" data-pick="1"
                  style="--exp-accent: var(--row-purple)">Expansion 1</span>
          </div>
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
            <span class="vscore__pill" data-pill="tmpl">Community grid</span>
            <span class="vscore__pill" data-pill="exp">Expansion 1</span>
          </div>
          <div class="vscore__pad vscore__pad">
            <div class="vscore__row vscore__row--head">
              <span class="vscore__lbl"></span>${SEATS
                .map((n) => `<span class="vscore__c">${n.slice(0, 3)}</span>`).join("")}
            </div>
            <div class="vscore__row" data-row="r1" style="--row-accent: var(--row-green)">
              <span class="vscore__lbl" data-lbl>R1</span>${cells()}
            </div>
            <div class="vscore__row vscore__row--grow" data-row="r2" data-grow="r2"
                 style="--row-accent: var(--row-blue)">
              <span class="vscore__lbl" data-lbl>R2</span>${cells()}
            </div>
            <div class="vscore__row vscore__row--grow is-tinted" data-row="t3" data-grow="tmpl"
                 style="--row-accent: var(--row-gold)">
              <span class="vscore__lbl" data-lbl>Cards in hand</span>${cells()}
            </div>
            <div class="vscore__row vscore__row--grow is-tinted is-exp" data-row="e1" data-grow="exp"
                 style="--row-accent: var(--row-rust); --exp-accent: var(--row-purple)">
              <span class="vscore__lbl" data-lbl>Expansion 1</span>${cells()}
            </div>
            <div class="vscore__row vscore__row--total">
              <span class="vscore__lbl">Total</span>${cells()}
            </div>
          </div>
          <span class="vscore__add" data-add>+ Round</span>
        </div>

        <div class="vscore__stage vscore__stage--settle">
          <i data-icon="crown" class="w-6 h-6"></i>
          <p class="vscore__winner">You win, 21</p>
          <p class="vscore__settlesub">Logged for all three of you</p>
        </div>

      </div>`,
    reset(root) {
      stage(root, "lobby");
      put(root, "[data-step]", "Play · Gather");
      mark(root, ".vscore__pick", "is-in", false);
      mark(root, ".vscore__seat", "is-in", false);
      mark(root, "[data-pill]", "is-on", false);
      mark(root, '[data-row="r1"], [data-row="r2"]', "is-tinted", false);
      mark(root, ".vscore__add", "is-armed", false);
      body(root, ".vscore").classList.remove("has-r2", "has-tmpl", "has-exp");
      put(root, '[data-row="r1"] [data-lbl]', "R1");
      put(root, '[data-row="r2"] [data-lbl]', "R2");
      fill(root, ".vscore__c[data-v]", []);
    },
    beats: [
      // The game, its expansions, and who is playing.
      { name: "gather", at: 700, apply: (r) => {
        mark(r, ".vscore__pick", "is-in", true);
        mark(r, ".vscore__seat", "is-in", true);
      } },
      { name: "play", at: 2900, apply: (r) => {
        stage(r, "pad");
        put(r, "[data-step]", "Play · Round 1");
      } },
      // The first round goes on the table.
      { name: "scores", at: 4300, apply: (r) => {
        fill(r, '[data-row="r1"] .vscore__c[data-v]', R1);
        fill(r, ".vscore__row--total .vscore__c[data-v]", TOT.r1);
        mark(r, ".vscore__add", "is-armed", true);
      } },
      { name: "round2", at: 5500, apply: (r) => {
        body(r, ".vscore").classList.add("has-r2");
        put(r, "[data-step]", "Play · Round 2");
        fill(r, '[data-row="r2"] .vscore__c[data-v]', R2);
        fill(r, ".vscore__row--total .vscore__c[data-v]", TOT.r2);
        mark(r, ".vscore__add", "is-armed", false);
      } },
      // The community grid lands. The rows that were R1 and R2 keep their
      // scores and take the grid's own labels and palette tint; the table
      // gets one row longer.
      { name: "template-on", at: 7500, apply: (r) => {
        const p = r.querySelector('[data-pill="tmpl"]');
        if (p) p.classList.add("is-on");
        body(r, ".vscore").classList.add("has-tmpl");
        put(r, '[data-row="r1"] [data-lbl]', "Species");
        put(r, '[data-row="r2"] [data-lbl]', "Largest path");
        mark(r, '[data-row="r1"], [data-row="r2"]', "is-tinted", true);
        fill(r, '[data-row="t3"] .vscore__c[data-v]', T3);
        fill(r, ".vscore__row--total .vscore__c[data-v]", TOT.tmpl);
      } },
      { name: "expansion-on", at: 9500, apply: (r) => {
        const p = r.querySelector('[data-pill="exp"]');
        if (p) p.classList.add("is-on");
        body(r, ".vscore").classList.add("has-exp");
        fill(r, '[data-row="e1"] .vscore__c[data-v]', E1);
        fill(r, ".vscore__row--total .vscore__c[data-v]", TOT.exp);
      } },
      { name: "settle", at: 11700, apply: (r) => {
        stage(r, "settle");
        put(r, "[data-step]", "Play · Settle up");
      } },
    ],
  });
})();
