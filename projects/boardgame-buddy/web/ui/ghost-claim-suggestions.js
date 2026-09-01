// ui/ghost-claim-suggestions.js — the two ghost-claim sections on the Buddies
// screen, and the surgical patcher both share.
//
// Two lists, opposite ends of the same conversation:
//
//   • "Is this you?"    — ghosts on a buddy's roster whose name looks like
//                         yours. You ask.  (renderGhostClaimSection)
//   • "Link requests"   — people asking to claim one of YOUR ghosts.
//                         You answer. (renderGhostClaimRequests)
//
// Lives here rather than in views/buddies-view.js because that file is already
// the third-largest in the project and well past the ~300-line guidance in
// CLAUDE.md. It follows ui/buddy-suggestion-rail.js's shape: a render function
// that returns "" on an empty list, so the view can compose it
// unconditionally, plus a patcher so a tapped row repaints without the whole
// screen re-forming under the finger.
//
// The view owns all state and all writes; nothing here fetches or mutates.
// `opts.stateFor(key)` is how it tells a row what this session did to it.

(function () {
  // What the actions cell shows. Deliberately verbs and not list membership,
  // for the reason buddies-view.js:40-58 spells out: a mutation does not
  // restructure the lists, so a row stays where it is — and "Requested" is a
  // true statement about what happened that makes no claim about which
  // section the row now belongs in.
  //
  //   null         → the row's normal buttons
  //   "busy"       → a write is in flight
  //   "requested"  → we asked (suggestion side)
  //   "dismissed"  → we said not-me (suggestion side)
  //   "accepted" / "declined" → we answered (request side)
  const RESOLVED_LABEL = {
    requested: "Requested",
    dismissed: "Not you",
    accepted: "Linked",
    declined: "Declined",
    cancelled: "Withdrawn",
  };

  /** "12 plays · last 4 Aug 2026" — the line under every row in both lists. */
  function playsLine(playCount, lastPlayedAt, prefix) {
    const n = Number(playCount) || 0;
    const plays = `${prefix || ""}${n} ${n === 1 ? "play" : "plays"}`;
    return lastPlayedAt ? `${plays} · last ${formatDate(lastPlayedAt)}` : plays;
  }

  function resolvedChip(state) {
    const label = RESOLVED_LABEL[state];
    if (!label) return "";
    return `<button class="btn btn-ghost btn-xs btn-disabled" aria-disabled="true">${label}</button>`;
  }

  function busyChip() {
    return `<button class="btn btn-ghost btn-xs btn-disabled" aria-disabled="true">Working…</button>`;
  }

  // ── "Is this you?" ────────────────────────────────────────────────────────

  /**
   * The key a suggestion row is addressed by. A ghost has no id, so the pair
   * that identifies it is the key — and it is the NORMALIZED name, so two
   * spellings of one ghost stay one row under the finger.
   */
  function suggestionKey(s) {
    return `${s.owner_user_id}|${s.ghost_name_key}`;
  }

  function suggestionActions(s, state) {
    if (state === "busy") return busyChip();
    const chip = resolvedChip(state);
    if (chip) return chip;
    // A claim already pending from a previous session. The row stays visible
    // (the server keeps it) so the user can see they already asked, rather
    // than the suggestion silently disappearing and looking like a bug.
    if (s.claim_status === "pending") {
      return `<button class="btn btn-ghost btn-xs btn-disabled" aria-disabled="true">Requested</button>`;
    }
    // TWO layers, both required. jsStr closes the JS string; escapeAttr then
    // closes the HTML attribute the JS is written inside. jsStr alone does not
    // escape a double quote, and these names are FREE TEXT TYPED BY SOMEONE
    // ELSE — a ghost called `Bob "the ghost"` would end the onclick attribute
    // early and inject markup. That could not happen before this feature,
    // because the only ghost names on screen were the viewer's own.
    const args = `'${jsStr(s.owner_user_id)}','${jsStr(s.ghost_name_key)}','${jsStr(s.ghost_display_name)}'`;
    const claim = escapeAttr(`event.stopPropagation();window.buddiesView._claimGhost(${args})`);
    const dismiss = escapeAttr(`event.stopPropagation();window.buddiesView._dismissGhost(${args})`);
    return `
      <button class="btn btn-primary btn-xs" onclick="${claim}">Claim</button>
      <button class="btn btn-ghost btn-xs" onclick="${dismiss}">Not me</button>`;
  }

  /**
   * @param {Array} suggestions GhostClaimSuggestion[] from GET /ghost-claims/suggestions
   * @param {{stateFor: (key: string) => string|null}} opts
   * @returns {string} "" when there is nothing to suggest — the absence of the
   *   section is the empty state. A heading over "no matches" would be the app
   *   announcing that it looked for you and found nothing, every single visit.
   */
  function renderGhostClaimSection(suggestions, opts) {
    const list = suggestions || [];
    if (!list.length) return "";
    const stateFor = (opts && opts.stateFor) || (() => null);
    return `
      <section class="buddies-section ghost-claim-section">
        <h3>Is this you?</h3>
        <p class="ghost-claim-section__lede">
          Buddies have logged plays with these names. Claim one and the plays
          become yours.
        </p>
        <ul class="buddies-list">
          ${list.map((s) => {
            const key = suggestionKey(s);
            return `
            <li class="buddies-row buddies-row--ghost ghost-claim-row" data-claim-key="${escapeAttr(key)}">
              ${window.BgbBadge.render({
                avatar: null,
                displayName: s.ghost_display_name,
                size: "sm",
                isGhost: true,
                extraClass: "buddies-row__avatar buddies-row__avatar--ghost",
              })}
              <div class="buddies-row__body">
                <div class="buddies-row__name">
                  ${escapeHtml(s.owner_display_name)}'s ghost
                  <strong>${escapeHtml(s.ghost_display_name)}</strong>
                </div>
                <div class="buddies-row__when">
                  ${escapeHtml(playsLine(s.play_count, s.last_played_at))}
                </div>
              </div>
              <div class="ghost-claim-row__actions" data-claim-actions="${escapeAttr(key)}">
                ${suggestionActions(s, stateFor(key))}
              </div>
            </li>`;
          }).join("")}
        </ul>
      </section>
    `;
  }

  // ── "Link requests" ───────────────────────────────────────────────────────

  function requestActions(r, state) {
    if (state === "busy") return busyChip();
    const chip = resolvedChip(state);
    if (chip) return chip;
    const accept = escapeAttr(`event.stopPropagation();window.buddiesView._acceptClaim('${jsStr(r.id)}')`);
    const reject = escapeAttr(`event.stopPropagation();window.buddiesView._rejectClaim('${jsStr(r.id)}')`);
    return `
      <button class="btn btn-primary btn-xs" onclick="${accept}">Accept</button>
      <button class="btn btn-ghost btn-xs" onclick="${reject}">Decline</button>`;
  }

  function sentActions(r, state) {
    if (state === "busy") return busyChip();
    const chip = resolvedChip(state);
    if (chip) return chip;
    const cancel = escapeAttr(`event.stopPropagation();window.buddiesView._cancelClaim('${jsStr(r.id)}')`);
    return `<button class="btn btn-ghost btn-xs" onclick="${cancel}">Cancel</button>`;
  }

  /**
   * Incoming claims on the viewer's own ghosts.
   *
   * Sits directly under the incoming BUDDY requests on the Buddies screen:
   * both are "someone is waiting on you", and separating them by half a
   * screen would make the second one easy to miss.
   *
   * @param {Array} incoming GhostClaimResponse[] with direction "incoming"
   * @param {{stateFor: (id: string) => string|null}} opts
   */
  function renderGhostClaimRequests(incoming, opts) {
    const list = incoming || [];
    if (!list.length) return "";
    const stateFor = (opts && opts.stateFor) || (() => null);
    return `
      <section class="buddies-section ghost-claim-section">
        <h3>Link requests</h3>
        <ul class="buddies-list">
          ${list.map((r) => `
            <li class="buddies-row ghost-claim-row" data-claim-id="${escapeAttr(r.id)}">
              ${window.BgbBadge.render({
                avatar: r.other_avatar,
                displayName: r.other_display_name,
                size: "sm",
                extraClass: "buddies-row__avatar",
              })}
              <div class="buddies-row__body">
                <div class="buddies-row__name">
                  ${escapeHtml(r.other_display_name)} asked to link
                  <strong>${escapeHtml(r.ghost_display_name)}</strong>
                </div>
                <div class="buddies-row__when">
                  ${escapeHtml(playsLine(r.play_count, r.last_played_at, "on "))}
                  of yours
                </div>
              </div>
              <div class="ghost-claim-row__actions" data-claim-actions="${escapeAttr(r.id)}">
                ${requestActions(r, stateFor(r.id))}
              </div>
            </li>
          `).join("")}
        </ul>
      </section>
    `;
  }

  /**
   * Claims the viewer SENT and is waiting on.
   *
   * Not just symmetry with the buddy "Sent" list: a claim made from the play
   * sheet may never appear in "Is this you?" at all (the sheet does not filter
   * by name), so without this list there is no surface that shows it and no
   * way to withdraw it.
   *
   * @param {Array} outgoing GhostClaimResponse[] with direction "outgoing"
   * @param {{stateFor: (id: string) => string|null}} opts
   */
  function renderGhostClaimsSent(outgoing, opts) {
    const list = outgoing || [];
    if (!list.length) return "";
    const stateFor = (opts && opts.stateFor) || (() => null);
    return `
      <section class="buddies-section ghost-claim-section">
        <h3>Link requests sent</h3>
        <ul class="buddies-list">
          ${list.map((r) => `
            <li class="buddies-row buddies-row--ghost ghost-claim-row" data-claim-id="${escapeAttr(r.id)}">
              ${window.BgbBadge.render({
                avatar: null,
                displayName: r.ghost_display_name,
                size: "sm",
                isGhost: true,
                extraClass: "buddies-row__avatar buddies-row__avatar--ghost",
              })}
              <div class="buddies-row__body">
                <div class="buddies-row__name">
                  ${escapeHtml(r.other_display_name)}'s ghost
                  <strong>${escapeHtml(r.ghost_display_name)}</strong>
                </div>
                <div class="buddies-row__when">Awaiting reply</div>
              </div>
              <div class="ghost-claim-row__actions" data-claim-actions="${escapeAttr(r.id)}">
                ${sentActions(r, stateFor(r.id))}
              </div>
            </li>
          `).join("")}
        </ul>
      </section>
    `;
  }

  // ── Surgical repaint ──────────────────────────────────────────────────────

  /**
   * Repaint one row's actions cell in place.
   *
   * A full render() would re-form both lists while the user's finger is still
   * on the button — the continuity break buddies-view.js's mutation discipline
   * exists to avoid. Only the cell changes; the row stays exactly where it is
   * until the next _load().
   *
   * @param {string} key data-claim-key (suggestions) or data-claim-id (requests)
   * @param {string|null} state one of the verbs above, or null to restore
   * @param {object} [row] the suggestion / request the cell is for, needed to
   *   rebuild the live buttons when `state` is null
   * @param {"suggestion"|"request"|"sent"} [kind]
   */
  function patchGhostClaimRow(key, state, row, kind) {
    const cell = document.querySelector(`[data-claim-actions="${window.CSS && CSS.escape ? CSS.escape(key) : key}"]`);
    if (!cell) return;
    if (state) {
      cell.innerHTML = state === "busy" ? busyChip() : resolvedChip(state);
      return;
    }
    if (!row) return;
    if (kind === "request") cell.innerHTML = requestActions(row, null);
    else if (kind === "sent") cell.innerHTML = sentActions(row, null);
    else cell.innerHTML = suggestionActions(row, null);
  }

  window.renderGhostClaimSection = renderGhostClaimSection;
  window.renderGhostClaimRequests = renderGhostClaimRequests;
  window.renderGhostClaimsSent = renderGhostClaimsSent;
  window.patchGhostClaimRow = patchGhostClaimRow;
  window.ghostClaimSuggestionKey = suggestionKey;
})();
