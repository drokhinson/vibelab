// @ts-check
// widgets/player-picker-sheet.js — "who's playing?" as a multi-select bottom sheet.
//
// Replaces the Gather screen's inline buddy combo. That list was
// `position: absolute` inside the Players card, and the Players card sits at
// the bottom of Gather with the roster above it — so with four players already
// added, ui/dropdown-fit.js had to squeeze it to its own MIN (132px) "below
// this a dropdown is a keyhole" floor, on top of the docked Continue CTA, and
// it still ran off the bottom edge. A sheet is position:fixed and sized off
// --bgb-vv-h, so none of that geometry can happen: no fit pass, no flip, no
// z-index race with .cascade-cta-wrap, and the keyboard shrinks it correctly.
//
// It is MULTI-SELECT: a game night is a set of people, not one person picked
// five times. Tap to tick, tap again to untick, then Add — the old combo made
// you re-open it, re-focus it and re-read the same list once per player.
//
// Selection order is preserved, and that matters: the roster array IS the
// scoring grid's column order (widgets/round-score-grid.js maps it straight to
// columns), so ticking Marcus then Priya seats them in that order.
//
// Ticked people ride at the top under "Selected", in that order, and leave the
// body list — so the sheet always shows what it is about to do, empty search
// box included. A query filters that section like every other row: a pick that
// doesn't match what you typed is not an answer to what you typed.
//
// Two behaviours the dropdown couldn't offer, both from being able to afford
// the height:
//   - no 8-row cap (the dropdown capped because it was a keyhole);
//   - a typed name with no match gets an explicit "add as a guest" row. The
//     dropdown HID itself on zero matches, so the guest path was invisible
//     unless you already knew Enter would do it.
//
// Two more the play importer needed, both about a list that is no longer
// simply "your buddies in alphabetical order":
//   - SUGGESTIONS. A caller that already knows which rows are likely (the
//     importer ranks its buddies against the name a note wrote) passes them as
//     `suggestions`, and they sit above the full list rather than replacing it.
//     Nobody is hidden; the likely answers are just first.
//   - A GLOBAL SEARCH. `candidates` is a cached bundle, so typing filters it
//     with no round trip at all; `searchAll` reaches past it to every account
//     in the app. See the next block for how the two now run together.
//
// ── TWO LISTS, ONE QUERY ────────────────────────────────────────────────────
//
// The global search used to be a BUTTON, on the reasoning that a round trip
// should be something you ask for. What that actually produced was a search
// box that answers "who is Dan?" with "no buddy matches Dan" while an account
// called Dan sits one unpressed button away — and the button only reads as an
// offer if you already suspect the list you are looking at is not the whole
// app. People do not suspect that. They type a name, read "no match", and add
// a guest with the same name as an account that was there all along, which is
// a play that never reaches the other person's history.
//
// So both lists answer every query now, in the order they can:
//   1. `candidates` filters SYNCHRONOUSLY on the keystroke — no debounce, no
//      request, no spinner over rows that were already right.
//   2. `searchAll` is debounced GLOBAL_DEBOUNCE_MS behind it and APPENDS its
//      rows underneath, in their own section, once they land.
// The local list never waits on the remote one, a late response can never
// land under a query the user has typed past (`_globalSeq`), and anyone the
// local list already holds is dropped from the remote rows rather than shown
// twice. The button survives only as a retry after a failed request — which
// is the one moment pressing something is the user's actual intent.
//
// ── PENDING BUDDIES ARE PEOPLE ──────────────────────────────────────────────
//
// A candidate can carry `pending`: a buddy request between the viewer and that
// person that nobody has answered yet (migration 049). They are offered like
// any other account — the request is evidence they are at the table tonight,
// and the accept happens later on someone else's phone — and while the search
// box is empty they get their own section at the top, because "the person I
// just added" is the likeliest answer to "who else is playing?" and the empty
// box would otherwise open on a list they are not in at all.
//
// The shell is ui/bottom-sheet.js and the panel chrome is the shared
// .bgb-sheet__* family; only the .player-picker__* row family is ours.

(function () {
  /**
   * A candidate, exactly the shape play-flow-view's `_buddyCandidates()` emits.
   * @typedef {Object} PlayerCandidate
   * @property {"account"|"ghost"} source
   * @property {string|null} user_id   null ⇒ a name-only guest.
   * @property {string} name         Their REAL display name. It is what this
   *   sheet hands back and what the caller persists as
   *   play_players.player_display_name, so it must never be an alias.
   * @property {string|null} [alias]  The viewer's PRIVATE nickname for them.
   *   Painted in place of `name`, matched alongside it — never returned as it.
   * @property {string|null} [username]
   * @property {string|null} [avatar]
   * @property {number} [plays]        Plays together, when known.
   * @property {"incoming"|"outgoing"|null} [pending]  A buddy request between
   *   the viewer and this person that nobody has answered yet — "incoming"
   *   they asked, "outgoing" the viewer did. Seatable either way; it only
   *   changes what the row says and which section it opens in.
   * @property {boolean} [isViewer]    This candidate is the signed-in user.
   *   Labelled "You" and pinned first — the play importer is the one caller
   *   that offers the viewer at all, since everywhere else they are already
   *   seated.
   */

  /**
   * @typedef {Object} PlayerPickerOpts
   * @property {PlayerCandidate[]} candidates  Everyone addable, already filtered
   *   of people in the roster by the caller.
   * @property {PlayerCandidate[]} [recent]    Shown first while the search box
   *   is empty. Falls back to `candidates`.
   * @property {number} [seated]               Players already at the table.
   * @property {string[]} [seatedNames]        Their names. A caller that
   *   filters seated people out of `candidates` leaves the guest row unable
   *   to see them, so a differently-cased spelling of someone already at the
   *   table would be offered back as a new guest — and seat them twice.
   * @property {(picks: PlayerCandidate[]) => void} onConfirm  In tick order.
   * @property {Element|null} [returnFocus]
   * @property {boolean} [singleSelect]        One answer, not a set: a tap
   *   confirms and closes, there is no confirm button, and rows read as radios.
   *   The play importer's "who is this name?" step is one question per row, so
   *   a multi-select sheet would make every answer take three taps.
   * @property {string} [title]                Defaults to "Add players".
   * @property {string} [sub]                  Replaces the seated-count line.
   * @property {string} [guestName]           The name the guest row offers when
   *   the search box is empty. Deliberately NOT a pre-filled query: seeding the
   *   box would filter every buddy out of a list whose whole job is to offer
   *   them. Typing still overrides it, so a different spelling is one field away.
   * @property {string|null} [selectedName]    Ticked on open (singleSelect).
   * @property {string} [guestTitle]           Overrides the guest row's title,
   *   as PLAIN TEXT — escaped here, so a caller never has to remember to.
   *   Written by the caller rather than templated here: "Add X as a guest" and
   *   "Keep X as a ghost" are different acts, not one act in two voices.
   * @property {string} [guestHint]            The subtitle, same contract.
   * @property {PlayerCandidate[]} [suggestions]  Rows worth reading first,
   *   already ranked by the caller — the play importer ranks its buddy list by
   *   how close each name is to the one the note wrote. Shown above the full
   *   list while the search box is empty, so "who is this?" opens on the
   *   likely answers WITHOUT hiding everyone else behind a search.
   * @property {string} [suggestionsLabel]     Heading over them. Say what made
   *   them suggestions ("Closest to “Jas”"), not that they are suggestions.
   * @property {string} [restLabel]            Heading over everyone else.
   * @property {(q: string) => Promise<PlayerCandidate[]>} [searchAll]
   *   Look beyond the caller's own list — the whole app's accounts. Runs
   *   automatically, debounced behind the local filter, and its rows are
   *   APPENDED under their own heading rather than replacing anything: see
   *   "TWO LISTS, ONE QUERY" at the top of this file. Given one, every caller
   *   gets the same contract, so there is nothing to opt into per screen.
   * @property {string} [searchAllLabel]       Titles the retry button a failed
   *   search leaves behind. Nothing else shows it now that the search is not
   *   something the user presses.
   * @property {boolean} [allowGuest]          Default true. False when a name
   *   that matches nobody is not an answer the caller can take — linking a
   *   ghost player to an account is a choice among people who already exist,
   *   and "add “xyz” as a guest" there would offer an act with nothing behind
   *   it. Suppresses the row entirely, typed query or not.
   */

  const LIST_SEL = "[data-picker-list]";
  const INPUT_ID = "player-picker-search";
  const key = (name) => String(name || "").toLowerCase();

  // How long the global search waits behind the last keystroke. Long enough
  // that typing a name end to end costs ONE request rather than one per
  // letter, short enough that it lands while the user is still reading the
  // local rows it will sit under. The local list is not gated on it at all.
  const GLOBAL_DEBOUNCE_MS = 350;
  // And how much has to be typed before it runs. One letter matches a
  // meaningful fraction of every account in the app, so the answer would be a
  // truncated list of strangers — a worse answer than the local one, arriving
  // later and pushing it around. Two is where a query starts being about a
  // person.
  const GLOBAL_MIN_CHARS = 2;
  // The heading over people with an unanswered buddy request. Says what they
  // are, not that they were ranked: a row here is here because of a request
  // the viewer or the other person actually sent.
  const PENDING_LABEL = "Buddy requests";

  class PlayerPickerSheet {
    constructor() {
      /** @type {PlayerCandidate[]} */
      this._candidates = [];
      /** @type {PlayerCandidate[]} */
      this._recent = [];
      /** Tick order — the seating order the roster will take. @type {PlayerCandidate[]} */
      this._picked = [];
      this._seated = 0;
      this._seatedNames = new Set();
      this._onConfirm = /** @type {any} */ (null);
      this._query = "";
      this._single = false;
      this._title = "Add players";
      this._sub = "";
      this._selected = "";
      this._guestName = "";
      this._guestTitle = "";
      this._guestHint = "";
      this._allowGuest = true;
      /** @type {PlayerCandidate[]} */
      this._suggestions = [];
      this._suggestionsLabel = "";
      this._restLabel = "";
      /** @type {((q: string) => Promise<PlayerCandidate[]>)|null} */
      this._searchAll = null;
      this._searchAllLabel = "";
      /** @type {PlayerCandidate[]} Results of the last global search. */
      this._globalRows = [];
      /** The query those results answer — cleared the moment it changes. */
      this._globalQuery = "";
      this._globalBusy = false;
      this._globalError = "";
      /** The pending debounce, so a keystroke can cancel the one before it. */
      this._globalTimer = /** @type {any} */ (null);
      // Monotonic, so a slow search the user has typed past can't land under a
      // different question (.claude/rules/web-frontend.md § Async state).
      this._globalSeq = 0;

      this._sheet = new window.BgbBottomSheet({
        id: "bgb-player-picker-sheet",
        className: "player-picker-sheet",
        label: "Add players",
      });
    }

    // ── Markup ──────────────────────────────────────────────────────────────

    /**
     * Same predicate the dropdown used: case-insensitive substring over name
     * OR username. Kept identical so the sheet can't quietly surface a
     * different set from the one people are used to.
     *
     * LOCAL ONLY, and that is the point: these rows come off a cached bundle
     * (domain/buddy.js SWRs it for a day), so typing filters them with no
     * round trip. `searchAll` is the deliberate, button-pressed alternative.
     */
    _matches() {
      const q = this._query.trim().toLowerCase();
      // Suggestions take over the empty-box slot when the caller ranked any,
      // and the FULL list goes underneath them — so `recent` is not the base.
      const base = !q && !this._suggestions.length && this._recent.length
        ? this._recent
        : this._candidates;
      if (!q) return base;
      return this._candidates.filter((c) => this._hits(c, q));
    }

    /**
     * One row against one query — the predicate _matches() filters with, lifted
     * out because _pickedSection() has to ask it of rows that were never IN
     * `candidates`: a guest _pickGuest() fabricated lives only in `_picked`.
     *
     * BOTH names match. A private alias is a second handle on a person, not a
     * replacement for the one their account carries: someone who types the real
     * name is looking for the person they renamed, and a picker that cannot
     * find them is worse than one that never offered the rename. It also keeps
     * the guest-row collision test honest — typing the real name of a listed
     * buddy must not offer to add them as a same-named ghost.
     * @param {PlayerCandidate} c
     * @param {string} q Already trimmed and lowercased.
     */
    _hits(c, q) {
      if (!q) return true;
      const name = (c.name || "").toLowerCase();
      const alias = (c.alias || "").toLowerCase();
      const username = (c.username || "").toLowerCase();
      return name.includes(q) || (alias && alias.includes(q))
          || (username && username.includes(q));
    }

    /** @param {string} name */
    _isPicked(name) {
      return this._picked.some((p) => key(p.name) === key(name));
    }

    /** @param {PlayerCandidate} c */
    _row(c) {
      const ghost = !c.user_id;
      const on = this._single ? key(c.name) === key(this._selected) : this._isPicked(c.name);
      // The alias is painted; `name` still keys the row (data-picker-name below)
      // and is still what _find/_toggle resolve and the caller writes. Two
      // people can share a display name — that is what an alias is FOR — so the
      // real name joins the meta line rather than replacing the alias.
      const shown = c.alias || c.name;
      const badge = window.BgbBadge.render({
        avatar: c.avatar,
        displayName: shown,
        size: "sm",
        isGhost: ghost,
        extraClass: "player-picker__avatar",
      });
      const bits = [];
      if (c.isViewer) bits.push("You");
      if (c.alias) bits.push(c.name);
      if (c.username) bits.push("@" + c.username);
      if (c.plays) bits.push(`${c.plays} play${c.plays === 1 ? "" : "s"} together`);
      // Which way the unanswered request points, in the words of whoever is
      // reading it. The pill beside the name says THAT it is pending; this
      // says whose move it is, which is the half that decides whether the
      // viewer should go and accept something after the play.
      if (c.pending === "outgoing") bits.push("Buddy request sent");
      else if (c.pending === "incoming") bits.push("Wants to be buddies");
      const meta = bits.length
        ? `<span class="player-picker__meta">${escapeHtml(bits.join(" · "))}</span>`
        : "";
      return `
        <button class="player-picker__row" type="button"
                role="${this._single ? "radio" : "checkbox"}"
                aria-checked="${on}" data-picker-name="${escapeAttr(c.name)}">
          ${badge}
          <span class="player-picker__body">
            <span class="player-picker__name">${escapeHtml(shown)}</span>
            ${meta}
          </span>
          ${c.isViewer ? `<span class="player-picker__pill">You</span>`
            : (ghost ? `<span class="player-picker__pill">Guest</span>`
              : (c.pending ? `<span class="player-picker__pill">Pending</span>` : ""))}
          <span class="player-picker__tick" aria-hidden="true">
            ${on ? `<i data-icon="check" class="w-4 h-4"></i>` : ""}
          </span>
        </button>
      `;
    }

    /**
     * The guest row. In multi-select it offers the TYPED name, and only when
     * that name doesn't already match someone listed or ticked — in which case
     * that row is the better action and two near-identical rows would be a
     * trap. In single-select it is the "none of these" answer and is always
     * offered, falling back to `guestName` before anybody types.
     */
    _guestRow() {
      if (!this._allowGuest) return "";
      // The typed name wins; falling back to guestName is what keeps the
      // "keep them as they are" answer on screen before anybody types.
      const q = this._query.trim() || this._guestName.trim();
      if (!q) return "";
      // Multi-select hides the row once the typed name matches somebody listed
      // or ticked, because that row is the better action. Single-select keeps
      // it: "keep this name as a ghost" stays a legitimate answer even when a
      // buddy of the same name exists, and it is often the RIGHT one.
      const named = (list) => (list || []).some(
        (c) => key(c.name) === key(q) || (c.alias && key(c.alias) === key(q)));
      if (!this._single
          && (named(this._candidates)
              // Global rows count from the moment they land. They arrive
              // unasked now, so "add Dana Okoro as a guest" can sit directly
              // under the account of that exact name without anyone having
              // pressed anything — and a guest seat beside the real account is
              // the mistake this whole search exists to prevent.
              || named(this._globalRows)
              || this._seatedNames.has(key(q))
              || this._isPicked(q))) {
        return "";
      }
      const title = this._guestTitle
        ? escapeHtml(this._guestTitle)
        : `Add “${escapeHtml(q)}” as a guest`;
      const hint = escapeHtml(
        this._guestHint || "No account — they'll show as a guest on the scorecard");
      return `
        <button class="player-picker__row player-picker__row--guest" type="button"
                data-picker-action="guest">
          <span class="player-picker__plus"><i data-icon="plus" class="w-5 h-5"></i></span>
          <span class="player-picker__body">
            <span class="player-picker__name">${title}</span>
            <span class="player-picker__meta">${hint}</span>
          </span>
        </button>
      `;
    }

    /**
     * WHAT THE SHEET IS ABOUT TO DO, at the top, always. Ticked people render
     * here and nowhere else — _renderList() takes them out of the body — so
     * clearing the search box can no longer scatter the four people you just
     * ticked back through a list of forty buddies.
     *
     * A query filters this section by the same predicate as everything else:
     * a pick that doesn't answer what you typed is not an answer, and leaving
     * it pinned would fill the top of a filtered list with rows that don't
     * match. It comes back the moment the box empties, because `_picked` is
     * the state — this is only where it is painted.
     */
    _pickedSection() {
      if (this._single || !this._picked.length) return "";
      const q = this._query.trim().toLowerCase();
      const rows = this._picked.filter((c) => this._hits(c, q));
      if (!rows.length) return "";
      return `<div class="bgb-sheet__sec">Selected</div>`
        + rows.map((c) => this._row(c)).join("");
    }

    /** A section heading. @param {string} text */
    _sec(text) {
      return `<div class="bgb-sheet__sec">${escapeHtml(text)}</div>`;
    }

    /**
     * What the global search has to say right now: nothing until a query is
     * long enough to run one, then a spinner, then either its rows or the fact
     * that it found none. Rendered UNDER the local rows and above the guest
     * row — the local list answered first and keeps its place, and "this
     * person has an account after all" still beats "keep them as a ghost".
     *
     * The spinner is the one thing here that is not a row, and it is why the
     * local list is never gated on this: whatever the box matched locally is
     * already on screen above it while this waits.
     */
    _globalSection() {
      if (this._globalBusy) {
        return this._sec("Searching BoardgameBuddy…")
          + `<div class="player-picker__busy">
               <i data-icon="loader-2" class="w-5 h-5 animate-spin"></i>
             </div>`;
      }
      if (this._globalError) {
        return `<p class="bgb-sheet__empty">${escapeHtml(this._globalError)}</p>`;
      }
      if (!this._globalQuery) return "";
      if (!this._globalRows.length) {
        return this._sec(`No other account matches “${this._globalQuery}”`);
      }
      return this._sec("On BoardgameBuddy")
        + this._globalRows.map((c) => this._row(c)).join("");
    }

    /**
     * What is left of the old "search everyone" button: a RETRY, and only
     * after a request actually failed.
     *
     * The search itself is automatic now (see _scheduleGlobal), so offering a
     * button for it would be offering to do a thing already done. A failure is
     * the exception — the next keystroke would retry it, but a user who has
     * finished typing the name has no next keystroke to give, and without this
     * the sheet would sit on "couldn't search" with no way to ask again.
     */
    _globalRow() {
      if (!this._searchAll || this._globalBusy || !this._globalError) return "";
      const q = this._query.trim();
      if (!q) return "";
      const label = this._searchAllLabel || "Search all of BoardgameBuddy";
      return `
        <button class="player-picker__row player-picker__row--global" type="button"
                data-picker-action="global">
          <span class="player-picker__plus"><i data-icon="search" class="w-5 h-5"></i></span>
          <span class="player-picker__body">
            <span class="player-picker__name">${escapeHtml(label)}</span>
            <span class="player-picker__meta">Tap to try again</span>
          </span>
        </button>
      `;
    }

    /**
     * People with an unanswered buddy request, for the EMPTY box only.
     *
     * With a query they need nothing special: they are in `candidates`, so
     * _matches() finds them and they sit in the filtered list with their pill
     * like anyone else. The empty box is the problem — its list is whatever
     * the caller passed as `recent`, and somebody you have never played with
     * is by construction not in it, so the person you added an hour ago would
     * be reachable only by typing a name you may not know how to spell.
     *
     * Read off `_candidates` rather than a list of its own so there is exactly
     * one place a candidate can live. Already-ticked rows belong to Selected,
     * and anything the caller ranked as a suggestion stays there — a row
     * painted twice reads as two people.
     * @param {PlayerCandidate[]} sugg Rows already claimed by the suggestions
     *   section.
     */
    _pendingRows(sugg) {
      const claimed = new Set((sugg || []).map((c) => key(c.name)));
      return this._candidates.filter(
        (c) => c.pending && !claimed.has(key(c.name)) && !this._isPicked(c.name));
    }

    /**
     * The local rows, sectioned. With a query it is one flat filtered list;
     * without one it is the caller's ranking (closest first), then anyone with
     * a buddy request waiting, then everyone else — or the old recent-first
     * behaviour when the caller ranked nothing.
     * @param {string} q
     * @param {PlayerCandidate[]} sugg  The caller's ranking, already stripped of
     *   anything ticked — those rows belong to the Selected section, and a row
     *   painted in both places is one person the sheet appears to seat twice.
     * @param {PlayerCandidate[]} local
     * @param {PlayerCandidate[]} pending  Unanswered buddy requests, already
     *   empty when a query is on — see _pendingRows.
     */
    _localSections(q, sugg, local, pending) {
      // Pending people lead the empty box, under their own heading, whether or
      // not the caller ranked anything — see _pendingRows. Their rows are
      // pulled out of `local` below so the two sections cannot both paint the
      // same person.
      const pendingKeys = new Set(pending.map((c) => key(c.name)));
      const pendingSec = pending.length
        ? this._sec(PENDING_LABEL) + pending.map((c) => this._row(c)).join("")
        : "";
      const rest = pending.length
        ? local.filter((c) => !pendingKeys.has(key(c.name)))
        : local;

      if (q || !sugg.length) {
        // The header describes the BASE _matches() chose, so it asks the same
        // question _matches() did — otherwise a caller with suggestions gets
        // "Recently played with" over its full candidate list. `rest` can be
        // empty here with the Selected section holding everyone, and a heading
        // over nothing is a section the user cannot find.
        const header = !q && !this._suggestions.length && this._recent.length && rest.length
          ? this._sec("Recently played with")
          : "";
        return pendingSec + header + rest.map((c) => this._row(c)).join("");
      }
      // Both lists are already in memory, so "search my whole buddy list" is
      // scrolling rather than typing — the suggestions do not hide anyone.
      const shown = new Set(sugg.map((c) => key(c.name)));
      const others = rest.filter((c) => !shown.has(key(c.name)));
      return this._sec(this._suggestionsLabel || "Closest matches")
        + sugg.map((c) => this._row(c)).join("")
        + pendingSec
        + (others.length
            ? this._sec(this._restLabel || "Everyone else")
              + others.map((c) => this._row(c)).join("")
            : "");
    }

    _renderList() {
      const q = this._query.trim();
      const guest = this._guestRow();
      const pickedFirst = this._pickedSection();
      // Ticked rows live in the Selected section and nowhere else, whether or
      // not a query is on — painting one in both places reads as two people.
      const local = this._matches().filter((c) => !this._isPicked(c.name));
      const sugg = q ? [] : this._suggestions.filter((c) => !this._isPicked(c.name));
      // Counted as local rows, because they ARE rows and the branch below is
      // "is this list empty". They can be the only thing in it: an empty box
      // whose `recent` list is all seated already has nothing else to paint,
      // and answering that with "no buddies yet" while a request sits unread
      // would hide the one person the sheet had to offer.
      const pending = q ? [] : this._pendingRows(sugg);
      const hasLocal = local.length || sugg.length || pending.length;
      const tail = this._globalSection() + this._globalRow();

      if (!hasLocal && !pickedFirst) {
        const note = q
          ? this._sec(`No buddy matches “${q}”`)
          : this._sec("No buddies yet — search to find one");
        // Once the global search has been asked, ITS answer leads: the user
        // pressed a button to get those rows, and burying them under "keep
        // them as a ghost" would answer a question they didn't ask.
        if (this._globalQuery || this._globalBusy || this._globalError) {
          return note + tail + (guest ? this._sec(this._single ? "Or" : "Not in your buddies?") + guest : "");
        }
        // Until then the guest row IS the answer: lead with it, let the note
        // underneath explain the absence, and offer the search below both.
        if (!guest) {
          if (tail) return note + tail;
          return `<p class="bgb-sheet__empty">${this._allowGuest
            ? "No buddies yet — type a name to add a guest."
            : escapeHtml(q ? `Nobody matches “${q}”.` : "Nobody to pick yet.")}</p>`;
        }
        return guest + note + tail;
      }
      // Real people first when the query matched any: "add a guest called ok"
      // above Jess Okoro would be a strange thing to lead with. It stays
      // offered, though — the buddy list can hold a Dan while a different Dan
      // is at the table tonight.
      // Single-select's guest row is the "none of these" answer, not an
      // "add somebody new" one — and it is offered even when a buddy of the
      // same name is listed, so "Not in your buddies?" would be a lie there.
      const guestSec = this._single ? "Or" : "Not in your buddies?";
      return pickedFirst + this._localSections(q, sugg, local, pending) + tail
        + (guest ? this._sec(guestSec) + guest : "");
    }

    /** The confirm button's label and disabled state both track the tick count. */
    _renderConfirm() {
      // A tap IS the answer in single-select, so a confirm button would only
      // ever be a second tap on a decision already made.
      if (this._single) return "";
      const n = this._picked.length;
      return `
        <button class="bgb-sheet__confirm" type="button" data-picker-action="confirm"
                ${n ? "" : "disabled"}>
          ${n ? `Add ${n} player${n === 1 ? "" : "s"}` : "Select players to add"}
        </button>
      `;
    }

    _renderPanel() {
      const seated = this._seated;
      // Name both lists when both are searched. A box that says "buddies" on a
      // sheet that also answers with strangers is describing the old
      // behaviour, and the promise a placeholder makes is the reason people
      // stop typing when it is not kept.
      const ph = this._searchAll
        ? "Search people, or type a name…"
        : "Search buddies, or type a name…";
      return `
        <div class="bgb-sheet__panel" tabindex="-1">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">${escapeHtml(this._title)}</h3>
          ${this._sub
            ? `<p class="bgb-sheet__sub">${escapeHtml(this._sub)}</p>`
            : (seated ? `<p class="bgb-sheet__sub">${seated} already at the table</p>` : "")}
          <div class="game-finder bgb-sheet__search" data-search-host>
            <i data-icon="search" class="w-4 h-4 game-finder__icon"></i>
            <input type="text" id="${INPUT_ID}"
                   class="input input-bordered game-finder__input"
                   placeholder="${escapeAttr(ph)}"
                   aria-label="${escapeAttr(ph.replace(/…$/, ""))}"
                   autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false" />
            ${window.BgbSearchField.clearButton()}
          </div>
          <div class="bgb-sheet__list"
               role="${this._single ? "radiogroup" : "group"}"
               aria-label="${escapeAttr(this._title)}"
               data-picker-list>${this._renderList()}</div>
          <div class="bgb-sheet__foot" data-picker-foot>${this._renderConfirm()}</div>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
        </div>
      `;
    }

    // ── Open / close ────────────────────────────────────────────────────────

    /** @param {PlayerPickerOpts} opts */
    open(opts) {
      this._candidates = Array.isArray(opts.candidates) ? opts.candidates : [];
      this._recent = Array.isArray(opts.recent) ? opts.recent : [];
      this._seated = opts.seated || 0;
      this._seatedNames = new Set((opts.seatedNames || []).map(key));
      this._onConfirm = opts.onConfirm;
      this._picked = [];
      this._single = !!opts.singleSelect;
      this._title = opts.title || "Add players";
      this._sub = opts.sub || "";
      this._selected = opts.selectedName || "";
      this._guestName = opts.guestName || "";
      this._guestTitle = opts.guestTitle || "";
      this._guestHint = opts.guestHint || "";
      this._allowGuest = opts.allowGuest !== false;
      this._suggestions = Array.isArray(opts.suggestions) ? opts.suggestions : [];
      this._suggestionsLabel = opts.suggestionsLabel || "";
      this._restLabel = opts.restLabel || "";
      this._searchAll = typeof opts.searchAll === "function" ? opts.searchAll : null;
      this._searchAllLabel = opts.searchAllLabel || "";
      this._resetGlobal();
      this._query = "";

      this._sheet.open({
        html: this._renderPanel(),
        returnFocus: opts.returnFocus || null,
        onClick: (e) => {
          if (e.target.closest('[data-picker-action="guest"]')) { this._pickGuest(); return; }
          if (e.target.closest('[data-picker-action="global"]')) { this._runGlobalSearch(); return; }
          if (e.target.closest('[data-picker-action="confirm"]')) { this._confirm(); return; }
          const row = e.target.closest("[data-picker-name]");
          if (row) this._toggle(row.dataset.pickerName);
        },
        search: { listSel: LIST_SEL, inputSel: `#${INPUT_ID}`, onQuery: (v) => this._setQuery(v) },
        onOpen: (root) => {
          const input = /** @type {HTMLInputElement|null} */ (root.querySelector(`#${INPUT_ID}`));
          if (input) {
            // Enter ticks the typed name — the same key that added one from the
            // old combo — and leaves the sheet open for the next person.
            input.addEventListener("keydown", (e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              this._submitTyped();
            });
          }
          // Focus the first buddy, not the search box: opening the sheet must
          // not raise a software keyboard over the list of people it is
          // offering (.claude/rules/overlays.md §5). Typing a name is still one
          // tap away. With nobody to list, the panel takes focus instead so a
          // screen reader still lands on the sheet's label.
          const firstRow = /** @type {HTMLElement|null} */ (root.querySelector(".player-picker__row"));
          const panel = /** @type {HTMLElement|null} */ (root.querySelector(".bgb-sheet__panel"));
          const landing = firstRow || panel;
          if (landing) landing.focus({ preventScroll: true });
        },
        onClose: () => {
          this._candidates = [];
          this._seatedNames = new Set();
          this._recent = [];
          this._picked = [];
          this._onConfirm = null;
          this._query = "";
          // This is a singleton, so a mode left set would reach the next
          // opener — Gather would get a sheet that closes on the first tap.
          this._single = false;
          this._title = "Add players";
          this._sub = "";
          this._selected = "";
          this._guestName = "";
          this._guestTitle = "";
          this._guestHint = "";
          this._allowGuest = true;
          this._suggestions = [];
          this._suggestionsLabel = "";
          this._restLabel = "";
          this._searchAll = null;
          this._searchAllLabel = "";
          this._resetGlobal();
        },
      });
    }

    close() {
      this._sheet.close();
    }

    isOpen() {
      return this._sheet.isOpen;
    }

    /**
     * Swap in the real rows on a sheet that opened before the buddy preload
     * landed. Ticks survive: `_picked` holds whole candidate objects, so a
     * guest the host typed while waiting is unaffected, and a buddy row is
     * re-rendered from the same name key.
     * @param {PlayerCandidate[]} candidates
     * @param {PlayerCandidate[]} [recent]
     * @param {PlayerCandidate[]} [suggestions] Re-ranked with the new list.
     */
    setCandidates(candidates, recent, suggestions) {
      if (!this._sheet.isOpen) return;
      this._candidates = Array.isArray(candidates) ? candidates : [];
      this._recent = Array.isArray(recent) ? recent : [];
      if (suggestions !== undefined) {
        this._suggestions = Array.isArray(suggestions) ? suggestions : [];
      }
      // _runGlobalSearch dropped anyone the candidate list held AT THE TIME.
      // On a cold cache that list was empty, so a global hit for a person who
      // turns out to be a buddy would now be painted twice — once as the buddy
      // row that arrived, once as the stranger found before it did.
      this._globalRows = this._dedupeGlobal(this._globalRows);
      this._repaintList(true);
    }

    /**
     * Global rows minus anyone the local list already offers, by account id.
     * The local row is the better one — it carries the alias, the play count
     * and the pending state — and two rows for one person read as two people.
     * @param {PlayerCandidate[]} rows
     */
    _dedupeGlobal(rows) {
      const listed = new Set(this._candidates.map((c) => c.user_id).filter(Boolean));
      return (rows || []).filter((r) => r && r.name && !listed.has(r.user_id));
    }

    // ── Filtering ───────────────────────────────────────────────────────────

    /** @param {string} value */
    _setQuery(value) {
      this._query = value || "";
      // Global results answer the query that fetched them and nothing else, so
      // typing past one drops it — along with any request still in the air,
      // which would otherwise land under a different question.
      if (this._globalQuery && key(this._globalQuery) !== key(this._query.trim())) {
        this._resetGlobal();
      } else if (this._globalError) {
        // A keystroke is a fresh ask, so a stale failure stops being the
        // answer on screen — and _scheduleGlobal below is what retries it.
        this._globalError = "";
      }
      // The local list is painted from this same call, synchronously, below:
      // the remote pass is scheduled, never awaited.
      this._scheduleGlobal();
      this._repaintList();
    }

    /**
     * Queue the global search behind the last keystroke.
     *
     * Every entry point is a query change, so this is also where the search is
     * DECLINED: too short to be about a person, or already answered by the
     * rows on screen. Asking again for a query whose results are already
     * painted would replace them with a spinner and then with themselves.
     */
    _scheduleGlobal() {
      if (this._globalTimer) { clearTimeout(this._globalTimer); this._globalTimer = null; }
      if (!this._searchAll) return;
      const q = this._query.trim();
      if (q.length < GLOBAL_MIN_CHARS) return;
      if (!this._globalError && this._globalQuery && key(this._globalQuery) === key(q)) return;
      this._globalTimer = setTimeout(() => {
        this._globalTimer = null;
        this._runGlobalSearch();
      }, GLOBAL_DEBOUNCE_MS);
    }

    /** Forget the global search entirely, dropping anything in flight. */
    _resetGlobal() {
      this._globalSeq++;
      if (this._globalTimer) { clearTimeout(this._globalTimer); this._globalTimer = null; }
      this._globalRows = [];
      this._globalQuery = "";
      this._globalBusy = false;
      this._globalError = "";
    }

    /**
     * Search every account in the app for the typed name. Anyone already
     * listed above is filtered out rather than offered twice — the local row
     * carries their play count, their alias and their pending state, and is
     * the better row.
     *
     * Deliberately NOT gated on `_globalBusy`. Under the debounce a second
     * query can arrive while the first is in the air, and refusing it would
     * answer the new question with the old one's results; `_globalSeq` is what
     * makes the loser harmless. The retry button is the same call, and a
     * double tap on it costs a request rather than a wrong list.
     */
    async _runGlobalSearch() {
      const q = this._query.trim();
      if (!q || !this._searchAll) return;
      const seq = ++this._globalSeq;
      this._globalRows = [];
      this._globalError = "";
      this._globalQuery = q;
      this._globalBusy = true;
      this._repaintList(true);

      let rows = null;
      try {
        rows = await this._searchAll(q);
      } catch (_) {
        if (seq !== this._globalSeq || !this._sheet.isOpen) return;
        this._globalBusy = false;
        this._globalQuery = "";
        this._globalError = "Couldn't search right now.";
        this._repaintList(true);
        return;
      }
      if (seq !== this._globalSeq || !this._sheet.isOpen) return;
      this._globalBusy = false;
      this._globalRows = this._dedupeGlobal(rows);
      this._repaintList(true);
    }

    /**
     * Patch the list and the footer only. Re-rendering the panel would blow
     * away the input the user is typing into, along with its focus and caret.
     * @param {boolean} [keepScroll]
     */
    _repaintList(keepScroll) {
      const root = this._sheet.el;
      if (!root) return;
      const host = /** @type {HTMLElement|null} */ (root.querySelector(LIST_SEL));
      if (host) {
        const top = host.scrollTop;
        host.innerHTML = this._renderList();
        host.scrollTop = keepScroll ? top : 0;
        window.BgbIcons.render(host);
      }
      const foot = /** @type {HTMLElement|null} */ (root.querySelector("[data-picker-foot]"));
      if (foot) foot.innerHTML = this._renderConfirm();
    }

    /** Empties the box through the shared field's own path — the `input`
     *  event it dispatches lands back in _setQuery. */
    _clear() {
      window.BgbSearchField.clear(this._sheet.el);
    }

    // ── Selection ───────────────────────────────────────────────────────────

    /**
     * The candidate behind a row, wherever it came from. Global results are
     * searched too — a row the user can see must be a row the user can pick.
     * @param {string} name
     */
    _find(name) {
      // Matches the alias as well as the real name. A row hands back its real
      // name via data-picker-name, so that path is unaffected — but _submitTyped
      // passes whatever was TYPED, and someone who types the alias they set
      // must land on the account. Without this they fall through to
      // _pickGuest() and seat a ghost named after their own private alias,
      // which then persists into play_players for everyone in the play to see.
      const hit = (list) => (list || []).find(
        (x) => key(x.name) === key(name) || (x.alias && key(x.alias) === key(name)));
      return hit(this._candidates) || hit(this._suggestions)
        || hit(this._recent) || hit(this._globalRows) || null;
    }

    /** @param {string} name */
    _toggle(name) {
      if (this._single) {
        const c = this._find(name);
        if (c) this._answer(c);
        return;
      }
      const i = this._picked.findIndex((p) => key(p.name) === key(name));
      if (i >= 0) {
        this._picked.splice(i, 1);
      } else {
        const c = this._find(name);
        if (!c) return;
        this._picked.push(c);
      }
      // Ticking must not scroll the list out from under the thumb.
      this._repaintList(true);
    }

    /**
     * Multi-select: tick the typed name as a guest and clear the box, ready for
     * the next. Single-select: it IS the answer, so it closes.
     */
    _pickGuest() {
      const name = this._query.trim() || this._guestName.trim();
      if (!name) return;
      const guest = { source: "ghost", user_id: null, name, username: null, avatar: null };
      if (this._single) { this._answer(guest); return; }
      if (this._isPicked(name)) return;
      this._picked.push(guest);
      this._clear();
    }

    /**
     * Single-select's whole path: close first, then hand the pick back.
     * Closing first means the caller's own re-render lands on a screen the
     * sheet has already let go of, rather than under it.
     * @param {PlayerCandidate} pick
     */
    _answer(pick) {
      const cb = this._onConfirm;
      this.close();
      if (cb) cb([pick]);
    }

    /**
     * Enter on the search field. An exact match ticks that person as
     * themselves — with their account and avatar — rather than a same-named
     * guest; this mirrors the old `_addPlayerFromInput`, which did the same
     * lookup before deciding account-vs-ghost.
     */
    _submitTyped() {
      const q = this._query.trim();
      if (!q) return;
      const exact = this._find(q);
      if (exact) {
        if (this._single) { this._answer(exact); return; }
        if (!this._isPicked(exact.name)) this._picked.push(exact);
        this._clear();
        return;
      }
      this._pickGuest();
    }

    _confirm() {
      const picks = this._picked.slice();
      const cb = this._onConfirm;
      this.close();
      if (picks.length && cb) cb(picks);
    }
  }

  window.PlayerPickerSheet = new PlayerPickerSheet();
})();
