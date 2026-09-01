// domain/notifications.js — the transient-notification registry.
//
// One table saying, for every signal the app can raise: which store slot
// carries its count, which bottom-nav tab it sits behind, which section of the
// Profile hub resolves it, and how to say it out loud.
//
// Before this existed the same three sums were written by hand in two places —
// init.js#syncNavDots and profile-self-view.js#_renderBuddiesPreview — and a
// fourth signal meant editing both and remembering the aria-label in one of
// them. The table below is the single place that knows.
//
// A signal belongs here when it is TRANSIENT: the user acts on it once and it
// is gone. "Buddies you may know" and the played-with roster are deliberately
// absent — they never resolve to zero, so a dot fed by them would be lit
// forever and would stop meaning anything.
//
// To add one: append a row, publish the count into its slot from wherever
// knows the number, and — if its tab has no dot yet — drop a
// `<span class="bgb-nav__dot" aria-hidden="true" hidden>` into that tab in
// index.html. Nothing else changes.

(function () {
  const SIGNALS = [
    {
      slot: "buddyRequestCount",
      tab: "profile-self",
      section: "buddies",
      label: (n) => `${n} buddy request${n === 1 ? "" : "s"}`,
    },
    {
      slot: "ghostClaimRequestCount",
      tab: "profile-self",
      section: "buddies",
      label: (n) => `${n} link request${n === 1 ? "" : "s"}`,
    },
    {
      slot: "ghostClaimSuggestionCount",
      tab: "profile-self",
      section: "buddies",
      label: (n) => `${n} possible match${n === 1 ? "" : "es"}`,
    },
    {
      slot: "achievementUnseenCount",
      tab: "profile-self",
      section: "achievements",
      label: (n) => `${n} new achievement${n === 1 ? "" : "s"}`,
    },
  ];

  // Same clamp the hand-written sums used: a slot can hold whatever a caller
  // put there, and a negative or a NaN must read as "nothing waiting" rather
  // than poisoning the total.
  function read(slot) {
    return Math.max(0, Number(window.store.get(slot)) || 0);
  }

  /**
   * Sum the signals matching `match` (a subset of {tab, section}).
   *
   * Returns { total, parts }, where `parts` names each contributing signal
   * separately — a bare "3" in a card corner or on a tab tells a screen reader
   * nothing about what there are three of.
   *
   * Each part is a NOUN phrase ("2 buddy requests"), never a sentence: the
   * caller picks the conjunction — the nav bar reads a list (", "), a hub card
   * reads a sentence (" and ") — and appends the one verb after the join, so
   * "waiting" lands once at the end instead of after every clause.
   */
  function tally(match) {
    let total = 0;
    const parts = [];
    for (const sig of SIGNALS) {
      let ok = true;
      for (const k in match) if (sig[k] !== match[k]) ok = false;
      if (!ok) continue;
      const n = read(sig.slot);
      if (!n) continue;
      total += n;
      parts.push(sig.label(n));
    }
    return { total, parts };
  }

  const BgbNotifications = {
    /**
     * Join parts into one readable clause: "a", "a and b", "a, b and c".
     *
     * A plain `.join(" and ")` was fine while a card could only ever sum two
     * signals; the third made it read "a and b and c". The nav bar joins with
     * ", " instead — it is announcing a list, not speaking a sentence.
     */
    phrase(parts) {
      if (parts.length < 2) return parts[0] || "";
      return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
    },

    /** Every slot in the table, deduplicated — for store.subscribe / View#listen loops. */
    slots() {
      return Array.from(new Set(SIGNALS.map((s) => s.slot)));
    },

    /** What is waiting behind one bottom-nav tab, by its data-nav value. */
    forTab(navName) {
      return tally({ tab: navName });
    },

    /** What is waiting behind one Profile hub section, by its section key. */
    forSection(key) {
      return tally({ section: key });
    },

    /**
     * Run `fn` whenever any signal changes. Returns one unsubscribe for all of
     * them. `fn` takes no useful argument: it fires for a single slot but the
     * surfaces it drives need the whole tally, so they re-read.
     */
    subscribe(fn) {
      const offs = BgbNotifications.slots().map((slot) => window.store.subscribe(slot, fn));
      return () => offs.forEach((off) => off());
    },
  };

  window.BgbNotifications = BgbNotifications;
})();
