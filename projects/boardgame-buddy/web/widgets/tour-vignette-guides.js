// widgets/tour-vignette-guides.js — chapter 2's scene: the community pool on
// top, your own reference guide filling up underneath.
//
// Split out of widgets/tour-vignette-scoring.js (which was
// tour-vignette-scripted.js, holding both) when this scene grew from one
// pick-and-unroll into a four-row pool over a list of collected chapters:
// the pair crossed the repo's ~300-line guideline, which is the same line
// the stats scene left over. Its sibling's header records that rule; this is
// it being followed.
//
// It duplicates the same small DOM helpers the other scene modules do, for
// the reason tour-vignette-stats.js sets out at length:
// .claude/rules/ui-object-design.md §4 puts the LIFECYCLE in the shell and
// leaves each caller its own markup, so sugar for a scene's own nodes is the
// caller's side of that line.

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

  // ── Guides — the pool on top, your guide filling up underneath ────────────
  //
  // WHAT THE SCENE HAS TO SAY, in the order it says it: these are selectable
  // (four empty ticks, one already filled), you pick from them, what you pick
  // lands in your guide as a chapter, and a chapter opens when you need it.
  //
  // THE FIRST TICK IS ALREADY FILLED, AND THAT IS THE POINT. A scoring grid
  // sits in the pool marked "in your guide", which is why the scroll below
  // starts with it. It teaches what the control means one beat before the
  // animation uses it — a ring that only appears once it is ticked, which is
  // what this had, reads as a row lighting up rather than as a choice.
  //
  // AND ONE ROW NEVER TICKS. It is what keeps the empty state on screen next
  // to the filled ones; with all four ticked there is nothing left to show
  // that the tick was ever a control.
  //
  // A SCORING GRID IS A CHAPTER OF A DIFFERENT KIND, and the real scroll
  // draws it LAST — widgets/reference-guide-scroll.js says why in its own
  // header: by display_order it came first, and a table that pushes the rule
  // somebody opened the scroll for below the fold is the wrong thing at the
  // top. So chapters land ABOVE it here and it stays at the bottom.
  //
  // The mock drops that scroll's per-section headers. Three of them do not
  // fit a 318px frame, and the ordering above is the part that carries
  // meaning — noted rather than hidden.
  const POOL = [
    { id: "grid",  title: "Arboretum scoring",      by: "in your guide", kind: "table",     mine: true },
    { id: "setup", title: "Setup, 2–4 players",     by: "used by 310",   kind: "box" },
    { id: "path",  title: "The path rule, plainly", by: "used by 96",    kind: "lightbulb" },
    { id: "score", title: "Scoring, walked through", by: "used by 142",  kind: "trophy" },
  ];

  // The scroll's rows, bottom-anchored on the grid. `body` is present on the
  // one chapter the scene opens; the text is already about paths and species,
  // which is why "The path rule, plainly" is the one that opens rather than
  // any rewriting being needed.
  const CHAPTERS = [
    { id: "setup", title: "Setup, 2–4 players", kind: "box" },
    { id: "path", title: "The path rule, plainly", kind: "lightbulb", body: `
        <p>Count each species you have the longest path of. Ties go to the
           player whose path has the higher-value end card.</p>
        <p>A path scores its full value only if every card in it shares a
           suit with the species you're claiming.</p>` },
    { id: "grid", title: "Arboretum scoring", kind: "table", always: true },
  ];

  V.register({
    id: "guides",
    label: "Picking community chapters into your own reference guide, and "
      + "opening one",
    hold: 3000,
    html: `
      <div class="vig-chrome"><span class="vig-chrome__title">Arboretum · Guide</span></div>
      <div class="vguide">
        <div class="vguide__pool">
          <p class="vguide__poolhead">From the community</p>
          ${POOL.map((c) => `
            <div class="vguide__row${c.mine ? " is-added" : ""}" data-row="${c.id}">
              <i data-icon="${c.kind}" class="w-4 h-4"></i>
              <span class="vguide__rowtitle">${c.title}</span>
              <span class="vguide__rowby" data-by>${c.by}</span>
              <span class="vguide__tick" aria-hidden="true">
                <i data-icon="check" class="w-3 h-3"></i>
              </span>
            </div>`).join("")}
        </div>
        <div class="vguide__scroll vguide__scroll">
          <p class="vguide__scrollhead">Your guide</p>
          <div class="vguide__chclip">
          <div class="vguide__chlist">
          ${CHAPTERS.map((c) => `
            <div class="vguide__ch${c.always ? " is-in" : ""}" data-ch="${c.id}">
              <div class="vguide__chrow">
                <i data-icon="${c.kind}" class="w-3.5 h-3.5"></i>
                <span class="vguide__chtitle">${c.title}</span>
                <i data-icon="chevron-right" class="w-3 h-3 vguide__chev"></i>
              </div>
              ${c.body ? `<div class="vguide__chbody"><div>${c.body}</div></div>` : ""}
            </div>`).join("")}
          </div>
          </div>
        </div>
      </div>`,
    reset(root) {
      // Everything the beats do, undone — except the grid's two, which are the
      // scene's starting state rather than something a beat produced.
      POOL.forEach((c) => {
        if (c.mine) return;
        mark(root, `[data-row="${c.id}"]`, "is-added", false);
        put(root, `[data-row="${c.id}"] [data-by]`, c.by);
      });
      CHAPTERS.forEach((c) => {
        if (!c.always) mark(root, `[data-ch="${c.id}"]`, "is-in", false);
        mark(root, `[data-ch="${c.id}"]`, "is-open", false);
        mark(root, `[data-ch="${c.id}"]`, "is-read", false);
      });
      mark(root, ".vguide__scroll", "has-open", false);
    },
    beats: [
      // Picked, and in the same breath it is in your guide — the real adopt is
      // one tap with an optimistic paint, not a two-step.
      { name: "pick", at: 1200, apply: (r) => {
        mark(r, '[data-row="setup"]', "is-added", true);
        put(r, '[data-row="setup"] [data-by]', "in your guide");
        mark(r, '[data-ch="setup"]', "is-in", true);
      } },
      { name: "added", at: 2600, apply: (r) => {
        mark(r, '[data-row="path"]', "is-added", true);
        put(r, '[data-row="path"] [data-by]', "in your guide");
        mark(r, '[data-ch="path"]', "is-in", true);
      } },
      // Docs/STORE_LISTING.md shot 5 is cut from this beat by name.
      // The list scrolls as the chapter opens, which is both what a real guide
      // does and what keeps the scoring grid on screen: it is the LAST row, so
      // an expanding chapter above it would otherwise push it out of the clip
      // — and a guide that loses the thing it started with is the opposite of
      // the point.
      { name: "open", at: 4000, apply: (r) => {
        mark(r, '[data-ch="path"]', "is-open", true);
        mark(r, ".vguide__scroll", "has-open", true);
      } },
      { name: "read", at: 6200, apply: (r) => mark(r, '[data-ch="path"]', "is-read", true) },
    ],
  });
})();
