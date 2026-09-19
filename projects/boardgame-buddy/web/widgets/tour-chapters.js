// widgets/tour-chapters.js — the feature tour's content, and the ONE place it
// lives.
//
// Three surfaces read this file: the tour deck (views/tour-view.js), the
// feature strip on the sign-in screen (ui/feature-strip.js), and the store
// listing (Docs/STORE_LISTING.md quotes it rather than re-writing it). The
// alternative was the same five claims drifting in three places, which is how
// an app ends up advertising a feature it renamed a year ago.
//
// COPY RULES, from Docs/BRAND_VOICE.md — read it before editing a line here:
//   • Name the night, not the feature. "Track your plays" is what every
//     competitor says and describes the least interesting half.
//   • Concrete beats abstract. "Who won" outperforms "memories" every time.
//   • No "actually" — it scolds the reader about their unplayed shelf. The
//     shelf-of-shame joke is for inside the app, made by a user about
//     themselves.
//   • Don't name a weekday. Half the audience plays Tuesdays.
//
// The closer's headline is "Your Games, Your People, Your Record." — the
// runner-up line BRAND_VOICE.md explicitly earmarks for a deck's slide and an
// app-store screenshot caption. It stays in the possessive; the version
// without "your" loses the whole point.
//
// `vignette` names a scene registered by widgets/tour-vignette-{ambient,
// scripted}.js. tools/check-tour.mjs asserts every one of them resolves.

(function () {
  /**
   * @typedef {Object} TourChapter
   * @property {string} slug      stable — appears in the URL as /tour?c=<slug>
   * @property {string} eyebrow
   * @property {string} title
   * @property {string} [body]  optional — a chapter whose scene carries the
   *   argument on its own says it once rather than twice
   * @property {(string|{text: string, beat: string})[]} points
   *   a plain string shows with the panel; `{text, beat}` waits for that beat
   *   of the chapter's scene, and shows anyway if the scene never runs
   * @property {string} vignette  a BgbTourVignette id
   * @property {string} mark      assets/sprites/features/bgb-feat-<mark>.svg
   * @property {string} strip     the one-liner the sign-in screen shows
   */

  /** @type {TourChapter[]} */
  const CHAPTERS = [
    {
      slug: "community",
      eyebrow: "Your people",
      title: "Your table, and your people",
      // No `body`. The scene under this chapter is a feed that scrolls
      // through three nights, and it says "every play lands in one shared
      // feed" better than a paragraph restating it underneath ever did.
      points: [
        "Add a friend by QR code, or by username",
        "See the games your friends are enjoying",
        // CAN CLAIM, not "are linked", and the distinction is the feature.
        // A ghost is a name somebody typed into a play they logged. When that
        // person signs up they ask, and the person who logged the plays
        // approves — widgets/ghost-claim-sheet.js promises "Nothing changes
        // until they say yes." in so many words. Do not let this line drift
        // into automatic matching, and do not reach for "merge accounts":
        // the app's verb is claim, and "ghost" is a word it already says out
        // loud on the Buddies screen and in every import step.
        "Ghosts you logged can claim their plays when they join",
      ],
      vignette: "community",
      mark: "community",
      strip: "One shared feed with the people you play with",
    },
    {
      slug: "guides",
      eyebrow: "Reference",
      title: "The rules, without the rulebook",
      body: "Somebody has already looked up the rule you are stuck on. Pull "
        + "their chapter into your own guide and read it at the table, in a "
        + "scroll built for one hand.",
      points: [
        "Setup, turn order, scoring, card references",
        "Written by players, sorted by how many use them",
        "Yours to edit once it is in your guide",
      ],
      vignette: "guides",
      mark: "guides",
      strip: "Community rules and references, read at the table",
    },
    {
      slug: "scoring",
      eyebrow: "Keep score",
      title: "Keep score for any game",
      // No `body`, and each point below names the BEAT of the scene that
      // demonstrates it. views/tour-view.js holds a gated point back until
      // widgets/tour-vignette-scripted.js reports that beat, so the claim
      // lands as the evidence does — a paragraph above the scene was making
      // all three arguments before the scene had made any of them.
      //
      // A beat name here is load-bearing twice over: tools/check-tour.mjs
      // asserts every one of them exists in the scene's beat list, because a
      // typo is not an error anybody sees — it is one bullet that never
      // appears, on a screen whose whole job is to make three claims.
      points: [
        { text: "Gather up — the game, its expansions, and who is playing",
          beat: "gather" },
        { text: "Live scoring — the same numbers on every screen",
          beat: "scores" },
        // "grids", not "templates": the community-authored thing is called a
        // scoring grid everywhere the user meets it.
        { text: "Community scoring grids, expansions and all",
          beat: "template-on" },
      ],
      vignette: "scoring",
      mark: "scoring",
      strip: "Live scoring, with per-game templates and expansions",
    },
    {
      slug: "stats",
      eyebrow: "Your record",
      title: "Your record, and the head-to-head",
      body: "Wins, podiums, streaks, and the game you are quietly bad at. And "
        + "because the log is shared, the comparison nothing else gives you: how you "
        + "do against the people you play with.",
      points: [
        "Podium, win rate, personal bests",
        "Head-to-head with everyone you have played",
        "Achievements, and a shelf of shame you can laugh at",
      ],
      vignette: "stats",
      mark: "stats",
      strip: "Your record — and the head-to-head against your table",
    },
    {
      slug: "discover",
      eyebrow: "What's next",
      title: "What to play next",
      body: "Picks drawn from the games you play most and the shelf you already "
        + "own, each one saying why it is there. Plus what is climbing on "
        + "BoardGameGeek this week.",
      points: [
        "Reasons, not rankings",
        "This year's releases",
        "The games on your shelf you have not touched",
      ],
      vignette: "discover",
      mark: "discover",
      strip: "What to play next, with the reason it was picked",
    },
  ];

  const CLOSER = {
    title: "Your Games, Your People, Your Record.",
    body: "Free to start. Bring your BoardGameGeek collection with you if you "
      + "have one.",
    ctaOut: "Create an account",
    ctaIn: "Back to the app",
  };

  window.TourChapters = {
    all: () => CHAPTERS.slice(),
    closer: () => CLOSER,
    /**
     * Resolve a `?c=` value to an index. Unknown or missing lands on 0 rather
     * than erroring — a stale marketing link should open the tour, not break.
     * @param {?string} slug
     */
    indexOf(slug) {
      const i = CHAPTERS.findIndex((c) => c.slug === slug);
      return i < 0 ? 0 : i;
    },
  };
})();
