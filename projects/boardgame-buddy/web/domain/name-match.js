// @ts-check
// domain/name-match.js — "is this the same person?" as a number.
//
// A pasted note writes people the way the writer says them out loud: "Jas",
// "dave r", "Priyaa", "@marcus". The buddy list holds display names and
// usernames. Deciding whether those two strings are one person is one
// question, and it is asked from two places that must agree:
//
//   • domain/play-import.js pre-fills each parsed name with its best match, so
//     an import lands on the right account without a tap;
//   • views/import-plays-view.js orders the picker sheet by the same score, so
//     the row the model chose is the row the user sees first — and the runners
//     up are right underneath it rather than behind a search.
//
// Written once here because the two disagreeing is the worst outcome: a sheet
// that ranks Jasmine third while the row behind it already says "Jas →
// Jasmine" reads as a bug in whichever one the user believes less.
//
// THE SCORE IS A LADDER, NOT A DISTANCE. Rungs are named cases in descending
// order of how sure a human would be, and edit distance is only the bottom
// two: "Jas"/"Jasmine" is a confident match at three characters, while
// "Sean"/"Shea" is four characters apart the other way and is not a match at
// all. A pure similarity metric cannot tell those apart, because the thing
// that separates them is that one is a PREFIX — how people actually shorten
// names — and the other is a different name.
//
// Two thresholds come out of the ladder:
//   MIN_AUTO (70)    — assign it without asking. Exact, first-name, or a
//                      genuine shortening.
//   MIN_SUGGEST (45) — worth putting in front of the user, not worth deciding
//                      for them. Typos, near-spellings, substrings.

(function () {
  // Docked off every name after the first, so the order a caller lists them in
  // is a priority order rather than a bag.
  const FIELD_PENALTY = 4;

  /**
   * Fold a name to its comparable core: accents off, case off, punctuation to
   * spaces. "D'Angelo" and "dangelo" are the same person, and "@marcus" typed
   * into a note is the username `marcus`.
   * @param {*} s
   */
  function normalize(s) {
    return String(s == null ? "" : s)
      .normalize("NFD")
      // Combining marks — é → e. Kept out of the class below so a name written
      // in a non-Latin script survives as itself rather than collapsing to "".
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Levenshtein, two rows rather than a full matrix. Names are short and the
  // lists are the viewer's own buddies, so this runs over tens of pairs of
  // ~10 characters — but it is called once per candidate per parsed name, and
  // a note can carry twenty names, so the allocation is worth not doing.
  function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= b.length; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const swap = prev; prev = cur; cur = swap;
    }
    return prev[b.length];
  }

  /** 0..1, where 1 is identical. */
  function similarity(a, b) {
    if (!a || !b) return 0;
    const longest = Math.max(a.length, b.length);
    return longest ? 1 - editDistance(a, b) / longest : 0;
  }

  /**
   * The shortening rung: is `a` how someone would abbreviate `b`, or the other
   * way round? 0 when neither. The further the shortening reaches the less
   * sure it is, but never below MIN_AUTO — "Jas"/"Jasmine" is still the answer.
   */
  function prefixScore(a, b) {
    if (!a || !b) return 0;
    const short = a.length <= b.length ? a : b;
    const long = short === a ? b : a;
    if (short.length < 2 || !long.startsWith(short)) return 0;
    return 78 - Math.min(8, long.length - short.length);
  }

  /**
   * Score one normalized query against one normalized candidate, 0..100.
   * Zero means "not this person" — a caller can treat it as absent.
   */
  function scorePair(q, c) {
    if (!q || !c) return 0;
    if (q === c) return 100;

    const qt = q.split(" ");
    const ct = c.split(" ");

    // "Dave" ↔ "Dave Rokhinson". A note almost always writes the first name,
    // and a buddy list almost always holds the full one, so this rung carries
    // most real imports.
    if (ct[0] === q || qt[0] === c) return 88;
    // "Rokhinson" ↔ "Dave Rokhinson", or a middle name in either.
    if (ct.indexOf(q) !== -1 || qt.indexOf(c) !== -1) return 82;

    // A genuine shortening. Two characters minimum in the SHORTER string:
    // a one-letter stem matches half the buddy list, and "A" quietly becoming
    // "Amelia" is exactly the wrong kind of confident.
    const short = q.length <= c.length ? q : c;
    const long = short === q ? c : q;
    // Measured against the FIRST NAME as well as the whole string, so a
    // surname doesn't dilute it: "Jas" is four characters short of "Jasmine"
    // and ten short of "Jasmine Patel", and the first number is the true one.
    const prefix = Math.max(
      prefixScore(short, long),
      prefixScore(q, ct[0]),
      prefixScore(qt[0], c),
    );
    if (prefix) return prefix;
    // Same, per word: "dave r" ↔ "dave rokhinson".
    if (qt.length === ct.length && qt.length > 1) {
      let ok = true;
      for (let i = 0; i < qt.length && ok; i++) {
        const a = qt[i], b = ct[i];
        const s = a.length <= b.length ? a : b;
        const l = s === a ? b : a;
        ok = s.length >= 1 && l.startsWith(s);
      }
      if (ok) return 74;
    }

    // Below here is suggestion territory: shown, never assumed.

    // "ann" inside "joanne". Three characters minimum, or every short name
    // matches everybody.
    if (short.length >= 3 && long.indexOf(short) !== -1) return 66;

    // Whole-string near-spelling: "Priyaa"/"Priya", "Jonathon"/"Jonathan".
    const whole = similarity(q, c);
    if (whole >= 0.7) return Math.round(45 + whole * 20);

    // One word of a longer name misspelled: "dav rokhinson".
    let best = 0;
    for (const a of qt) {
      if (a.length < 4) continue;
      for (const b of ct) {
        if (b.length < 4) continue;
        best = Math.max(best, similarity(a, b));
      }
    }
    if (best >= 0.8) return Math.round(35 + best * 20);

    return 0;
  }

  /**
   * The best score of `query` against any of a candidate's names — a person is
   * matched on their display name OR their username, whichever the note used.
   * @param {string} query
   * @param {string|string[]} names
   */
  function score(query, names) {
    const q = normalize(query);
    if (!q) return 0;
    const list = Array.isArray(names) ? names : [names];
    let best = 0;
    for (let i = 0; i < list.length; i++) {
      // Later names are weaker evidence, by the caller's own ordering: a
      // display-name match outranks a username one that scored the same, so
      // "Jas" lands on Jasmine Patel rather than on whoever holds @jas99.
      const s = Math.max(0, scorePair(q, normalize(list[i])) - (i ? FIELD_PENALTY : 0));
      if (s > best) best = s;
      if (best === 100) break;
    }
    return best;
  }

  /**
   * Every row that scores at all, best first. Ties keep their input order, so
   * a caller that pre-sorted by play count keeps that as the tiebreak.
   * @template T
   * @param {string} query
   * @param {T[]} rows
   * @param {(row: T) => string|string[]} namesOf
   * @param {number} [min] Defaults to MIN_SUGGEST.
   * @returns {Array<{row: T, score: number}>}
   */
  function rank(query, rows, namesOf, min) {
    const floor = typeof min === "number" ? min : NameMatch.MIN_SUGGEST;
    const out = [];
    (rows || []).forEach((row, i) => {
      const s = score(query, namesOf(row));
      if (s > 0 && s >= floor) out.push({ row, score: s, i });
    });
    out.sort((a, b) => (b.score - a.score) || (a.i - b.i));
    return out.map((x) => ({ row: x.row, score: x.score }));
  }

  /**
   * The single best row, or null when nothing clears `min`.
   * @template T
   * @param {string} query
   * @param {T[]} rows
   * @param {(row: T) => string|string[]} namesOf
   * @param {number} [min] Defaults to MIN_AUTO.
   */
  function best(query, rows, namesOf, min) {
    const floor = typeof min === "number" ? min : NameMatch.MIN_AUTO;
    const hits = rank(query, rows, namesOf, floor);
    return hits.length ? hits[0].row : null;
  }

  const NameMatch = {
    // Assign it without asking.
    MIN_AUTO: 70,
    // Put it in front of the user; let them decide.
    MIN_SUGGEST: 45,
    normalize,
    similarity,
    score,
    rank,
    best,
  };

  window.BgbNameMatch = NameMatch;
})();
