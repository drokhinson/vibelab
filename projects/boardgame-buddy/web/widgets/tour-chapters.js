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
      strip: "See the games your friends are playing on the feed",
    },
    {
      slug: "guides",
      eyebrow: "Reference",
      title: "The rules, without the rulebook",
      // No `body` — no chapter has one now. This scene watches a community
      // chapter land in your own guide, which is what the paragraph was
      // describing in words underneath it.
      points: [
        "Setup, turn order, scoring, card references",
        "Write a chapter or select from community generated content",
        "Personalize your guide with game rules and tips",
      ],
      vignette: "guides",
      mark: "guides",
      strip: "Jot down notes and rule clarifications in your own reference guide",
    },
    {
      slug: "scoring",
      eyebrow: "Keep score",
      title: "Rules and scoring",
      // No `body`. The scene runs Gather → live rounds → a community grid,
      // and these three lines are the claims it is evidence for.
      points: [
        "Gather up — the game, its expansions, and who is playing",
        "Live scoring — no scorepad, no problem",
        // CREATE and SHARE, not "moderated". A grid is a community-written
        // chapter anybody can publish; what moderation exists is an admin
        // acting on reports (api/routes/chapter_routes.py), which is not the
        // same claim and not one this line should be making.
        "Create and share scoring grid templates",
      ],
      vignette: "scoring",
      mark: "scoring",
      strip: "Record your games with the built-in score sheet",
    },
    {
      slug: "stats",
      eyebrow: "Your record",
      title: "See your stats",
      // No `body`. The scene assembles four cards — the podium, one game's
      // numbers, a head-to-head and an achievement — which is the paragraph's
      // argument made in pictures.
      points: [
        "Podium, win rate, personal bests",
        "Per game, or head-to-head against the people you play with",
        "Earn achievements as you play",
      ],
      vignette: "stats",
      mark: "stats",
      strip: "See your boardgaming stats — dig down per game, or per opponent",
    },
    {
      slug: "discover",
      eyebrow: "What's next",
      title: "What to play next",
      // No `body`. The scene already shows a pick with the reason under it,
      // which is the whole of what the old paragraph said.
      //
      points: [
        "Tailored recommendations, drawn from the games you play most",
        "Full BoardGameGeek integration — your collection, and what is hot",
        // The feature is retail PARTNER LINKS under a game (domain/affiliate.js),
        // and they stay hidden until an admin switches a partner on. So the
        // line promises where to buy from a partner, not a price guarantee.
        "Deals from our retail partners, on the game's own page",
      ],
      vignette: "discover",
      mark: "discover",
      strip: "Discover what to play next, based on the games you play now",
    },
  ];

  // The sign-in strip's order, which is NOT the deck's. The deck opens on
  // "your people" because a tour is a narrative and that is where the app
  // starts for a newcomer; the strip is a pitch read in three seconds, so it
  // leads with the thing a stranger came for — the score sheet. The lines
  // themselves still live on the chapters, so the two surfaces cannot end up
  // advertising different products.
  const STRIP_ORDER = ["scoring", "community", "guides", "stats", "discover"];

  const CLOSER = {
    title: "Your Games, Your People, Your Record.",
    body: "Free to start. Bring your BoardGameGeek collection with you if you "
      + "have one.",
    ctaOut: "Create an account",
    ctaIn: "Back to the app",
  };

  window.TourChapters = {
    all: () => CHAPTERS.slice(),
    /** The chapters in the sign-in strip's order. @returns {TourChapter[]} */
    strip: () => STRIP_ORDER
      .map((slug) => CHAPTERS.find((c) => c.slug === slug))
      .filter(Boolean),
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
