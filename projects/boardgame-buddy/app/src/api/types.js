// @ts-check
// JSDoc type contracts for the high-traffic API shapes (typed-js rule).
// Sourced from shared-backend/routes/boardgame_buddy/models.py. Editor-only —
// nothing here ships at runtime beyond the empty export.
//
// These are the response shapes, field-for-field. When a typedef and the
// Pydantic model disagree, the typedef is what misleads the next reader into
// writing a field read that always yields undefined — so correct it here in
// the same change that touches the endpoint.

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
 * @property {string|null} rulebook_url
 * @property {import('../domain/playMode').PlayModeValue} play_mode
 * @property {string|null} bgg_url  computed from bgg_id
 * @property {number} expansion_count
 *   Expansions the CATALOG holds for this base game (not the viewer's owned
 *   ones). Attached only by the list endpoints that call
 *   _attach_expansion_counts — /collection/grid and the two browse endpoints
 *   in game_routes — so treat 0 as "not computed" rather than "none".
 */

/**
 * @typedef {Object} PlayPlayer
 *   PlayPlayerResponse. Note `user_id`/`name`, NOT player_user_id /
 *   player_display_name — those are the play_players COLUMN names, and they
 *   don't reach the client.
 * @property {string|null} user_id  null for ghost players
 * @property {string} name
 * @property {Object|null} avatar
 * @property {boolean} is_winner
 * @property {number|null} score
 * @property {Array<number|null>|null} round_scores  null for ≤1-round plays
 */

/**
 * @typedef {Object} Play
 *   PlayResponse. There is no game_image_url here — the column was dropped;
 *   only the feed cards (from bgb_feed_plays) carry one, via the games join.
 * @property {string} id
 * @property {string} game_id
 * @property {string} game_name
 * @property {string|null} game_thumbnail
 * @property {string} played_at   // date
 * @property {string|null} notes
 * @property {PlayPlayer[]} players
 * @property {string|null} photo_url
 * @property {GameSummary[]} expansions
 * @property {string} created_at
 * @property {import('../domain/playMode').PlayModeValue} play_mode
 * @property {string} logged_by_id
 * @property {string} logged_by_name
 * @property {boolean} is_own  false when the viewer appears via a linked buddy
 */

/**
 * @typedef {Object} FeedPage
 * @property {Array<Object>} cards  // heterogeneous: play cards + rail cards
 * @property {string|null} next_cursor  round-tripped back as ?cursor=
 */

/**
 * @typedef {Object} Profile
 * @property {string} id
 * @property {string} display_name
 * @property {string} username  stable handle; readonly in the FE
 * @property {Object|null} avatar
 * @property {boolean} is_admin
 * @property {boolean} needs_setup  cleared by the first successful POST /profile
 * @property {string} created_at
 */

/**
 * @typedef {Object} CollectionItem  one shelf row from GET /collection
 *   The game is NESTED, not flattened into game_* fields. (The
 *   boardgamebuddy_collections table does carry denormalized game_* columns,
 *   but this endpoint joins boardgamebuddy_games instead and never selects
 *   them — see collection_routes._TILE_GAME_FIELDS for exactly which columns
 *   come back populated.)
 * @property {string} id
 * @property {string} game_id
 * @property {'owned'|'wishlist'|'played'} status
 * @property {string} added_at
 * @property {string|null} last_played_at
 * @property {number} play_count
 * @property {GameSummary} game
 * @property {CollectionItem[]} expansions  owned expansions of this base game
 */

/**
 * @typedef {Object} SessionParticipant
 * @property {string} id
 * @property {string|null} user_id
 * @property {string} display_name
 * @property {string} joined_at
 * @property {Object|null} avatar
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
 * @property {GameSummary|null} game
 * @property {SessionParticipant[]} participants
 * @property {string} created_at
 * @property {string} expires_at
 */

/**
 * @typedef {Object} ExpansionListItem
 * @property {string} expansion_game_id
 * @property {number|null} bgg_id
 * @property {string} name
 * @property {string|null} thumbnail_url
 * @property {string|null} color
 * @property {boolean} is_enabled
 * @property {string|null} rulebook_url
 */

/**
 * @typedef {Object} BggExpansionCandidate
 *   An expansion BGG links to a base game that isn't in the catalog yet.
 * @property {number} bgg_id
 * @property {string} name       base game's name stripped off the front
 * @property {string} full_name  BGG's original string
 * @property {string} bgg_url
 */

/**
 * @typedef {Object} Chapter  ChapterResponse; pool rows add `popularity`
 * @property {string} id
 * @property {string} game_id
 * @property {string} chapter_type
 * @property {string|null} chapter_type_label
 * @property {string|null} chapter_type_icon
 * @property {number} chapter_type_order
 * @property {string} title
 * @property {string} layout
 * @property {string} content
 * @property {string|null} created_by
 * @property {string|null} created_by_name
 * @property {string} updated_at
 * @property {string|null} source_game_id   set when a response mixes base + expansion chapters
 * @property {string|null} source_game_name
 * @property {string|null} source_color     null for base games
 * @property {number} [popularity]          pool rows only
 */

/**
 * @typedef {Object} BootstrapPayload  GET /bootstrap
 * @property {number} bootstrap_version  mismatch with EXPECTED → wipe caches
 * @property {Object|null} current_user
 * @property {Object|null} profile_bundle  { status_map, stats }
 * @property {FeedPage|null} feed_first_page
 * @property {string|null} feed_cursor
 * @property {GameSummary[]} recently_played_games
 * @property {{accounts: any[], ghosts: any[], recent: any[]}} play_partners
 * @property {Object} game_detail_bundles  always {} since v2 — see below
 */

/**
 * @typedef {Object} GameBundlesResponse  GET /bootstrap/game-bundles
 * @property {Object<string, any>} game_detail_bundles  gameId -> bundle
 * @property {number} owned_count
 * @property {boolean} truncated  viewer owns more base games than the cap
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
