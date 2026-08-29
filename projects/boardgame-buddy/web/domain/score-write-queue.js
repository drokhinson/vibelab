// domain/score-write-queue.js — host-only ordered writer for the live scores
// table. One cell, one request at a time.
//
// Why this exists. Score cells are an `oninput` handler with no debounce, so
// typing "36" used to fire two INDEPENDENT upserts for the same row — one
// carrying 3, one carrying 36 — over separate HTTP requests with no ordering
// between them. If the second one committed first, the row ended at 3 and
// stayed there. The host saw the corruption the moment they clicked away,
// because the cell repaint skips only the cell that currently has focus.
//
// The fix is structural rather than a guard bolted on top: for a given cell
// there is never more than one request outstanding, so the database cannot see
// two writes to that row out of order. Keystrokes arriving while a write is in
// flight replace the queued value, and the pump laps to send the newest one
// after the older one has resolved. Last keystroke typed is therefore always
// the last row written.
//
// Deliberately NOT a timer-based debounce. A fixed trailing window would add
// its latency to every edit including the single-digit one — the case where
// there is nothing to coalesce and where the spectator mirror is most visible.
// Chaining on the request instead sends the first keystroke immediately and
// coalesces the rest at whatever the network is actually costing, which is the
// right window by construction.

// @ts-check

(function () {
  /** @param {string|number|null|undefined} v */
  function normScore(v) {
    return v == null || v === "" ? null : Number(v);
  }

  /**
   * @typedef {Object} Intent
   * @property {number|null} value   newest locally-typed value for the cell
   * @property {number} seq          bumped on every local edit
   * @property {number} sentSeq      the seq most recently handed to the network
   * @property {boolean} sending     a pump loop currently owns this cell
   */

  class ScoreWriteQueue {
    /**
     * @param {(rows: Array<Object>) => Promise<any>} send must REJECT on
     *   failure. supabase-js v2 resolves with {data, error} instead of
     *   rejecting, so the caller has to convert — see LiveScores._sendRows.
     */
    constructor(send) {
      this._send = send;
      /**
       * key "<participant>|<round>" → Intent.
       *
       * An intent lives from the local edit until the TABLE is observed to
       * agree with it — not until the HTTP resolves. That gap (write committed,
       * its own Realtime echo not yet delivered, host already typing the next
       * digit) is exactly where a stale echo lands, and it is the gap the old
       * `_pending` map had already deleted itself out of.
       * @type {Map<string, Intent>}
       */
      this._intents = new Map();
      this._seq = 0;
      /** @type {Set<Promise<any>>} */
      this._inflight = new Set();
    }

    /** @returns {string} */
    keyFor(participantId, roundIndex) {
      return `${participantId}|${Number(roundIndex)}`;
    }

    /** @returns {Intent|undefined} */
    intentFor(key) {
      return this._intents.get(key);
    }

    /** [key, value] for every unconfirmed intent — what refresh()/seed() re-apply. */
    *entries() {
      for (const [key, intent] of this._intents) yield [key, intent.value];
    }

    clear() {
      this._intents.clear();
    }

    /**
     * Record a local edit and see that the table ends up holding it.
     * @param {string} participantId
     * @param {number} roundIndex
     * @param {string|number|null} value
     * @returns {Promise<void>}
     */
    queue(participantId, roundIndex, value) {
      const key = this.keyFor(participantId, roundIndex);
      const prev = this._intents.get(key);
      this._intents.set(key, {
        value: normScore(value),
        seq: ++this._seq,
        sentSeq: prev ? prev.sentSeq : 0,
        sending: !!(prev && prev.sending),
      });
      // A pump already owns this cell; it will pick the new value up on its
      // next lap. Starting a second one is exactly the race being fixed.
      if (prev && prev.sending) return Promise.resolve();
      const p = this._pump(key, participantId, roundIndex);
      this._inflight.add(p);
      // _pump swallows send failures, but keep the bookkeeping chain from
      // becoming an unhandled rejection if it ever throws for another reason.
      p.then(() => {}, () => {}).then(() => this._inflight.delete(p));
      return p;
    }

    /**
     * Drive one cell until the newest typed value has been sent.
     * @param {string} key
     */
    async _pump(key, participantId, roundIndex) {
      const start = this._intents.get(key);
      if (!start) return;
      start.sending = true;
      try {
        for (;;) {
          const cur = this._intents.get(key);
          // `seq` is captured before the await below and re-read here after
          // it. This one condition is reached from both the success and the
          // failure path, so a keystroke that arrived while a write was
          // failing still goes out, and a write that succeeded stops the loop
          // only when nothing newer is waiting.
          if (!cur || cur.sentSeq === cur.seq) break;
          cur.sentSeq = cur.seq;
          try {
            await this._send([{
              participant_id: participantId,
              round_index: Number(roundIndex),
              score: cur.value,
            }]);
          } catch (_) {
            // Best-effort, like every other mirror write. The intent STAYS in
            // the map: the overlay keeps showing the host's value and
            // refresh() re-applies it, so an offline host neither loses a cell
            // nor watches the grid freeze. We do not retry the same value —
            // the loop only laps when a NEWER one is waiting.
          }
        }
      } finally {
        const cur = this._intents.get(key);
        if (cur) cur.sending = false;
      }
    }

    /**
     * The table came back holding `value` for this cell.
     * @returns {boolean} true if the incoming row should be applied to the cache.
     */
    accept(key, value) {
      const intent = this._intents.get(key);
      if (!intent) return true;                             // no local claim — trust the table
      if (normScore(value) !== intent.value) return false;  // stale echo of an older write
      this._intents.delete(key);                            // confirmed: the table agrees
      return true;
    }

    /**
     * Mirror an Array.splice(idx, 1) on the round axis, so intents stay keyed
     * to the round they are now displayed as (see LiveScores.removeRoundAt).
     * @param {number} idx
     */
    shiftRounds(idx) {
      const next = new Map();
      for (const [key, intent] of this._intents) {
        const sep = key.lastIndexOf("|");
        const r = Number(key.slice(sep + 1));
        if (r === idx) continue;
        next.set(`${key.slice(0, sep)}|${r > idx ? r - 1 : r}`, intent);
      }
      this._intents = next;
    }

    /**
     * Settle every in-flight request. Called before a bulk rewrite so a
     * per-cell upsert cannot land BEHIND removeRoundAt's DELETE and re-insert
     * its row at the pre-shift index — the phantom trailing round that method
     * exists to prevent.
     *
     * Bounded: a pump can lap while we wait (the host is still typing), so
     * re-await, but never spin forever.
     */
    async drain() {
      for (let i = 0; i < 5 && this._inflight.size; i++) {
        await Promise.allSettled(Array.from(this._inflight));
      }
    }
  }

  window.ScoreWriteQueue = ScoreWriteQueue;
})();
