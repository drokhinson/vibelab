// @ts-check
// widgets/invite-review-sheet.js — the plays in one grouped invite.
//
// Opened from the bell's Review button on an invite that stands for several
// plays (an import, or a run of identical plays). Each row is one play with its
// own Decline; the button at the foot accepts every play still listed. Nothing
// counts until that button, so a person can decline the nights they were not
// at and take the rest in one tap.
//
// Its class is named in the theme re-point list in styles.css; a body-level
// sheet lands outside the screen that opened it (.claude/rules/theming.md §8).

(function () {
  /**
   * @typedef {Object} InviteItem
   * @property {string} play_id
   * @property {string|null} [game_name]
   * @property {string|null} [played_at]
   */

  /**
   * @typedef {Object} InviteReviewOpts
   * @property {string} who            Whoever logged the plays.
   * @property {string[]} playIds      Every play in the entry.
   * @property {Element|null} [returnFocus]
   * @property {() => void} [onDone]   After anything was accepted or declined.
   */

  const sheet = new window.BgbBottomSheet({
    id: "bgb-invite-review-sheet",
    className: "invite-sheet",
    label: "Review plays",
  });

  /** @type {{opts: InviteReviewOpts|null, items: InviteItem[]|null, declined: Set<string>, busy: Set<string>, accepting: boolean, error: string|null, changed: boolean}} */
  const state = {
    opts: null, items: null, declined: new Set(), busy: new Set(),
    accepting: false, error: null, changed: false,
  };

  function remaining() {
    return (state.items || []).filter((it) => !state.declined.has(it.play_id));
  }

  /** @param {InviteItem} it */
  function row(it) {
    const declined = state.declined.has(it.play_id);
    const busy = state.busy.has(it.play_id);
    const action = declined
      ? `<span class="invite-sheet__done">Declined</span>`
      : `<button type="button" class="invite-sheet__decline" data-decline="${escapeAttr(it.play_id)}"
                 ${busy || state.accepting ? "disabled" : ""}>${busy ? "Working…" : "Decline"}</button>`;
    return `
      <div class="invite-sheet__row ${declined ? "is-declined" : ""}">
        <span class="invite-sheet__what">
          <span class="invite-sheet__game">${escapeHtml(it.game_name || "A game")}</span>
          <span class="invite-sheet__date">${it.played_at ? escapeHtml(formatDate(it.played_at)) : "Date unknown"}</span>
        </span>
        ${action}
      </div>
    `;
  }

  function listHtml() {
    if (state.error) return `<p class="invite-sheet__note">${escapeHtml(state.error)}</p>`;
    if (!state.items) return `<p class="invite-sheet__note">Loading plays…</p>`;
    if (!state.items.length) return `<p class="invite-sheet__note">Nothing left to answer here.</p>`;
    return state.items.map(row).join("");
  }

  function footHtml() {
    const n = remaining().length;
    if (!state.items || !n) return "";
    return `
      <button type="button" class="bgb-sheet__confirm" data-accept-rest ${state.accepting ? "disabled" : ""}>
        ${state.accepting ? "Accepting…" : `Accept ${n} ${n === 1 ? "play" : "plays"}`}
      </button>
    `;
  }

  function render() {
    const opts = /** @type {InviteReviewOpts} */ (state.opts);
    return `
      <div class="bgb-sheet__panel invite-sheet__panel" tabindex="-1">
        <div class="bgb-sheet__grip" aria-hidden="true"></div>
        <h3 class="bgb-sheet__title">${escapeHtml(opts.who)}'s plays</h3>
        <p class="bgb-sheet__sub">None of these count yet. Decline the ones you weren't at, then accept the rest.</p>
        <div class="bgb-sheet__list invite-sheet__list">${listHtml()}</div>
        <div class="bgb-sheet__foot invite-sheet__foot">${footHtml()}</div>
        <button type="button" class="bgb-sheet__cancel" data-action="close">Close</button>
      </div>
    `;
  }

  /** Repaint the list and the foot in place; the panel and its focus stay. */
  function paint() {
    const root = document.getElementById("bgb-invite-review-sheet");
    if (!root) return;
    const list = root.querySelector(".invite-sheet__list");
    const foot = root.querySelector(".invite-sheet__foot");
    if (list) list.innerHTML = listHtml();
    if (foot) foot.innerHTML = footHtml();
  }

  /** @param {string} playId */
  async function decline(playId) {
    if (state.busy.has(playId) || state.accepting) return;
    state.busy.add(playId);
    paint();
    try {
      await window.NotificationFeed.unlink({ playIds: [playId] });
      state.declined.add(playId);
      state.changed = true;
    } catch (e) {
      showToast((e && e.message) || "Couldn't decline that play", "error");
    } finally {
      state.busy.delete(playId);
      paint();
    }
  }

  async function acceptRest() {
    const ids = remaining().map((it) => it.play_id);
    if (!ids.length || state.accepting) return;
    state.accepting = true;
    paint();
    try {
      await window.NotificationFeed.acceptInvites(ids);
      state.changed = true;
      showToast(ids.length === 1 ? "Added to your stats" : `Added ${ids.length} plays to your stats`,
                "success");
      sheet.close();
    } catch (e) {
      showToast((e && e.message) || "Couldn't accept those plays", "error");
      state.accepting = false;
      paint();
    }
  }

  window.BgbInviteReviewSheet = {
    /** @param {InviteReviewOpts} opts */
    open(opts) {
      state.opts = opts;
      state.items = null;
      state.error = null;
      state.declined = new Set();
      state.busy = new Set();
      state.accepting = false;
      state.changed = false;
      sheet.open({
        html: render(),
        returnFocus: opts.returnFocus || null,
        onClick(e) {
          const t = /** @type {HTMLElement} */ (e.target);
          const dec = /** @type {HTMLElement|null} */ (t.closest("[data-decline]"));
          if (dec) { decline(dec.dataset.decline || ""); return; }
          if (t.closest("[data-accept-rest]")) acceptRest();
        },
        onOpen(root) {
          /** @type {HTMLElement|null} */ (root.querySelector(".bgb-sheet__panel"))?.focus();
        },
        onClose() {
          if (state.changed && opts.onDone) opts.onDone();
        },
      });
      window.api.post("/notifications/invites/plays", { play_ids: opts.playIds })
        .then((r) => { state.items = (r && r.items) || []; })
        .catch((e) => { state.error = (e && e.message) || "Couldn't load these plays."; })
        .finally(paint);
    },
  };
})();
