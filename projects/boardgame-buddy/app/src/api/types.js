// @ts-check
// JSDoc type contracts for the high-traffic API shapes (typed-js rule).
// Sourced from shared-backend/routes/boardgame_buddy/models.py. Editor-only —
// nothing here ships at runtime beyond the empty export.

/**
 * @typedef {Object} GameSummary
 * @property {string} id
 * @property {number|null} bgg_id
 * @property {string} name
 * @property {number|null} year_published
 * @property {number|null} min_players
 * @property {number|null} max_players
 * @property {number|null} playing_time
 * @property {string|null} thumbnail_url
 * @property {string|null} image_url
 * @property {string|null} theme_color
 * @property {boolean} is_expansion
 * @property {number|null} base_game_bgg_id
 * @property {string|null} expansion_color
 * @property {string|null} play_mode  // 'competitive' | 'cooperative' | 'team'
 */

/**
 * @typedef {Object} PlayPlayer
 * @property {string|null} player_user_id
 * @property {string} player_display_name
 * @property {boolean} is_winner
 * @property {number|null} score
 * @property {number[]|null} round_scores
 */

/**
 * @typedef {Object} Play
 * @property {string} id
 * @property {string} user_id
 * @property {string} game_id
 * @property {string} played_at   // date
 * @property {string|null} notes
 * @property {string|null} photo_url
 * @property {string|null} play_mode
 * @property {string|null} game_name
 * @property {string|null} game_thumbnail_url
 * @property {string|null} game_image_url
 * @property {PlayPlayer[]} players
 * @property {GameSummary[]} [expansions]
 */

/**
 * @typedef {Object} FeedPage
 * @property {Array<Object>} cards  // heterogeneous: play cards + rail cards
 * @property {string|null} next_cursor
 */

/**
 * @typedef {Object} Profile
 * @property {string} id
 * @property {string} display_name
 * @property {string} username
 * @property {Object|null} avatar
 * @property {boolean} is_admin
 */

/**
 * @typedef {Object} CollectionItem
 * @property {string} id
 * @property {string} game_id
 * @property {'owned'|'wishlist'} status
 * @property {string} added_at
 * @property {string|null} game_name
 * @property {string|null} game_thumbnail_url
 * @property {number|null} game_year_published
 * @property {number|null} game_min_players
 * @property {number|null} game_max_players
 * @property {number|null} game_playing_time
 * @property {boolean|null} game_is_expansion
 * @property {number|null} game_base_game_bgg_id
 * @property {string|null} game_expansion_color
 * @property {string|null} game_play_mode
 * @property {number|null} game_bgg_id
 * @property {string|null} game_theme_color
 */

/**
 * @typedef {Object} SessionParticipant
 * @property {string} id
 * @property {string|null} user_id
 * @property {string} display_name
 * @property {string} joined_at
 */

/**
 * @typedef {Object} SessionState
 * @property {string} id
 * @property {string} code
 * @property {string} host_user_id
 * @property {string|null} game_id
 * @property {'open'|'finalized'|'abandoned'} status
 * @property {'gather'|'play'|'settle'|'finalized'|'abandoned'} phase
 * @property {string|null} finalized_play_id
 * @property {SessionParticipant[]} participants
 * @property {GameSummary|null} [game]
 */

/**
 * @typedef {Object} Chapter
 * @property {string} id
 * @property {string} game_id
 * @property {string} chapter_type
 * @property {string} title
 * @property {string} content
 * @property {string} created_by
 * @property {number} [popularity]
 */

/**
 * @typedef {Object} BggSyncStatus
 * @property {string|null} bgg_username
 * @property {'unlinked'|'linked'|'relink_required'} auth_state
 * @property {number} pending_count      lifetime pending-import rows
 * @property {number} errored_count
 * @property {string|null} last_completed_at
 * @property {string|null} session_started_at
 * @property {number} session_total      distinct BGG ids this sync session
 * @property {number} session_done
 * @property {number} session_errored
 * @property {string[]} session_game_names
 */

export {};
