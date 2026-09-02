// widgets/onboarding-deck-slides.js — the five panels the deck slides between.
//
// Each slide is `{ el, onEnter? }`: an element the shell appends to the track,
// and an optional hook run when it arrives on screen. Nothing here knows how
// the deck moves — a slide calls deck.next() when it is done and stops caring.
//
// Every one of them reuses a component that already existed, because these are
// the same three screens first-run always had; only their container changed:
//   1 · profile — ui/avatar-picker.js, the picker extracted out of
//       PolaroidPopup.avatarCustomizer when this became its second caller
//   2 · buddies — ui/buddy-suggestion-rail.js's select-mode tile, the same one
//       the Add-buddies card and both rails render
//   3 · BoardGameGeek — the fields and copy of the deleted
//       widgets/onboarding-bgg-modal.js, whose import readout stays shared
//       with Settings as ui/bgg-import-log.js
//   4 · import hint — the one slide that reuses nothing, because it IS
//       nothing: no fields, no write, no request. It exists because the note
//       importer was otherwise invisible to a new account, and first-run is
//       the one screen everybody passes through.
//
// THE RULE THIS FILE EXISTS TO KEEP: no handler below awaits anything. Continue
// and Skip queue a write through deck.queue() and call deck.next() in the same
// frame. If you find yourself adding an `await` to a button handler here, the
// answer is a ledger line on the finale, not a spinner.

(function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function slideEl(className, html) {
    const el = document.createElement("div");
    el.className = "ob-slide " + className;
    el.innerHTML = html;
    return el;
  }

  // ── 1 · Profile ────────────────────────────────────────────────────────────
  function buildProfile(deck) {
    const me = deck.me || {};
    // The auto-created display name is the email local-part — usable but not
    // personal. Seed the field with it so the user can keep it or rewrite,
    // clipped to the ceiling the field enforces so the deck never opens on a
    // value it would then refuse.
    const nameMax = window.User.DISPLAY_NAME_MAX;
    const seeded = String(me.display_name || "").slice(0, nameMax);
    const el = slideEl("ob-slide--profile", `
      <div class="ob-slide__scroll">
        <div class="ob-slide__eyebrow">Your table name</div>
        <h2 class="ob-slide__title">Who's playing?</h2>
        <p class="ob-slide__body">Pick the name and badge your buddies will see
          on a scorecard.</p>
        <div class="polaroid-field ob-field">
          <label class="polaroid-field__label" for="ob-name">Display name</label>
          <input id="ob-name" type="text" maxlength="${nameMax}" autocomplete="off"
                 class="input input-bordered input-sm polaroid-field__input"
                 placeholder="Your name" value="${esc(seeded)}" />
          <div class="polaroid-field__count ob-field__count"></div>
          <div class="polaroid-field__error ob-field__error text-error text-xs" hidden></div>
        </div>
        <div class="ob-paper"><div class="ob-avatar-picker"></div></div>
      </div>
      <div class="ob-slide__actions">
        <button type="button" class="btn btn-primary ob-btn ob-btn--go">Continue</button>
      </div>
    `);

    const nameInput = el.querySelector("#ob-name");
    const errorEl = el.querySelector(".ob-field__error");
    const countEl = el.querySelector(".ob-field__count");
    const picker = window.BgbAvatarPicker.mount(
      el.querySelector(".ob-avatar-picker"),
      { current: me.avatar || null, displayName: seeded },
    );

    function paintCount() {
      const len = nameInput.value.trim().length;
      countEl.textContent = `${len}/${nameMax}`;
      countEl.classList.toggle("polaroid-field__count--over", len > nameMax);
    }

    function refuse(message) {
      errorEl.hidden = false;
      errorEl.textContent = message;
      nameInput.focus();
    }

    paintCount();
    nameInput.addEventListener("input", () => {
      picker.setDisplayName(nameInput.value);
      paintCount();
      if (!errorEl.hidden) { errorEl.hidden = true; errorEl.textContent = ""; }
    });

    el.querySelector(".ob-btn--go").addEventListener("click", () => {
      const displayName = (nameInput.value || "").trim();
      // The one place in the deck that refuses to move on, and it refuses
      // locally: an empty display name is not something the server has to be
      // asked about, and every OTHER screen in the app would then show a
      // person with no name.
      if (!displayName) {
        refuse("Pick a name your buddies will recognise.");
        return;
      }
      // maxlength already caps typing and pasting; this catches the paths that
      // slip past it (a dragged-in selection) so the deck cannot be the one
      // surface that writes a name over the ceiling.
      if (displayName.length > nameMax) {
        refuse(`Keep it to ${nameMax} characters or less.`);
        return;
      }
      const avatar = picker.value();
      deck.queue(
        "Profile saved",
        () => window.api.post("/profile", { display_name: displayName, avatar }).then((updated) => {
          // The store is what every other screen reads, so the name and badge
          // are live behind the deck before the user ever gets there.
          const cur = window.store.get("user");
          if (cur) window.store.set("user", new window.User({ ...cur, ...updated }));
          return updated;
        }),
        () => `${displayName} · ${avatar.icon} badge`,
      );
      deck.next();
    });

    return { el, onEnter: () => picker.refresh() };
  }

  // ── 2 · Buddies ────────────────────────────────────────────────────────────
  function buildBuddies(deck) {
    const el = slideEl("ob-slide--buddies", `
      <div class="ob-slide__scroll">
        <div class="ob-slide__eyebrow">Your table</div>
        <h2 class="ob-slide__title">Add your buddies</h2>
        <p class="ob-slide__body">Tick anyone you know. We'll send the requests
          while you carry on.</p>
        <div class="ob-tiles" data-tiles>
          <p class="ob-tiles__msg">Finding people you may know…</p>
        </div>
      </div>
      <div class="ob-slide__actions">
        <button type="button" class="btn btn-ghost ob-btn ob-btn--skip">Skip</button>
        <button type="button" class="btn btn-primary ob-btn ob-btn--go">Send requests</button>
      </div>
    `);

    const grid = el.querySelector("[data-tiles]");
    const sendBtn = el.querySelector(".ob-btn--go");
    /** @type {Set<string>} */
    const selected = new Set();
    /** Everyone rendered, by id, so a promotion knows what is already here. */
    const shown = new Map();
    let network = null;
    let loaded = false;

    function tileHtml(s) {
      return window.renderBuddySuggestionTile(s, {
        mode: "select",
        selected: selected.has(s.user_id),
      });
    }

    function syncFooter() {
      const n = selected.size;
      sendBtn.textContent = n === 0
        ? "Send requests"
        : `Send ${n} request${n === 1 ? "" : "s"}`;
    }

    function render(rows) {
      loaded = true;
      shown.clear();
      rows.forEach((r) => shown.set(r.user_id, r));
      grid.innerHTML = rows.length
        ? rows.map(tileHtml).join("")
        : `<p class="ob-tiles__msg">No one to suggest yet — you can add buddies
             any time from the Buddies screen.</p>`;
      window.BgbIcons.render(grid);
      syncFooter();
    }

    /**
     * Ticking someone introduces the people they know (migration 072), out of
     * the payload that arrived with the suggestions — so this costs no request
     * and happens in the tap's own frame.
     *
     * APPENDS, and only appends. Nothing already on screen is re-rendered or
     * moved, so the tile under the user's finger survives and the grid does
     * not scroll (.claude/rules/overlays.md §6, mobile-web.md §5). An untick
     * takes nothing back, by the same rule.
     */
    function promoteFrom(userId) {
      if (!network || network.isEmpty) return;
      const rows = network.promote(userId, new Set(shown.keys()));
      if (!rows.length) return;
      rows.forEach((r) => shown.set(r.user_id, r));
      grid.insertAdjacentHTML("beforeend", rows.map(tileHtml).join(""));
      window.BgbIcons.render(grid);
    }

    grid.addEventListener("click", (ev) => {
      const tile = ev.target.closest ? ev.target.closest(".buddy-tile") : null;
      if (!tile || tile.disabled) return;
      const id = tile.getAttribute("data-user-id");
      if (!id) return;
      const nowOn = !selected.has(id);
      if (nowOn) selected.add(id); else selected.delete(id);
      tile.classList.toggle("is-selected", nowOn);
      tile.setAttribute("aria-pressed", nowOn ? "true" : "false");
      syncFooter();
      if (nowOn) promoteFrom(id);
    });

    function leave(send) {
      const ids = Array.from(selected);
      if (send && ids.length) {
        deck.queue(
          `${ids.length} buddy request${ids.length === 1 ? "" : "s"} sent`,
          () => window.Buddy.sendRequests(ids).then((res) => {
            // The graph moved, so anything cached off it is stale.
            if (window.Buddy.invalidate) window.Buddy.invalidate();
            return res;
          }),
          (res) => {
            const sent = (res && res.sent) || [];
            const failed = (res && res.failed) || [];
            // Says what actually happened rather than what was asked for — a
            // batch where two of five bounced is not "5 sent".
            return failed.length
              ? `${sent.length} sent, ${failed.length} didn't go through`
              : `All ${sent.length} delivered`;
          },
        );
      }
      deck.next();
    }
    el.querySelector(".ob-btn--go").addEventListener("click", () => leave(true));
    el.querySelector(".ob-btn--skip").addEventListener("click", () => leave(false));

    /**
     * The suggestions were asked for the moment first-run began — while the
     * user was still naming themselves on slide 1 — so by the time this slide
     * arrives the grid is usually already painted. When it is not, this slide
     * shows its loading line and fills in behind the user, who can carry on
     * regardless: Skip works on an empty grid.
     */
    function load() {
      if (loaded) return;
      const pending = window.Buddy.takePrefetchedOnboarding
        ? window.Buddy.takePrefetchedOnboarding()
        : null;
      (pending || window.Buddy.onboardingSuggestions(12)).then(
        (res) => {
          network = window.BuddyNetwork.from(res);
          render((res && res.suggestions) || []);
        },
        (err) => {
          // Best-effort by design: a discovery step is not worth blocking a
          // signup on. The grid says so and Skip still works.
          console.warn("Buddy suggestions unavailable:", err);
          render([]);
        },
      );
    }

    return { el, onEnter: load, prefetch: load };
  }

  // ── 3 · BoardGameGeek ──────────────────────────────────────────────────────
  function buildBgg(deck) {
    const el = slideEl("ob-slide--bgg", `
      <div class="ob-slide__scroll">
        <div class="ob-plate">
          <img src="assets/credits/bgg-logo.svg" alt="Powered by BoardGameGeek"
               class="ob-plate__mark" />
        </div>
        <h2 class="ob-slide__title">Bring your shelf across</h2>
        <p class="ob-slide__body">
          Already keep your games on BGG? Link it and we'll pull your collection,
          wishlist and play history. We use your password once to sign in, then
          store it encrypted so later syncs run on their own.
        </p>
        <form class="ob-bgg__form" novalidate>
          <div class="polaroid-field ob-field">
            <label class="polaroid-field__label" for="ob-bgg-user">BGG username</label>
            <input id="ob-bgg-user" type="text" name="username" autocomplete="username"
                   class="input input-bordered input-sm polaroid-field__input"
                   autocapitalize="none" autocorrect="off" spellcheck="false"
                   placeholder="Your BGG handle" />
          </div>
          <div class="polaroid-field ob-field">
            <label class="polaroid-field__label" for="ob-bgg-pass">BGG password</label>
            <input id="ob-bgg-pass" type="password" name="password"
                   class="input input-bordered input-sm polaroid-field__input"
                   autocomplete="current-password" placeholder="Your BGG password" />
          </div>
          <div class="ob-field__error text-error text-xs" hidden></div>
        </form>
        <p class="ob-slide__note">
          No BGG account, or rather not right now? Skip — you can link one any
          time from Settings. The import runs in the background either way.
        </p>
      </div>
      <div class="ob-slide__actions">
        <button type="button" class="btn btn-ghost ob-btn ob-btn--skip">Skip</button>
        <button type="button" class="btn btn-primary ob-btn ob-btn--go">Link account</button>
      </div>
    `);

    const userEl = el.querySelector("#ob-bgg-user");
    const passEl = el.querySelector("#ob-bgg-pass");
    const errorEl = el.querySelector(".ob-field__error");

    el.querySelector(".ob-btn--skip").addEventListener("click", () => deck.next());
    el.querySelector(".ob-btn--go").addEventListener("click", () => {
      const username = (userEl.value || "").trim().replace(/^@+/, "");
      const password = passEl.value || "";
      // Same local-only refusal as the name field: half a credential pair is
      // not a request worth making, and the answer would be a 400 the user
      // reads two slides later.
      if (!username || !password) {
        errorEl.hidden = false;
        errorEl.textContent = "Both your BGG handle and password, or Skip.";
        (username ? passEl : userEl).focus();
        return;
      }
      const link = deck.queue(
        "BoardGameGeek linked",
        () => window.api.post("/bgg/link", { username, password }),
        () => `@${username} · stored encrypted`,
      );
      // The import is its own job and its own ledger line, because it is the
      // one write here that legitimately takes minutes. The deck does not wait
      // for it, and neither does the user — it finishes server-side whatever
      // happens to this screen.
      //
      // It DOES wait on the link, though: an import fired against credentials
      // that were rejected has nothing to import, and a ledger line claiming
      // "214 games" under a link that failed is the deck telling the user
      // something that did not happen.
      deck.queue(
        "Importing your collection",
        () => link.promise.then(() => window.api.post("/bgg/sync", {}, { timeoutMs: 120000 })),
        (res) => {
          const games = (res && (res.games_imported ?? res.collection_count)) || 0;
          const plays = (res && (res.plays_imported ?? res.play_count)) || 0;
          return `${games} games, ${plays} plays`;
        },
      );
      deck.next();
    });

    return { el };
  }

  // ── 4 · The finale (uncounted) ─────────────────────────────────────────────
  // ── 4 · Import your history ────────────────────────────────────────────────
  // Purely informational — the only slide here that queues nothing and asks
  // nothing. Placed after BoardGameGeek on purpose: someone who just tapped
  // Skip on that step because they do not use BGG is exactly who the note
  // importer is for, and this reaches them in the same breath.
  //
  // Deliberately does NOT offer a "take me there" button. Jumping into a
  // six-step wizard from inside first-run setup would strand the user
  // mid-onboarding with a half-finished deck behind them.
  function buildImport(deck) {
    const el = slideEl("ob-slide--import", `
      <div class="ob-slide__scroll">
        <div class="ob-done__mark">
          <span class="ob-done__ring"><i data-icon="history" class="w-8 h-8"></i></span>
        </div>
        <h2 class="ob-slide__title ob-slide__title--center">Already keep score somewhere?</h2>
        <p class="ob-slide__body ob-slide__body--center">
          A page of tally marks, a note full of who-beat-who, a table you've kept
          for years — paste it into <b>Settings &rsaquo; Import plays</b> and it
          becomes real plays, with your scores and winners intact.
        </p>
        <p class="ob-slide__note">
          Nothing to do now. You review every play it reads before anything is
          saved, so there's no way to make a mess of your history by trying it.
        </p>
      </div>
      <div class="ob-slide__actions">
        <button type="button" class="btn btn-primary ob-btn ob-btn--go">Continue</button>
      </div>
    `);
    el.querySelector(".ob-btn--go").addEventListener("click", () => deck.next());
    return { el };
  }

  function buildFinale(deck) {
    const el = slideEl("ob-slide--done", `
      <div class="ob-slide__scroll">
        <div class="ob-done__mark">
          <span class="ob-done__ring"><i data-icon="check" class="w-8 h-8"></i></span>
        </div>
        <h2 class="ob-slide__title ob-slide__title--center">You're all set</h2>
        <p class="ob-slide__body ob-slide__body--center">
          Everything below is already on its way. Nothing here needs you.
        </p>
        <div class="ob-ledger" data-ledger aria-live="polite"></div>
      </div>
      <div class="ob-slide__actions">
        <button type="button" class="btn btn-primary ob-btn ob-btn--go">Start playing</button>
      </div>
    `);
    const ledger = el.querySelector("[data-ledger]");
    el.querySelector(".ob-btn--go").addEventListener("click", () => deck.finish());

    /**
     * The ledger is the ONLY place a queued write ever reports. It repaints
     * whole because nothing in it is interactive — there is no control here to
     * destroy under a finger, which is what makes a full patch safe on this
     * one host and not on the buddy grid.
     */
    function renderLedger(jobs) {
      if (!jobs.length) {
        ledger.innerHTML = `<p class="ob-ledger__msg">You skipped every step —
          nothing to send. It's all in Settings when you want it.</p>`;
        return;
      }
      ledger.innerHTML = jobs.map((j) => {
        // Names from the vendored set only (ui/icons.js) — an unknown name
        // renders an empty <i>, which is blank on iOS.
        const icon = j.status === "done" ? "check"
          : j.status === "failed" ? "alert-triangle" : "refresh-cw";
        const detail = j.status === "done"
          ? (typeof j.detail === "string" ? j.detail : "Done")
          : j.status === "failed"
            // Names the step's permanent home, because this line is the last
            // time the user will be told.
            ? `Didn't go through — try again from Settings${j.error ? ` (${esc(j.error)})` : ""}`
            : "Running — carry on, it keeps going";
        return `
          <div class="ob-job ob-job--${j.status}">
            <i data-icon="${icon}" class="w-4 h-4 ob-job__mark"></i>
            <div>
              <div class="ob-job__label">${esc(j.label)}</div>
              <div class="ob-job__meta">${detail}</div>
            </div>
          </div>`;
      }).join("");
      window.BgbIcons.render(ledger);
    }

    renderLedger([]);
    return { el, renderLedger };
  }

  window.OnboardingDeckSlides = {
    /**
     * @returns {{profile: Object, buddies: Object, bgg: Object,
     *            importHint: Object, finale: Object}}
     */
    build(deck) {
      return {
        profile: buildProfile(deck),
        buddies: buildBuddies(deck),
        bgg: buildBgg(deck),
        importHint: buildImport(deck),
        finale: buildFinale(deck),
      };
    },
  };
})();
