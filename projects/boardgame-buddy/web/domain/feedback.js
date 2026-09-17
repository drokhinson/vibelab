// @ts-check
// domain/feedback.js — the Dev feedback board's client.
//
// The usual shape for this directory: static methods over window.api, so no view
// ever calls the client directly. Two things here are worth knowing before
// changing a line of it.
//
// THE OPTION LISTS ARE FETCHED, NEVER HARDCODED. Types and topics are seeded
// rows (migration 040), the same arrangement chapter types have, because adding
// a topic must not need a deploy. `options()` pulls both in parallel and caches
// them for the session — they change about once a year, and paying two requests
// every time the compose sheet opens would be the wrong trade in the other
// direction.
//
// THE LIST ROWS CARRY THEIR OWN LABELS. bgb_feedback_list denormalises
// feedback_type_label / _icon and topic_label / _icon onto every row, so
// rendering the board needs no join against the caches above. That is
// deliberate: the board is the screen's first paint and it costs one request.

(function () {
  /**
   * @typedef {Object} FeedbackOption
   * @property {string} id
   * @property {string} label
   * @property {string|null} icon           Lucide slug into ui/icons.js.
   * @property {number} display_order
   */

  /**
   * @typedef {Object} FeedbackItem
   * @property {string} id
   * @property {string} user_id
   * @property {string|null} author_name
   * @property {string} feedback_type
   * @property {string|null} feedback_type_label
   * @property {string|null} feedback_type_icon
   * @property {string} topic
   * @property {string|null} topic_label
   * @property {string|null} topic_icon
   * @property {string} body
   * @property {"open"|"resolved"} status
   * @property {string|null} resolved_at
   * @property {string|null} resolver_name
   * @property {string} created_at
   * @property {number} like_count
   * @property {boolean} viewer_liked
   */

  /**
   * @typedef {Object} FeedbackOptions
   * @property {FeedbackOption[]} types
   * @property {FeedbackOption[]} topics
   */

  /** @type {FeedbackOptions|null} */
  let _options = null;

  class Feedback {
    /**
     * The board. Empty strings mean "no filter" — api._buildUrl drops empty
     * query values, so the caller needs no branch per filter.
     * @param {Object} [opts]
     * @param {string} [opts.status]  Admin only; a non-admin always gets open.
     * @param {string} [opts.type]
     * @param {string} [opts.topic]
     * @returns {Promise<FeedbackItem[]>}
     */
    static list({ status, type, topic } = {}) {
      return window.api.get("/feedback", {
        status: status || "",
        type: type || "",
        topic: topic || "",
      });
    }

    /**
     * The two option sets, fetched once per session.
     * @returns {Promise<FeedbackOptions>}
     */
    static async options() {
      if (_options) return _options;
      // Parallel, not sequential: they are independent reads and the compose
      // sheet cannot paint until both land.
      const [types, topics] = await Promise.all([
        window.api.get("/feedback-types"),
        window.api.get("/feedback-topics"),
      ]);
      _options = { types: types || [], topics: topics || [] };
      return _options;
    }

    /**
     * Drop the cached option sets. Called on sign-out, since the next account
     * may be talking to a different backend in local dev.
     */
    static clearCache() {
      _options = null;
    }

    /**
     * @param {{feedback_type: string, topic: string, body: string}} body
     * @returns {Promise<FeedbackItem>}
     */
    static submit(body) {
      return window.api.post("/feedback", body);
    }

    /**
     * @param {string} id
     * @returns {Promise<{feedback_id: string, liked: boolean, like_count: number}>}
     */
    static like(id) {
      // No body: api._request only attaches one when given.
      return window.api.post(`/feedback/${encodeURIComponent(id)}/like`);
    }

    /**
     * @param {string} id
     * @returns {Promise<{feedback_id: string, liked: boolean, like_count: number}>}
     */
    static unlike(id) {
      return window.api.del(`/feedback/${encodeURIComponent(id)}/like`);
    }

    /** @param {string} id @returns {Promise<FeedbackItem>} */
    static resolve(id) {
      return window.api.post(`/feedback/${encodeURIComponent(id)}/resolve`);
    }

    /** @param {string} id @returns {Promise<FeedbackItem>} */
    static reopen(id) {
      return window.api.post(`/feedback/${encodeURIComponent(id)}/reopen`);
    }

    /**
     * Fold a settled like back into an item, in place.
     *
     * The view paints its own guess before the request goes out and calls this
     * with what the server actually counted. Both halves matter: the flag is
     * what the button reads, and the count is what stops two people liking the
     * same item at once from leaving either of them one behind.
     *
     * @param {FeedbackItem} item
     * @param {{liked: boolean, like_count: number}} settled
     */
    static applyLike(item, settled) {
      if (!item || !settled) return;
      item.viewer_liked = !!settled.liked;
      item.like_count = Math.max(0, settled.like_count || 0);
    }
  }

  window.Feedback = Feedback;
})();
