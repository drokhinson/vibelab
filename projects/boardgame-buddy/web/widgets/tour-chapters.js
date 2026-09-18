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
   * @property {string} body
   * @property {string[]} points
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
      body: "Add the people you sit down with. Every play lands in one shared "
        + "feed, grouped by the night it happened rather than scattered by who "
        + "got round to logging it.",
      points: [
        "Add a buddy by QR code, or by name",
        "One feed for everyone who was at the table",
        "Players without accounts still get counted",
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
      body: "Start a game, share the code, and everyone watches the same "
        + "scorepad. It stays generic until a community template turns it into "
        + "this game's — expansions and all.",
      points: [
        "A join code, and room for spectators",
        "A scoring template per game, kept by the community",
        "An expansion adds rows, or replaces them",
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
