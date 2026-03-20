'use strict';

// ── In-memory TTL cache for DayWordPlay ───────────────────────────────────────
// Cache types: 'today', 'yesterday', 'leaderboard'
// Keys are stored as "type:groupId" (or just "type" for global entries).
// The cache lives only for the page session — a page refresh clears everything.
// Call dwpCache.clear() on logout to prevent stale data across user switches.

var dwpCache = {
  _store: {},
  TTL_MS: 10 * 60 * 1000, // 10 minutes

  _key: function(type, groupId) {
    return groupId ? type + ':' + groupId : type;
  },

  get: function(type, groupId) {
    const entry = this._store[this._key(type, groupId)];
    if (!entry) return null;
    if (Date.now() - entry.ts > this.TTL_MS) {
      delete this._store[this._key(type, groupId)];
      return null;
    }
    return entry.data;
  },

  set: function(type, groupId, data) {
    if (data === null || data === undefined) {
      delete this._store[this._key(type, groupId)];
      return;
    }
    this._store[this._key(type, groupId)] = { data: data, ts: Date.now() };
  },

  clear: function() {
    this._store = {};
  },

  // Merge fresh vote counts into cached yesterday data for a group.
  // Resets the TTL since data just came from the server.
  // Returns true if the entry existed, false if not.
  updateVoteCounts: function(groupId, voteCounts, hasVoted) {
    const key = this._key('yesterday', groupId);
    const entry = this._store[key];
    if (!entry) return false;

    const countMap = {};
    const iVotedMap = {};
    for (let i = 0; i < voteCounts.length; i++) {
      const vc = voteCounts[i];
      countMap[vc.sentence_id] = vc.vote_count;
      iVotedMap[vc.sentence_id] = vc.i_voted;
    }

    const sentences = entry.data.sentences || [];
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (s.id in countMap) {
        s.vote_count = countMap[s.id];
        s.i_voted = iVotedMap[s.id];
      }
    }
    // Re-sort by vote count descending
    sentences.sort(function(a, b) { return b.vote_count - a.vote_count; });

    entry.data.has_voted = hasVoted;
    entry.ts = Date.now(); // refresh TTL
    return true;
  },

  // Optimistic in-place update after user casts a vote (no server round-trip).
  // Returns the mutated data object, or null if the cache entry doesn't exist.
  patchVoteOptimistic: function(groupId, sentenceId) {
    const key = this._key('yesterday', groupId);
    const entry = this._store[key];
    if (!entry) return null;

    const sentences = entry.data.sentences || [];
    for (let i = 0; i < sentences.length; i++) {
      if (sentences[i].id === sentenceId) {
        sentences[i].vote_count += 1;
        sentences[i].i_voted = true;
        break;
      }
    }
    // Re-sort by vote count descending
    sentences.sort(function(a, b) { return b.vote_count - a.vote_count; });

    entry.data.has_voted = true;
    return entry.data;
  },
};
