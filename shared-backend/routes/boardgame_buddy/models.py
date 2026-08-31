"""Pydantic models for BoardgameBuddy."""

from datetime import date, datetime
from typing import Any, Literal, Optional, Union
from pydantic import (
    UUID4,
    BaseModel,
    Field,
    SecretStr,
    computed_field,
    model_validator,
)

from .constants import (
    BggAuthState,
    CollectionStatus,
    FeedCardKind,
    PlayMode,
    PlaySessionStatus,
    SessionPhase,
)


# ── Shared ────────────────────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    project: str
    status: str


class MessageResponse(BaseModel):
    message: str


class RefreshImagesResponse(BaseModel):
    updated: int


# ── Profile ───────────────────────────────────────────────────────────────────

class Avatar(BaseModel):
    """Customizable badge config (migration 029).

    `icon` is either "initials" or a key from the client-side icon library
    (meeple, die, sword, ...). `iconColor` and `bgColor` are hex strings.
    A profile with avatar=None renders the BGB default badge client-side.
    """
    icon: str = "initials"
    iconColor: str = "#C9922A"
    bgColor: str = "#2a1812"


class ProfileCreate(BaseModel):
    # Both optional so settings can save name and avatar independently.
    display_name: Optional[str] = None
    avatar: Optional[Avatar] = None


class ProfileResponse(BaseModel):
    id: str
    display_name: str
    # Stable handle (migration 017). Readonly in the FE; search matches it.
    username: str
    avatar: Optional[Avatar] = None
    is_admin: bool = False
    # TRUE for brand-new accounts that have not yet completed the
    # "Create your profile" modal (migration 030). Cleared by the first
    # successful POST /profile.
    needs_setup: bool = False
    created_at: datetime


class AdminKeyBody(BaseModel):
    admin_key: str


# ── BGG account linking ───────────────────────────────────────────────────────

class BggLinkBody(BaseModel):
    """Credentials for POST /bgg/link.

    BGG requires the *web* login flow (username + password) to mint a SessionID
    cookie; we exchange the password at link time, store it Fernet-encrypted,
    and use the resulting cookies on subsequent xmlapi2 calls.
    """
    username: str = Field(..., min_length=1, max_length=64)
    password: SecretStr = Field(..., min_length=1, max_length=256)


class BggLinkResponse(BaseModel):
    bgg_username: Optional[str] = None


class BggSyncSummary(BaseModel):
    """Result of POST /bgg/sync.

    Counts that landed in their respective tables synchronously plus the
    pending counts that the background worker will drain after importing
    the missing games from BGG.
    """
    bgg_username: str
    collection_imported: int
    collection_pending: int
    plays_imported: int
    plays_pending: int
    # Count of distinct BGG game ids queued by this sync (one BGG /thing call
    # per id). Drives the "Importing X of Y" progress bar. Distinct from
    # collection_pending + plays_pending, which double-count a single game
    # that needs both a collection row and a play row.
    unique_games_to_import: int = 0
    # True when BGG kept returning "still preparing" for every batch and the
    # sync ended up with nothing to import. The FE shows a "try again shortly"
    # toast instead of "Imported 0".
    warm_up_retry_pending: bool = False


class BggSyncStatus(BaseModel):
    """Result of GET /bgg/sync/status. Used by the FE to poll progress."""
    bgg_username: Optional[str] = None
    auth_state: BggAuthState = BggAuthState.UNLINKED
    # Lifetime row counters in boardgamebuddy_bgg_pending_imports. Kept for
    # back-compat with the existing settings header copy.
    pending_count: int = 0
    errored_count: int = 0
    last_completed_at: Optional[datetime] = None
    # Session-scoped progress, anchored by profiles.bgg_last_sync_started_at.
    # Counted in distinct BGG game ids so the "X of Y" number matches the
    # number of /thing calls the worker actually makes.
    session_started_at: Optional[datetime] = None
    session_total: int = 0
    session_done: int = 0
    session_errored: int = 0
    # Display names for games that this sync session has imported (i.e.,
    # pending rows whose status is now `done`). Ordered by most recently
    # completed first and capped at 20 so the FE can stream a per-game log
    # without polling a separate endpoint. Empty until at least one
    # previously-unknown game has been fetched from BGG.
    session_game_names: list[str] = []


# ── Games ─────────────────────────────────────────────────────────────────────

class GameSummary(BaseModel):
    id: str
    bgg_id: Optional[int] = None
    name: str
    year_published: Optional[int] = None
    min_players: Optional[int] = None
    max_players: Optional[int] = None
    playing_time: Optional[int] = None
    thumbnail_url: Optional[str] = None
    image_url: Optional[str] = None
    theme_color: Optional[str] = None
    is_expansion: bool = False
    base_game_bgg_id: Optional[int] = None
    expansion_color: Optional[str] = None
    rulebook_url: Optional[str] = None
    play_mode: PlayMode = PlayMode.COMPETITIVE
    # Number of expansion rows in boardgamebuddy_games that point at this
    # game (via base_game_bgg_id == this.bgg_id). Populated by the list
    # endpoints so browse/search tiles can show a "git-fork N" badge.
    # Defaults to 0 for callers that don't bother computing it.
    expansion_count: int = 0

    @computed_field  # type: ignore[misc]
    @property
    def bgg_url(self) -> Optional[str]:
        return f"https://boardgamegeek.com/boardgame/{self.bgg_id}" if self.bgg_id else None


class GameDetail(GameSummary):
    description: Optional[str] = None
    categories: list[str] = []
    mechanics: list[str] = []
    created_at: datetime
    # Populated on expansion rows so the FE can render a "Back to <base>" link
    # without a second lookup. Resolved via base_game_bgg_id at read time.
    base_game_id: Optional[str] = None
    base_game_name: Optional[str] = None


class GameListResponse(BaseModel):
    games: list[GameSummary]
    total: int
    page: int
    per_page: int


class BggSearchResult(BaseModel):
    bgg_id: int
    name: str
    year_published: Optional[int] = None
    is_expansion: bool = False
    already_in_db: bool = False

    @computed_field  # type: ignore[misc]
    @property
    def bgg_url(self) -> str:
        return f"https://boardgamegeek.com/boardgame/{self.bgg_id}"


class BggExpansionCandidate(BaseModel):
    """One expansion BGG links to a base game that BgB hasn't imported yet.

    `name` has the base game's name stripped off the front ("Catan: Cities &
    Knights" → "Cities & Knights") so the import popup reads as a list of
    expansions rather than a column of repeated base-game names. `full_name`
    keeps BGG's original string for the row's title attribute.
    """

    bgg_id: int
    name: str
    full_name: str
    bgg_owned: Optional[int] = Field(
        None,
        description=(
            "How many BoardGameGeek users own this expansion — the popup's sort key. "
            "None when BGG's stats lookup failed or was skipped, in which case the "
            "row shows no count and the list falls back to alphabetical order."
        ),
    )

    @computed_field  # type: ignore[misc]
    @property
    def bgg_url(self) -> str:
        return f"https://boardgamegeek.com/boardgame/{self.bgg_id}"


# ── Collection ────────────────────────────────────────────────────────────────

class CollectionAdd(BaseModel):
    game_id: str
    status: CollectionStatus


class CollectionUpdate(BaseModel):
    status: CollectionStatus


class CollectionPlayedBefore(BaseModel):
    """Hand-mark an owned game as played before the user joined BoardgameBuddy.

    Deliberately NOT a CollectionStatus value: migration 010 removed 'played'
    from the status CHECK because played-ness is derived from
    boardgamebuddy_plays everywhere else. This is a separate, narrower claim —
    it clears the game off the Shelf of Shame and touches nothing else.
    """

    played_before: bool


class CollectionItem(BaseModel):
    id: str
    game_id: str
    status: str
    added_at: datetime
    last_played_at: Optional[date] = None
    play_count: int = 0
    game: GameSummary
    # Always empty today: both branches of bgb_collection_shelf hard-code
    # 'expansions', '[]'::jsonb, and /collection/grid never sets it either.
    # The web client asks for the flat shelf with expansions included
    # (exclude_expansions=false) and nests them itself, in
    # web/domain/expansion-tree.js — nesting in SQL would silently drop the
    # two cases that grouping surfaces: an owned expansion whose base game the
    # viewer doesn't own, and one whose denormalized base_game_bgg_id is null.
    # Kept on the wire because the native app reads this shape.
    expansions: list["CollectionItem"] = Field(default_factory=list)


CollectionItem.model_rebuild()


class CollectionPageResponse(BaseModel):
    items: list[CollectionItem]
    total: int
    page: int
    per_page: int


class CollectionStatusMapResponse(BaseModel):
    """The two small dicts the web client actually needs from a collection read.

    GET /collection returns every row with its game embedded, which cost three
    unbounded round trips to produce; the only consumer read four fields off it
    and discarded the rest. This is that consumer's actual contract.
    """

    # game_id (UUID string) -> "owned" | "wishlist" | "played"
    status_map: dict[str, str] = Field(default_factory=dict)
    # base game's bgg_id (as a string key) -> count of expansions the viewer owns
    expansion_counts: dict[str, int] = Field(default_factory=dict)


class CollectionShelfResponse(BaseModel):
    """A whole collection shelf in one response, for client-side paging.

    Deliberately carries no page/per_page/search/filter fields: the client
    caches one entry per (target, status) and derives every page, filter and
    search from it locally. Adding a filter parameter here would multiply the
    cache keys and defeat the point — /collection/grid remains the paginated,
    server-filtered endpoint for callers that need one.
    """

    items: list[CollectionItem]
    total: int
    # True when the shelf is larger than the requested limit, so `items` is a
    # prefix rather than the whole shelf. The web client falls back to the
    # server-side grid for search/filter when this is set, rather than
    # silently searching a truncated list.
    truncated: bool = False
    generated_at: datetime


# ── Plays ─────────────────────────────────────────────────────────────────────

class PlayerEntry(BaseModel):
    name: str
    is_winner: bool = False
    score: Optional[int] = None
    # Real-account player id. Populated when the FE picks this player from
    # the user's accepted-buddy list; None for free-text ghost players.
    # Backend uses it to populate play_players.player_user_id (migration 009)
    # so the new feed RPC can resolve the winner's display name.
    user_id: Optional[str] = None
    # Per-round score breakdown (migration 028). Only sent when more than
    # one round was tracked — the FE drops it for ≤1-round plays so the
    # column stays NULL for the simple-score path.
    round_scores: Optional[list[Optional[int]]] = None

    @model_validator(mode="after")
    def _score_matches_rounds(self) -> "PlayerEntry":
        """When a round breakdown is present, `score` IS its sum.

        A play whose total disagrees with the rounds printed underneath it is
        the single most confidence-destroying thing this app can show, and the
        client is not the place to guarantee it: a dropped realtime write, a
        column left at a stale length, or an older build all used to land a
        total that its own round_scores didn't add up to. Every write path
        (POST /plays, PATCH /plays/{id} and the lobby finalize, which dumps
        this model into the RPC payload) goes through here, so the invariant
        holds for all of them. Rounds that came in NULL count as zero — that's
        a round nobody scored in, which is what the grid shows too.
        """
        if self.round_scores:
            self.score = sum(v or 0 for v in self.round_scores)
        return self


class PlayExpansionRef(BaseModel):
    expansion_game_id: str
    name: str
    color: Optional[str] = None


class PlayCreate(BaseModel):
    game_id: str
    played_at: date
    players: list[PlayerEntry] = []
    notes: Optional[str] = None
    photo_url: Optional[str] = None
    expansion_ids: list[str] = []
    # Optional per-play scoring style override (migration 007). When None,
    # the play inherits the game's stored play_mode at insert time.
    play_mode: Optional[PlayMode] = None
    # Idempotency key for offline-queued plays (migration 048). The web app's
    # outbox stamps one UUID per queued play and re-sends it on every flush
    # attempt, so a retry after a lost response returns the original play
    # instead of writing a duplicate. Omitted by live writes, where two
    # identical POSTs legitimately mean two plays.
    client_key: Optional[UUID4] = None


class PlayUpdate(BaseModel):
    # Full replacement of the play. Mirrors PlayCreate but game_id can't change
    # — pivoting a play to a different game would orphan the per-player scores.
    played_at: date
    players: list[PlayerEntry] = []
    notes: Optional[str] = None
    photo_url: Optional[str] = None
    expansion_ids: list[str] = []
    play_mode: Optional[PlayMode] = None


class PlayPhotoResponse(BaseModel):
    photo_url: str


class PlayPhotoAttach(BaseModel):
    """Body for PATCH /plays/{id}/photo — the one field, on its own.

    Attaching a photo used to go through PlayUpdate, which is a *full
    replacement*: it deletes and re-inserts every player and expansion row
    to write one column. PlayUpdate can't express a partial edit (played_at
    is required and players defaults to []), hence this dedicated model.
    """
    photo_url: str = Field(..., min_length=1)


class PlayPlayerResponse(BaseModel):
    user_id: Optional[str] = None
    name: str
    # Linked-account avatar config (migration 029). NULL for ghost players
    # (player_user_id IS NULL) and for accounts that haven't customized
    # their badge — the FE renders the BGB default in both cases.
    avatar: Optional[Avatar] = None
    is_winner: bool
    score: Optional[int] = None
    # Per-round score breakdown (migration 028). NULL for legacy plays
    # and for any play with ≤1 rounds — the FE only persists the array
    # when there were multiple rounds.
    round_scores: Optional[list[Optional[int]]] = None


class PlayResponse(BaseModel):
    id: str
    game_id: str
    game_name: str
    game_thumbnail: Optional[str] = None
    played_at: date
    notes: Optional[str] = None
    players: list[PlayPlayerResponse] = []
    photo_url: Optional[str] = None
    expansions: list[PlayExpansionRef] = []
    created_at: datetime
    # Resolved scoring style for this play. Set from PlayCreate.play_mode if
    # provided, else inherited from the game at insert time. Always populated.
    play_mode: PlayMode = PlayMode.COMPETITIVE
    # Logger metadata — lets the FE distinguish own logs from shared plays
    # (where the current user appears via a linked buddy).
    logged_by_id: str
    logged_by_name: str
    is_own: bool = True




class PlayListResponse(BaseModel):
    plays: list[PlayResponse]
    total: int
    page: int
    per_page: int






# ── Buddies ───────────────────────────────────────────────────────────────────

class ProfileSearchResult(BaseModel):
    id: str
    display_name: str
    username: str
    email: Optional[str] = None
    avatar: Optional[Avatar] = None


# ── Reference-guide chapters ──────────────────────────────────────────────────

class ChapterTypeResponse(BaseModel):
    id: str
    label: str
    icon: Optional[str] = None
    display_order: int


class ChapterCreate(BaseModel):
    chapter_type: str
    title: str
    content: str
    layout: str = "text"


class ChapterGenerateRequest(BaseModel):
    """Ask the AI to draft a chapter of this type for the game in the path."""

    chapter_type: str


class ChapterGenerateResponse(BaseModel):
    """A draft only — the editor fills its form with this and the user reviews,
    edits, and saves. Nothing is persisted by the generate call itself."""

    chapter_type: str
    title: str
    content: str


class ChapterUpdate(BaseModel):
    chapter_type: Optional[str] = None
    title: Optional[str] = None
    content: Optional[str] = None
    layout: Optional[str] = None


class ChapterResponse(BaseModel):
    id: str
    game_id: str
    chapter_type: str
    chapter_type_label: Optional[str] = None
    chapter_type_icon: Optional[str] = None
    chapter_type_order: int = 0
    title: str
    layout: str
    content: str
    created_by: Optional[str] = None
    created_by_name: Optional[str] = None
    updated_at: datetime
    # Source-game tagging — populated whenever the response might mix chapters
    # from multiple games (base + expansions). Always equals (game_id, game
    # name, expansion_color) for the chapter's defining game; source_color is
    # None for base games and the boardgamebuddy_games.expansion_color for
    # expansion rows.
    source_game_id: Optional[str] = None
    source_game_name: Optional[str] = None
    source_color: Optional[str] = None


class ChapterPoolItem(ChapterResponse):
    # Number of users who have this chapter in their guide. Browse pool
    # rows are sorted by `popularity DESC, created_at DESC`.
    popularity: int = 0
    # Whether the calling user already has this chapter in their guide.
    # Frontend hides rows where this is true. Anon callers always see
    # `in_my_guide=false`.
    in_my_guide: bool = False


class MyGuideChapterResponse(ChapterResponse):
    added_at: datetime


class AddChapterRequest(BaseModel):
    chapter_id: str


class ChapterReportCreate(BaseModel):
    reason: Optional[str] = Field(None, max_length=500)


class ChapterReportResponse(BaseModel):
    id: str
    chapter_id: str
    chapter_title: str
    chapter_content_preview: str
    chapter_type: str
    chapter_type_label: Optional[str] = None
    game_id: str
    game_name: str
    reporter_id: str
    reporter_name: Optional[str] = None
    reason: Optional[str] = None
    status: str
    created_at: datetime
    resolved_at: Optional[datetime] = None


# ── Expansions ────────────────────────────────────────────────────────────────

class ExpansionListItem(BaseModel):
    expansion_game_id: str
    bgg_id: Optional[int] = None
    name: str
    thumbnail_url: Optional[str] = None
    # Full-size box art. The expansion reel crops its polaroids at 132x110,
    # which upscales BGG's ~200px thumbnail; the web client prefers this and
    # falls back to thumbnail_url when a game has no re-hosted image.
    image_url: Optional[str] = None
    color: Optional[str] = None
    is_enabled: bool = False
    rulebook_url: Optional[str] = None
    # Which base game this expansion extends. Only the catalog endpoint sets
    # it — /games/{id}/expansions is already scoped to one base game, so there
    # it would be the same value on every row.
    base_game_bgg_id: Optional[int] = None


class ExpansionCatalogResponse(BaseModel):
    """Every catalog expansion for every base game the viewer owns.

    Backs the Expansions tree's "show all" toggle. One response rather than a
    per-base-game call: a shelf of 40 games would otherwise be 40 requests to
    render one screen.

    `owned` is deliberately absent — the caller is the Collection spoke, which
    already knows its own shelf and marks the rows itself.
    """

    items: list[ExpansionListItem]


class ExpansionToggleRequest(BaseModel):
    is_enabled: bool




class RulebookUrlUpdate(BaseModel):
    """Admin override to set or clear a game's rulebook_url. Pass null to clear."""

    rulebook_url: Optional[str] = None


# ── Mutual buddy graph (migration 008) ────────────────────────────────────────

class BuddyEdgeResponse(BaseModel):
    """An accepted buddy edge from the current user's perspective."""

    id: str
    other_user_id: str
    other_display_name: str
    other_username: Optional[str] = None
    other_avatar: Optional[Avatar] = None
    accepted_at: Optional[datetime] = None
    created_at: datetime


class BuddyRequestResponse(BaseModel):
    """A pending buddy request, either incoming or outgoing."""

    id: str
    direction: Literal["incoming", "outgoing"]
    other_user_id: str
    other_display_name: str
    other_avatar: Optional[Avatar] = None
    created_at: datetime


class BuddyRequestsResponse(BaseModel):
    incoming: list[BuddyRequestResponse] = []
    outgoing: list[BuddyRequestResponse] = []


class BuddyRequestCreate(BaseModel):
    target_user_id: str


# ── Add a buddy by QR code ────────────────────────────────────────────────────

class BuddyQrTokenResponse(BaseModel):
    """A short-lived signed token the caller's QR encodes. Nothing is persisted.

    The frontend composes the scannable payload as `{origin}/b/{token}` — the
    backend deliberately does not, since it cannot know which origin (localhost,
    Vercel) the client is served from.
    """

    token: str
    expires_at: datetime
    ttl_seconds: int


class BuddyQrAddRequest(BaseModel):
    token: str


class BuddyQrAddResponse(BaseModel):
    """The resulting accepted edge, plus whether this scan is what created it."""

    edge: BuddyEdgeResponse
    created: bool


# ── Played-with discovery (real accounts + ghost players) ─────────────────────

class PlayedWithUser(BaseModel):
    """A real-account player who appears in plays the viewer is part of."""

    user_id: str
    display_name: str
    avatar: Optional[Avatar] = None
    play_count: int
    is_buddy: bool = False
    has_pending_request: bool = False
    pending_request_direction: Optional[Literal["incoming", "outgoing"]] = None
    # Edge id of the pending request, so the row can offer Cancel (outgoing) or
    # Accept (incoming) without a second /buddies/requests round trip.
    pending_request_id: Optional[str] = None


class GhostPlayer(BaseModel):
    """A free-text nickname the viewer recorded in plays without an account."""

    display_name: str
    play_count: int
    last_played_at: Optional[date] = None


class PlayPartnersResponse(BaseModel):
    """Everything the Gather player picker needs, in one payload.

    Mirrors the shape Buddy.allBuddies() caches on the FE and the
    `play_partners` block of /bootstrap, so all three read the same thing.
    """

    accounts: list[BuddyEdgeResponse] = []
    ghosts: list[GhostPlayer] = []
    recent: list[PlayedWithUser] = []


class GhostLinkRequest(BaseModel):
    """Promote a ghost nickname to a real account across the viewer's plays."""

    display_name: str
    target_user_id: str


class GhostLinkResponse(BaseModel):
    rows_updated: int


class GhostMergeRequest(BaseModel):
    """Rename one ghost nickname to another across the viewer's plays.

    Used when the same friend was logged under slightly different
    spellings ("Dave" and "Dave Smith") and the user wants to collapse
    them into a single ghost.
    """

    source_display_name: str
    target_display_name: str


class GhostMergeResponse(BaseModel):
    rows_updated: int


class PlayLeaveResponse(BaseModel):
    """Result of a player self-removing from a play (turning their row into a
    ghost). rows_updated is 1 on success, 0 if the caller wasn't a player."""

    rows_updated: int


# ── Public profile view (Strava-style) ────────────────────────────────────────

class PublicProfileResponse(BaseModel):
    """Always 200 — profiles are fully public per product decision."""

    id: str
    display_name: str
    username: str
    avatar: Optional[Avatar] = None
    created_at: datetime
    # Whether the viewer has an accepted mutual edge with this profile. The FE
    # uses this to swap the "Add buddy" button for an "Unfriend" affordance.
    is_buddy: bool = False
    # Whether a pending request exists in either direction. FE shows
    # "Request sent" / "Accept request" instead of "Add buddy".
    has_pending_request: bool = False
    pending_request_direction: Optional[Literal["incoming", "outgoing"]] = None
    # Edge id of that pending request. The relation button needs it to cancel
    # an outgoing request (or accept an incoming one) in place.
    pending_request_id: Optional[str] = None


class FavoriteGame(BaseModel):
    """The game the viewer has played the most. None when no plays exist."""

    game_id: str
    name: str
    play_count: int


class StatsResponse(BaseModel):
    total_plays: int = 0
    unique_games: int = 0
    win_count: int = 0
    last_played_at: Optional[date] = None
    hours_played: float = 0.0
    # owned_games excludes expansions — the count the user thinks of as
    # "my games". owned_expansions is the secondary counter for box clutter.
    owned_games: int = 0
    owned_expansions: int = 0
    favorite_game: Optional[FavoriteGame] = None


# ── Play sessions (short-code lobby) ──────────────────────────────────────────

class SessionParticipantResponse(BaseModel):
    id: str
    user_id: Optional[str] = None
    display_name: str
    joined_at: datetime
    avatar: Optional[Avatar] = None


class SessionScoreRow(BaseModel):
    """One cell of the live grid, keyed by roster row (migration 053)."""

    participant_id: str
    round_index: int
    score: Optional[int] = None


class SessionResponse(BaseModel):
    id: str
    code: str
    status: PlaySessionStatus
    # Host-driven cursor through the Gather → Play → Settle Up flow
    # (migration 026). Defaults to gather for legacy rows that pre-date
    # the column.
    phase: SessionPhase = SessionPhase.GATHER
    host_user_id: str
    game_id: Optional[str] = None
    game: Optional[GameSummary] = None
    participants: list[SessionParticipantResponse] = []
    # Live grid snapshot, populated only while phase='play' (migration 054).
    # A spectator who joined after Gather has no participant row, so the
    # scores table's RLS SELECT policy returns them nothing and Realtime is
    # silent for them; this is how their mirror gets the host's scores. Empty
    # (never absent) in every other phase.
    scores: list[SessionScoreRow] = []
    created_at: datetime
    expires_at: datetime
    finalized_play_id: Optional[str] = None


class SessionCreate(BaseModel):
    game_id: Optional[str] = None


class SessionUpdateBody(BaseModel):
    # Currently the only field a host may change on an open lobby. Sent as
    # null when clearing the pick, set to a game UUID when (re)selecting one.
    game_id: Optional[str] = None


class SessionPhaseUpdate(BaseModel):
    phase: SessionPhase


class SessionJoinBody(BaseModel):
    # Used only when the caller is not authenticated (guest join). When a real
    # user joins, the display_name is taken from their profile and this field
    # is ignored.
    display_name: Optional[str] = None


class SessionAddParticipantBody(BaseModel):
    # Host-only "add to lobby" body. Pass user_id when adding a real-account
    # buddy; leave it null when adding a ghost (name-only) player. display_name
    # is required either way — for accounts it's the live display name as the
    # host knows them (idempotent dedup matches on user_id, not name).
    user_id: Optional[str] = None
    display_name: str


class SessionReorderParticipantsBody(BaseModel):
    """Host-only "set the roster order" body: the full ordered list of
    participant ids, front to back — the order the host's Gather list is in,
    which is the order the scoring grid's columns appear in on every surface.

    Ids this session doesn't own are ignored. Participants the list omits — a
    joiner who arrived between the host's drag and this write — are appended in
    joined_at order rather than dropped, so a race can't knock someone off the
    end of the grid.
    """

    participant_ids: list[str] = Field(default_factory=list, max_length=64)


class JoinableSession(BaseModel):
    """A session the calling user can join from the Join chooser screen.

    Surfaces any open in-progress session (phase ∈ gather/play/settle)
    where the viewer is either (a) the host of the session — useful for
    refresh recovery, (b) already listed as a participant — rejoin after
    a disconnect, or (c) the host is one of the viewer's accepted
    buddies. Gather sessions can be joined as a player; Play/Settle
    sessions are spectator-only. The FE branches on `phase`.
    """

    id: str
    code: str
    host_user_id: str
    host_display_name: str
    host_avatar: Optional[Avatar] = None
    game: Optional[GameSummary] = None
    phase: SessionPhase = SessionPhase.GATHER
    participant_count: int = 0
    is_participant: bool = False
    is_host_buddy: bool = False
    created_at: datetime


class JoinableSessionsResponse(BaseModel):
    sessions: list[JoinableSession] = []


# ── Unified search ────────────────────────────────────────────────────────────

class UnifiedSearchHit(BaseModel):
    """A single hit in the unified ranked search list."""

    source: Literal["collection", "db"]
    game: GameSummary
    # Present when source='collection': which shelf this game sits on for the
    # viewer ('owned' | 'wishlist'). None otherwise.
    collection_status: Optional[str] = None


class UnifiedSearchResponse(BaseModel):
    results: list[UnifiedSearchHit] = []
    # Always present; only populated when include_bgg=true was passed.
    bgg_results: list[BggSearchResult] = []
    # True when the caller passed include_bgg=true (regardless of whether BGG
    # actually returned anything). Lets the FE tell "BGG fetched but empty"
    # apart from "BGG not requested".
    bgg_searched: bool = False


# ── Feed cards ────────────────────────────────────────────────────────────────

class FeedPlayUser(BaseModel):
    id: str
    display_name: str
    avatar: Optional[Avatar] = None


class FeedPlayParticipant(BaseModel):
    user_id: str
    display_name: str


class FeedPlayCard(BaseModel):
    kind: Literal[FeedCardKind.PLAY] = FeedCardKind.PLAY
    play_id: str
    user: FeedPlayUser
    game: GameSummary
    played_at: date
    created_at: datetime
    notes: Optional[str] = None
    photo_url: Optional[str] = None
    play_mode: PlayMode = PlayMode.COMPETITIVE
    winner_display_name: Optional[str] = None
    participant_count: int = 0
    # Paired {user_id, display_name} list filtered to the viewer + their
    # accepted buddies (ghosts and non-buddy registered players excluded).
    # Drives the session grouping key on the FE and the clickable names in
    # the session header. Sorted by display_name in the RPC.
    participants: list[FeedPlayParticipant] = []


class FeedHotGamesEntry(BaseModel):
    game: GameSummary
    play_count: int


class FeedHotGamesCard(BaseModel):
    kind: Literal[FeedCardKind.HOT_GAMES] = FeedCardKind.HOT_GAMES
    window_days: int
    games: list[FeedHotGamesEntry]


class FeedSuggestedBuddy(BaseModel):
    user_id: str
    display_name: str
    avatar: Optional[Avatar] = None
    # Accepted buddies shared with the viewer, and plays shared with them.
    # A suggestion has at least one of the two; the rail labels whichever
    # it has. play_count is what ranks the rail — see migration 057.
    mutual_count: int
    play_count: int = 0


class FeedSuggestedBuddiesCard(BaseModel):
    kind: Literal[FeedCardKind.SUGGESTED_BUDDIES] = FeedCardKind.SUGGESTED_BUDDIES
    suggestions: list[FeedSuggestedBuddy]


FeedCard = Union[
    FeedPlayCard,
    FeedHotGamesCard,
    FeedSuggestedBuddiesCard,
]


class FeedPageResponse(BaseModel):
    cards: list[FeedCard]
    # Composite "played_at|created_at" of the last play on this page; null =
    # no more pages. The FE round-trips this string back as ?cursor=… on the
    # next call (no parsing required).
    next_cursor: Optional[str] = None


class HotGamesResponse(BaseModel):
    games: list[FeedHotGamesEntry] = []
    window_days: int


class SuggestedBuddiesResponse(BaseModel):
    suggestions: list[FeedSuggestedBuddy] = []


class GameBundlesResponse(BaseModel):
    """Deferred second stage of the boot warm-up.

    Split out of /bootstrap because building these is an N+1 in SQL (one
    bgb_game_detail_bundle per owned game) and nothing on the first screen
    reads them — only Game Detail does, and it falls back to its own fetch.
    """

    # game_id -> bgb_game_detail_bundle output. Free-form because the bundle is
    # composed in SQL and every consumer is the FE cache, which stores it whole.
    game_detail_bundles: dict[str, Any] = {}
    owned_count: int = 0
    # True when the viewer owns more base games than max_bundles; the overflow
    # falls back to Game Detail's own fetch.
    truncated: bool = False
