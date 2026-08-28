// @ts-check
// domain/outbox.js — Queue of finished plays waiting to reach the server.
//
// The one write offline mode has to survive. Everything else in the host
// cascade is local (the draft lives in localStorage, the pickers paint from
// bgbCache); the play itself is the single thing that must eventually land in
// Postgres. It goes in here, and flushes on the next online session.
//
// Storage: its own top-level localStorage key, deliberately NOT a bgbCache
// namespace. bgbCache evicts ~25% of its oldest entries when it hits its 3 MB
// budget (domain/cache.js) — correct for cached reads, catastrophic for the
// only copy of a play someone spent two hours recording. Nothing in here is
// evictable, and nothing in here expires.
//
// Retry safety comes from `client_key` (migration 048): one UUID per queued
// play, re-sent on every attempt. If the request lands but the response is
// lost — signal drops mid-flush, tab closed, backend restarts — the retry
// returns the original play instead of writing a second one. Without that the
// queue would have to choose between losing plays and duplicating them.

/**
 * @typedef {Object} OutboxEntry
 * @property {string} clientKey     UUID, also carried on payload.client_key
 * @property {string|null} userId   Supabase uid that recorded it — see _mine()
 * @property {Object} payload       A PlayCreate body (PlaySession.toPlayCreate())
 * @property {Object|null} gameSnapshot  {id,name,thumbnail_url} for the pending UI
 * @property {number} queuedAt      Date.now() at enqueue
 * @property {number} attempts      Flush attempts so far
 * @property {string|null} lastError
 * @property {"queued"|"failed"} state
 */

(function () {
  const LS_KEY = "bgb_outbox_v1";

  // A play the server has definitively rejected will be rejected identically
  // forever (its game was deleted, its shape is invalid). Retrying it on every
  // flush would wedge the queue behind it, so it's parked as "failed" and
  // surfaced in Settings for the user to delete.
  const TERMINAL_STATUSES = new Set([400, 403, 404, 409, 410, 422]);

  let _flushing = null;

  function _read() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function _write(entries) {
    localStorage.setItem(LS_KEY, JSON.stringify(entries));
  }

  function _currentUid() {
    const me = window.store && window.store.get("user");
    if (me && me.id) return me.id;
    const sess = window.session;
    return (sess && sess.user && sess.user.id) || null;
  }

  /**
   * Entries belonging to the signed-in account.
   *
   * POST /plays writes under whoever's token is attached, not under whoever
   * recorded the game. On a shared device — sign out after an offline night,
   * a housemate signs in before the queue drains — an unscoped flush would
   * file someone else's play into their history. Entries queued before this
   * field existed have userId == null and are treated as the current user's,
   * which is the only account that could have produced them.
   *
   * @param {OutboxEntry[]} entries
   * @returns {OutboxEntry[]}
   */
  function _mine(entries) {
    const uid = _currentUid();
    if (!uid) return [];
    return entries.filter((e) => !e.userId || e.userId === uid);
  }

  // Publishing through the store lets the Play tab's pending banner and the
  // Settings list repaint without either of them polling.
  function _publish() {
    if (window.store) window.store.set("outboxCount", _mine(_read()).length);
  }

  function _newKey() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    // Pre-randomUUID Safari. Still crypto-backed — Math.random() would risk a
    // collision across two devices flushing into the same account.
    const b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  class Outbox {
    /**
     * Queue a finished play. THROWS when the write doesn't land — the caller
     * must surface that, because a silent failure here means the host believes
     * a play was saved that no longer exists anywhere.
     *
     * @param {Object} payload  PlaySession.toPlayCreate() output
     * @param {Object|null} gameSnapshot
     * @returns {OutboxEntry}
     */
    static enqueue(payload, gameSnapshot) {
      const clientKey = _newKey();
      /** @type {OutboxEntry} */
      const entry = {
        clientKey,
        userId: _currentUid(),
        payload: { ...payload, client_key: clientKey },
        gameSnapshot: gameSnapshot || null,
        queuedAt: Date.now(),
        attempts: 0,
        lastError: null,
        state: "queued",
      };
      const entries = _read();
      entries.push(entry);
      _write(entries); // throws on QuotaExceeded — deliberately uncaught
      _publish();
      return entry;
    }

    /** @returns {OutboxEntry[]} the signed-in user's entries, oldest first */
    static list() {
      return _mine(_read());
    }

    /** @returns {number} */
    static count() {
      return _mine(_read()).length;
    }

    /** @returns {number} entries the flush will actually retry */
    static pendingCount() {
      return _mine(_read()).filter((e) => e.state !== "failed").length;
    }

    /**
     * True while a flush is in flight.
     *
     * Entry.state is only ever "queued" or "failed" — there is deliberately no
     * third "uploading" value, because _flush()'s selector picks the first
     * entry whose state !== "failed" and would happily re-select one. The UI
     * treats the oldest non-failed entry as the active upload while this is
     * true, which is accurate given the loop is strictly serial.
     *
     * @returns {boolean}
     */
    static isFlushing() {
      return !!_flushing;
    }

    /**
     * Put a parked entry back in the queue.
     *
     * `failed` means the server rejected it outright (410 gone, 422 invalid),
     * so _flush() skips it to avoid wedging everything behind it. Retrying is
     * therefore an explicit user act: clear the flag and let the next flush
     * pick it up in order.
     *
     * @param {string} clientKey
     */
    static requeue(clientKey) {
      const all = _read();
      const entry = all.find((e) => e.clientKey === clientKey);
      if (!entry) return;
      entry.state = "queued";
      entry.lastError = null;
      _write(all);
      _publish();
    }

    /** @param {string} clientKey */
    static remove(clientKey) {
      _write(_read().filter((e) => e.clientKey !== clientKey));
      _publish();
    }

    /**
     * Push everything queued, oldest first. Safe to call freely — no-ops when
     * offline, signed out, empty, or already running.
     *
     * @returns {Promise<{sent: number, failed: number, remaining: number}>}
     */
    static flush() {
      if (_flushing) return _flushing;
      _flushing = Outbox._flush().finally(() => { _flushing = null; });
      return _flushing;
    }

    static async _flush() {
      const idle = { sent: 0, failed: 0, remaining: Outbox.count() };
      if (window.BgbNet && window.BgbNet.isOffline()) return idle;
      // No token means Play.create would 401 and burn an attempt for nothing.
      if (!window.session || !window.session.access_token) return idle;

      let sent = 0;
      let failed = 0;

      // Re-read the queue each iteration rather than iterating a snapshot: a
      // save can enqueue mid-flush, and writing back a stale array would drop
      // the new entry.
      for (;;) {
        const entries = _read();
        const entry = _mine(entries).find((e) => e.state !== "failed");
        if (!entry) break;

        entry.attempts++;
        _write(entries);

        let saved;
        try {
          saved = await window.Play.create(entry.payload);
        } catch (e) {
          const status = e && e.status;
          if (TERMINAL_STATUSES.has(status)) {
            // Park it and keep going — one bad play must not block the rest.
            const cur = _read();
            const row = cur.find((x) => x.clientKey === entry.clientKey);
            if (row) {
              row.state = "failed";
              row.lastError = (e && e.message) || "Upload rejected";
              _write(cur);
            }
            failed++;
            _publish();
            continue;
          }
          // Network died again, or the server is having a moment. Stop the
          // loop with everything still queued; the next trigger retries.
          const cur = _read();
          const row = cur.find((x) => x.clientKey === entry.clientKey);
          if (row) {
            row.lastError = (e && e.message) || "Upload failed";
            _write(cur);
          }
          break;
        }

        Outbox.remove(entry.clientKey);
        sent++;
        // Same seeding the live save path does, so the Play tab's "Another
        // Round" card reflects the play that just landed.
        if (saved && window.Play && window.Play.rememberLastPlay) {
          window.Play.rememberLastPlay(saved.play || saved);
        }
      }

      // Play.create already chains _invalidatePlayDeps() per call. Re-pull the
      // feed's first page once, at the end, so the user lands on a feed that
      // contains what just uploaded instead of a skeleton.
      //
      // AWAITED rather than fired and forgotten, because the event below hands
      // the page over: a FeedView the user is sitting on right now splices it
      // straight in instead of opening its own request and painting a beat
      // later. Costs the flush one round trip, which the uploads dialog's
      // "Uploading…" state already covers.
      if (sent > 0) {
        let page = null;
        if (window.Feed && window.Feed.refreshFirstPage) {
          try { page = await window.Feed.refreshFirstPage(); } catch (_) {}
        }
        // The queue's only other signal is store's `outboxCount`, and a count
        // can't say what landed — a mounted feed needs the cards. A document
        // CustomEvent is this project's cross-view channel (`status-changed`,
        // `play-changed`), consumed through View.listenDom so it unbinds on
        // unmount: "refresh the feed if it's open" needs no open-check here.
        document.dispatchEvent(new CustomEvent("plays-uploaded", {
          detail: { sent, page },
        }));
      }
      _publish();
      return { sent, failed, remaining: Outbox.count() };
    }
  }

  window.Outbox = Outbox;
})();
