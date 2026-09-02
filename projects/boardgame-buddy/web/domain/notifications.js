// domain/notifications.js — the transient-notification registry.
//
// One table saying, for every signal the app can raise: which store slot
// carries its count, which surface it sits behind (a bottom-nav tab, the
// global header's Settings gear, the global header's notification bell),
// which section or admin spoke resolves it, and how to say it out loud.
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
// knows the number, and — if its surface has no dot yet — drop the dot span
// its surface uses into index.html (`.bgb-nav__dot` inside a tab's `__ico`,
// `.bgb-global-header__dot` inside a header button). Nothing else changes:
// subscribe() covers every slot in this table, so the surfaces repaint on
// their own.

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
    // Admin signals. They carry `gear` instead of `tab` because they sit
    // behind the global header's Settings gear, not a bottom-nav tab, and
    // `adminTool` names the spoke that resolves each one so the Settings admin
    // card can badge its rows individually. tally() matches on whatever keys
    // it is handed, so forTab() skips these and forGear() skips the four
    // above — no branch needed.
    //
    // These pass the transience test in the header comment: an admin resolves
    // a report, and a backfill run empties a missing-X queue. They stay 0 for
    // non-admins because domain/admin-review.js never fetches for them.
    {
      slot: "adminChapterReportCount",
      gear: true,
      adminTool: "reports",
      label: (n) => `${n} chapter report${n === 1 ? "" : "s"}`,
    },
    {
      slot: "adminMissingImageCount",
      gear: true,
      adminTool: "images",
      label: (n) => `${n} game${n === 1 ? "" : "s"} missing images`,
    },
    {
      slot: "adminMissingDescriptionCount",
      gear: true,
      adminTool: "descriptions",
      label: (n) => `${n} game${n === 1 ? "" : "s"} missing a description`,
    },
    // Pending uploads. The header's own upload button is gone: a queue that
    // drains itself is the app doing something FOR you, which is plumbing, and
    // plumbing lives in Settings — where a "Pending uploads" section has always
    // rendered it. What the header control was really providing was the
    // SIGNAL, and that is a dot, so it joins the gear's.
    //
    // The slot is Outbox.count(), not pendingCount(): a play the server
    // rejected outright is not "waiting to upload" but it is still the one
    // thing on this device that needs a human, so it keeps the dot lit.
    {
      slot: "outboxCount",
      gear: true,
      label: (n) => `${n} play${n === 1 ? "" : "s"} to upload`,
    },
    // Plays somebody else seated you in. Its own surface — the bell — because
    // it resolves on the notifications screen, not in Settings, and because it
    // is the one signal here about something done TO the user rather than
    // something they or the app has left undone.
    {
      slot: "linkNotifCount",
      bell: true,
      label: (n) => `${n} play${n === 1 ? "" : "s"} you were added to`,
    },
  ];

  // Same clamp the hand-written sums used: a slot can hold whatever a caller
  // put there, and a negative or a NaN must read as "nothing waiting" rather
  // than poisoning the total.
  function read(slot) {
    return Math.max(0, Number(window.store.get(slot)) || 0);
  }

  /**
   * Sum the signals matching `match` — any subset of the routing keys a row
   * can carry: {tab, section, gear, adminTool}. A row missing the key simply
   * never matches, which is how one table serves four unrelated surfaces
   * without a branch.
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

    /** Everything waiting behind the global header's Settings gear. */
    forGear() {
      return tally({ gear: true });
    },

    /** Everything waiting behind the global header's notification bell. */
    forBell() {
      return tally({ bell: true });
    },

    /** What one admin spoke has to act on, by its tool key. */
    forAdminTool(key) {
      return tally({ adminTool: key });
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
