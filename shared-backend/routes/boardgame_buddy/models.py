"""Pydantic models for BoardgameBuddy."""

from datetime import date, datetime
from typing import Annotated, Any, Literal, Optional, Union
from pydantic import (
    UUID4,
    AfterValidator,
    BaseModel,
    Field,
    SecretStr,
    computed_field,
    model_validator,
)

from .constants import (
    IMPORT_CHUNK_MAX,
    MAX_IMPORT_CHARS,
    MAX_IMPORT_HINT_CHARS,
    MAX_IMPORT_IMAGES,
    BggAuthState,
    BggCheckPhase,
    BggCheckState,
    BggCheckStepState,
    BggPullChange,
    BggPushChange,
    BggUnpushableReason,
    BuddySuggestionSource,
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


def _normalize_country(value: str) -> str:
    """Upper-case an ISO 3166-1 alpha-2 code, or reject it.

    The DB CHECK (migration 065) is `^[A-Z]{2}$`, so a lowercase "de" from a
    client that read `navigator.language` verbatim would be a 500 at insert
    time rather than a 422. Normalizing here means the API's contract is
    case-insensitive while the column stays one canonical case — which is what
    lets a future `GROUP BY country_code` be a single bucket per country.

    Membership in the real ISO list is deliberately NOT checked: that list
    changes, it would need vendoring into the backend to enforce, and the
    clients pick from a fixed table anyway. Shape is what protects the column.
    """
    code = value.strip().upper()
    if len(code) != 2 or not code.isascii() or not code.isalpha():
        raise ValueError("country_code must be an ISO 3166-1 alpha-2 code")
    return code


# Two ASCII letters, stored upper-case. Used by every play write path.
CountryCode = Annotated[str, AfterValidator(_normalize_country)]


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
    # The catalog fill a POST /bgg/check kicked off, anchored separately on
    # profiles.bgg_last_check_started_at (migration 006). A check queues
    # kind='catalog' rows into the same table an import uses, so without their
    # own window they were counted as part of the last import — which made a
    # finished import read as unfinished, and made this poll exit instantly for
    # anyone who had never synced.
    catalog_session_started_at: Optional[datetime] = None
    catalog_session_total: int = 0
    catalog_session_done: int = 0
    catalog_session_errored: int = 0
    catalog_session_game_names: list[str] = []


class BggDiffItem(BaseModel):
    """One planned BgB -> BGG change, as one row of the comparison."""
    bgg_id: int
    game_id: Optional[str] = None          # None for a clear — no local row
    game_name: str
    thumbnail_url: Optional[str] = None
    change: BggPushChange
    local_status: Optional[CollectionStatus] = None    # None for a clear
    remote_status: Optional[CollectionStatus] = None   # None for an add
    # True when POST /bgg/check had to import this game into the catalog just
    # to be able to name it here. The FE tags those rows, because they are the
    # surprising ones: they are NOT on the BgB shelf, so the push clears them.
    newly_catalogued: bool = False


class BggPullItem(BaseModel):
    """The same comparison read the other way: what an import would do here."""
    bgg_id: int
    game_name: str
    change: BggPullChange
    local_status: Optional[CollectionStatus] = None
    remote_status: Optional[CollectionStatus] = None


class BggUnpushableItem(BaseModel):
    """A BgB row that cannot be represented on BoardGameGeek at all."""
    game_id: str
    game_name: str
    reason: BggUnpushableReason


class BggDiffResponse(BaseModel):
    """Result of POST /bgg/check — the comparison both sync buttons act on.

    Carries BOTH directions from one sweep: the push sheet and the pull sheet
    are the same data read opposite ways, and re-sweeping BGG for the second
    one would double a 12-second call for no new information.
    """
    bgg_username: str
    checked_at: datetime
    in_sync_count: int = 0
    local_total: int = 0
    remote_total: int = 0
    # Full counts even when the item lists are truncated for payload size.
    push_total: int = 0
    pull_total: int = 0
    push_changes: list[BggDiffItem] = []
    pull_changes: list[BggPullItem] = []
    unpushable: list[BggUnpushableItem] = []
    truncated: bool = False
    # Games queued for a catalog-only import by this check. The FE polls
    # /bgg/sync/status until these drain, then re-checks to get their names.
    catalog_pending: int = 0
    # At least one BGG batch gave up warming. The sweep is therefore partial,
    # and a partial sweep reads as "not on BGG" — so the push is refused
    # rather than allowed to clear flags off games it simply did not see.
    warm_up_retry_pending: bool = False


class BggCheckRetry(BaseModel):
    """A BGG warm-up backoff, in flight.

    `resume_at` is an absolute epoch second rather than a duration so the FE
    counts down against the moment the request actually resumes, instead of
    starting its own timer however long after the fact its poll happened to
    land.
    """
    attempt: int
    of: int
    wait_seconds: float
    resume_at: float


class BggCheckStep(BaseModel):
    """One row of the comparison checklist."""
    key: BggCheckPhase
    state: BggCheckStepState = BggCheckStepState.IDLE
    done: Optional[int] = None
    total: Optional[int] = None
    detail: Optional[str] = None
    retry: Optional[BggCheckRetry] = None


class BggCheckProgressResponse(BaseModel):
    """Result of GET /bgg/check/progress — what POST /bgg/check is doing now.

    `state = unknown` means we have no record, which is NOT the same as
    finished: the record lives in an in-process cache that a restart clears
    while the POST itself is still running. The FE renders unknown as "still
    working" and takes completion from the POST's own resolution.
    """
    state: BggCheckState = BggCheckState.UNKNOWN
    kind: Literal["check", "push_plan", "none"] = "none"
    check_id: Optional[str] = None
    started_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    steps: list[BggCheckStep] = []
    warm_up_failed: bool = False
    error: Optional[str] = None


class BggPushBody(BaseModel):
    """POST /bgg/push. `checked_at` echoes the comparison the user reviewed so
    the response can tell them if the plan moved underneath it."""
    checked_at: Optional[datetime] = None


class BggPushSummary(BaseModel):
    """Result of POST /bgg/push — what was queued, before the worker runs."""
    bgg_username: str
    queued: int = 0
    adds: int = 0
    updates: int = 0
    clears: int = 0
    unpushable: int = 0
    plan_changed: bool = False
    warm_up_retry_pending: bool = False


class BggPushError(BaseModel):
    """One game whose push failed, named so the user knows what is unresolved."""
    game_name: str
    message: str


class BggPushStatus(BaseModel):
    """Result of GET /bgg/push/status. The FE poll target while a push drains."""
    bgg_username: Optional[str] = None
    auth_state: BggAuthState = BggAuthState.UNLINKED
    pending_count: int = 0
    errored_count: int = 0
    last_completed_at: Optional[datetime] = None
    session_started_at: Optional[datetime] = None
    session_total: int = 0
    session_done: int = 0
    session_errored: int = 0
    session_game_names: list[str] = []
    # No import counterpart: a half-failed import can be re-run and idempotency
    # cleans up, but a half-failed push has left flags on a third-party account
    # in an unknown state, so the user has to be told which games.
    session_errors: list[BggPushError] = []


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
    # How many of `total` are prev_owned (migration 069). The owned shelf
    # returns games you sold alongside games you have, so the caller needs this
    # to show a count that means "games you own". Always 0 on other shelves.
    parted_total: int = 0
    page: int
    per_page: int


class CollectionStatusMapResponse(BaseModel):
    """The two small dicts the web client actually needs from a collection read.

    GET /collection returns every row with its game embedded, which cost three
    unbounded round trips to produce; the only consumer read four fields off it
    and discarded the rest. This is that consumer's actual contract.
    """

    # game_id (UUID string) -> "owned" | "wishlist" | "played" | "prev_owned"
    status_map: dict[str, str] = Field(default_factory=dict)
    # base game's bgg_id (as a string key) -> count of expansions the viewer
    # owns. prev_owned expansions are NOT counted — one you sold is no longer
    # clutter on the base game's shelf.
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
    # Counts every row in `items`' source set, prev_owned included, because
    # `truncated` below is about the rows on offer.
    total: int
    # How many of `total` are prev_owned (migration 069). The owned shelf
    # returns games you sold alongside games you have, so the caller subtracts
    # this to show a count that means "games you own". Always 0 elsewhere.
    parted_total: int = 0
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
    # Where the play happened, ISO 3166-1 alpha-2 (migration 065). Country
    # granularity is the whole design: it answers "what gets played in
    # Germany" without a location permission and without being able to say
    # where anybody lives. The client resolves it from the device timezone and
    # the host can correct it in Settle Up; None whenever it can't be resolved,
    # which is a legitimate row and never an error.
    country_code: Optional[CountryCode] = None
    # Migration 005. Shared by every play in one run of identical imported
    # plays — same game, same date, same players, same winner, and the same
    # note and scores as each other, if any. Indistinguishable, which is not
    # the same as featureless: a run whose entry carried "league night" is
    # still one run, and the client's own key is what decides (a play with a
    # detail nobody else shares is alone at its key and never tagged). The feed
    # and the plays log show one card per run; every counter still sees the
    # individual rows. Set ONLY by the Settings importer: a live log is one
    # play and stands for itself.
    import_group_id: Optional[UUID4] = None
    # Migration 007. One id per IMPORT, where the group above is one per RUN.
    # It is what makes "undo that whole paste" expressible — a series of run
    # deletions could never say it, because an import also writes one-offs that
    # carry no group at all. imported_at is stamped server-side from this.
    import_batch_id: Optional[UUID4] = None


class PlayUpdate(BaseModel):
    # Full replacement of the play. Mirrors PlayCreate but game_id can't change
    # — pivoting a play to a different game would orphan the per-player scores.
    played_at: date
    players: list[PlayerEntry] = []
    notes: Optional[str] = None
    photo_url: Optional[str] = None
    expansion_ids: list[str] = []
    play_mode: Optional[PlayMode] = None
    # Migration 060. Like play_mode, only written when the request carries one:
    # an edit form that doesn't offer the field must not silently wipe the
    # country the play was logged with.
    country_code: Optional[CountryCode] = None


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
    # ISO 3166-1 alpha-2 where the play happened (migration 065). None for
    # every play logged before 060 and for any client that couldn't resolve
    # one, so every reader has to handle its absence.
    country_code: Optional[str] = None
    # Logger metadata — lets the FE distinguish own logs from shared plays
    # (where the current user appears via a linked buddy).
    logged_by_id: str
    logged_by_name: str
    is_own: bool = True
    # How many plays this row stands for (migration 005). 1 for everything the
    # app logs live; the run's size when this row represents a group of
    # identical imported plays. The plays log renders one row per group and
    # reads this for its "58 plays" line.
    group_count: int = 1




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


class BulkBuddyRequestCreate(BaseModel):
    """A batch of buddy requests, sent from one multi-select.

    The onboarding "Add buddies" step lets the user tick several suggestions
    and send them in one go. Firing N parallel POSTs from the client instead
    would mean N auth round trips and a partially-applied batch the UI has no
    way to describe."""

    target_user_ids: list[str] = Field(..., min_length=1, max_length=50)


class BulkBuddyRequestFailure(BaseModel):
    """One target that could not be requested, and why."""

    user_id: str
    detail: str


class BulkBuddyRequestResponse(BaseModel):
    """Per-target outcome of a bulk send.

    A batch is never all-or-nothing: one stale suggestion (the target deleted
    their account, or sent the viewer a request while the screen was open)
    must not sink the other nine. Every target is attempted; `sent` counts the
    edges that now exist, `failed` explains the rest."""

    sent: list[str] = []
    failed: list[BulkBuddyRequestFailure] = []

    @computed_field  # type: ignore[prop-decorator]
    @property
    def sent_count(self) -> int:
        return len(self.sent)


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


class BuddyQrPeekRequest(BaseModel):
    token: str


class BuddyQrPeekResponse(BaseModel):
    """Who a scanned code belongs to, and where the viewer already stands.

    Deliberately narrow: a verified token proves its owner had the code on
    screen seconds ago, which is consent to be IDENTIFIED, not a licence to
    read their profile. So this carries the same three fields any suggestion
    tile shows, plus the relation the scanner needs to know whether "Buddy up"
    has anything to do.
    """

    user_id: str
    display_name: str
    username: Optional[str] = None
    avatar: Optional[Avatar] = None
    relation: Literal["none", "buddies", "outgoing", "incoming", "blocked"] = "none"


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


# ── Ghost account claims (migration 070) ─────────────────────────────────────
#
# The mirror image of GhostLinkRequest above. That one is the ghost's OWNER
# saying "this nickname is Julia"; these are the claimant saying "that ghost is
# me" and the owner approving. A ghost has no id, so every one of these is
# keyed by (owner, display name).

class GhostClaimSuggestion(BaseModel):
    """A buddy's ghost whose name looks like the viewer's — "is this you?"."""

    owner_user_id: str
    owner_display_name: str
    owner_username: Optional[str] = None
    owner_avatar: Optional[Avatar] = None
    ghost_display_name: str
    # lower(btrim(display_name)) — the claim key. The FE addresses rows by it,
    # so two spellings of one ghost stay one row under the finger.
    ghost_name_key: str
    play_count: int
    last_played_at: Optional[date] = None
    last_game_name: Optional[str] = None
    match_score: Optional[float] = None
    # Set only when the viewer already has a claim on this ghost. A pending one
    # keeps the row visible with a disabled "Requested" chip rather than
    # vanishing; every other status filters the row out server-side.
    claim_status: Optional[str] = None
    claim_id: Optional[str] = None


class GhostClaimSuggestionsResponse(BaseModel):
    """An object rather than a bare list, matching SuggestedBuddiesResponse, so
    a count or a "why nothing" reason can be added without a breaking change."""

    suggestions: list[GhostClaimSuggestion] = []


class GhostClaimDetail(GhostClaimSuggestion):
    """One ghost on one play, for the claim sheet.

    can_claim / blocked_reason exist so the sheet paints a truthful disabled
    state instead of offering a button that 409s.
    """

    can_claim: bool = False
    blocked_reason: Optional[str] = None


class GhostClaimResponse(BaseModel):
    """One claim, from whichever side is looking at it."""

    id: str
    direction: Literal["incoming", "outgoing"]
    # The OTHER party: the claimant on an incoming claim, the owner on an
    # outgoing one. Mirrors BuddyRequestResponse.
    other_user_id: str
    other_display_name: str
    other_username: Optional[str] = None
    other_avatar: Optional[Avatar] = None
    ghost_display_name: str
    play_count: int = 0
    last_played_at: Optional[date] = None
    created_at: datetime


class GhostClaimsResponse(BaseModel):
    incoming: list[GhostClaimResponse] = []
    outgoing: list[GhostClaimResponse] = []


class GhostClaimCreate(BaseModel):
    """Ask the ghost's owner to link it to your account."""

    owner_user_id: str
    display_name: str = Field(..., min_length=1)


class GhostClaimDismiss(BaseModel):
    """"Not me" — stop suggesting this ghost to the viewer."""

    owner_user_id: str
    display_name: str = Field(..., min_length=1)


class GhostClaimAcceptResponse(BaseModel):
    """rows_merged is how many plays actually moved, which is what the owner's
    toast says. It can differ from the play_count shown at request time if the
    owner logged more plays with that nickname in between."""

    claim: GhostClaimResponse
    rows_merged: int


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
    # viewer ('owned' | 'wishlist' | 'prev_owned'). None otherwise. A sold game
    # is still a collection hit and still ranks collection-first — you know the
    # game, which is what that ranking is about.
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
    # How many plays this card stands for (migration 005). 1 for every play the
    # app logs live, so the ordinary card is unaffected; the run's size when
    # the card represents a group of identical imported plays, which
    # ui/play-card.js renders as a stack rather than a polaroid.
    group_count: int = 1
    # The run's id (migration 007), so the card can act on what it represents —
    # the run sheet deletes by this. None for every ordinary play; 005 returned
    # the count without it, which let the feed say "58 plays" and do nothing
    # about them.
    import_group_id: Optional[str] = None


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
    # A suggestion has at least one of the three counts; the rail labels
    # whichever it has. play_count is what ranks the rail — see migration 057.
    mutual_count: int
    play_count: int = 0
    # People the viewer has SENT a request to who are buddies with this
    # candidate (migration 072). Deliberately not folded into mutual_count:
    # someone who has not accepted yet is not a mutual buddy, and the tile
    # says exactly that sentence off that number.
    pending_mutual_count: int = 0
    # Which first-hop person explains this candidate, and their name so the
    # tile can say "Buddy of Priya" without a second lookup. An accepted link
    # is preferred over a pending one. Null for a candidate that is only here
    # on a shared play, and for the whole 'active' tier.
    via_user_id: Optional[str] = None
    via_display_name: Optional[str] = None
    # Which tier the candidate came from (migration 063). Only the onboarding
    # endpoint sets it — the Feed rail and GET /buddies/suggested return
    # earned-signal candidates exclusively, so their counts already say why a
    # suggestion is there. None means "derive the reason from the counts",
    # which is what every pre-060 caller of the shared tile does.
    source: Optional[BuddySuggestionSource] = None


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


class SuggestionNetworkGroup(BaseModel):
    """Who one suggestion knows — the second hop, shipped up front.

    `via_user_id` is a user_id from the `suggestions` list beside it. The
    onboarding deck holds these until the user ticks that person, then
    promotes `buddies` into the grid in the same frame (migration 072). One
    candidate can appear under several groups; the client keeps the first."""

    via_user_id: str
    buddies: list[FeedSuggestedBuddy] = []


class OnboardingSuggestionsResponse(SuggestedBuddiesResponse):
    """GET /buddies/suggested/onboarding only.

    A subclass rather than two new fields on the shared response, because
    /buddies/suggested has no use for a preloaded second hop and should not
    carry an always-empty list to say so."""

    network: list[SuggestionNetworkGroup] = []


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


# ── Achievements (migration 062) ──────────────────────────────────────────────

class AchievementGroup(BaseModel):
    """One section heading on the Achievements spoke."""

    id: str
    label: str
    blurb: str


class AchievementItem(BaseModel):
    """One badge, resolved against the viewer's own progress."""

    id: str
    group_id: str
    name: str
    # What the badge is for, in plain language and past tense ("You've played
    # a game made specifically for 2 players."). Printed on earned badges and
    # in the unlock popup — see migration 067.
    tagline: str
    # The same fact in the imperative. Printed on locked badges.
    requirement: str
    # Sprite slug, never an emoji (.claude/rules/assets.md). The web app
    # resolves it to assets/sprites/achievements/bgb-ach-<icon>.svg.
    icon: str
    metric: str
    threshold: int
    # Clamped to `threshold` so the progress bar never overshoots; the
    # response's `metrics` map carries the raw counts.
    progress: int
    earned: bool
    unlocked_at: Optional[datetime] = None


class AchievementsResponse(BaseModel):
    """The whole Achievements spoke, from one bgb_sync_achievements call."""

    total: int = 0
    earned_count: int = 0
    # metric name → raw count, for copy like "312 plays" that wants the real
    # number rather than the clamped per-badge progress.
    metrics: dict[str, int] = {}
    groups: list[AchievementGroup] = []
    achievements: list[AchievementItem] = []


# ── Play importer ─────────────────────────────────────────────────────────────
# The Settings importer turns one pasted note into plays. Parse and write are
# two separate endpoints on purpose: everything between them — mapping names to
# accounts, matching game names to the catalog, filling in dates — happens in
# the wizard, so nothing the model guessed reaches the database unreviewed.


class PlayImportImage(BaseModel):
    """One photograph of a note, inline.

    Base64 rather than an upload to storage: these are read once and thrown
    away. A play photo earns a row in the bucket because the play keeps it
    forever; a picture of somebody's notebook is scaffolding for one request,
    and storing it would mean deciding later who deletes it and when.
    """

    mime_type: Literal["image/jpeg", "image/png", "image/webp"]
    # Standard base64 of the image bytes, without a `data:` prefix — the client
    # strips its own. Validated by decoding it, in the route: a field validator
    # here would decode every image twice, once to check and once to measure.
    data: str


class PlayImportParseRequest(BaseModel):
    """A note — pasted, photographed, or both — plus the user's optional
    description of its layout."""

    # Empty is legitimate when `images` carries the note. The route rejects a
    # request with neither, which is a clearer error than min_length=1 pointing
    # at a field the user never filled in because they took a photo instead.
    text: str = Field("", max_length=MAX_IMPORT_CHARS)
    # Step 2 of the wizard. Appended to the prompt verbatim when non-empty —
    # "tally marks, one per game won" is the difference between reading the
    # Carcassonne note right and reading it as two plays.
    hint: Optional[str] = Field(None, max_length=MAX_IMPORT_HINT_CHARS)
    # Photographs of the note. Read alongside `text` rather than instead of it:
    # someone with three pages shot and a line of context typed should get both
    # read, and the model is told which is which.
    images: list[PlayImportImage] = Field(
        default_factory=list, max_length=MAX_IMPORT_IMAGES
    )


class ParsedPlayer(BaseModel):
    """One seat in a parsed play, before any mapping to an account."""

    name: str
    is_winner: bool = False
    score: Optional[int] = None


class ParsedPlay(BaseModel):
    """One play the model found — or `count` identical repeats of it.

    `count` is what keeps a 106-play tally note inside one small reply: the
    model writes the run once and says how long it is, and the client expands
    it into individual draft plays.
    """

    game: str
    played_at: Optional[date] = None
    count: int = 1
    notes: Optional[str] = None
    players: list[ParsedPlayer] = []


class ParsedGameRef(BaseModel):
    """A distinct game name from the note, with its catalog candidates."""

    name: str
    # Best matches from boardgamebuddy_search_games, best first.
    candidates: list[GameSummary] = []
    # True when exactly one candidate matched the name case-insensitively and
    # exactly. The wizard pre-selects those and asks about the rest.
    confident: bool = False


class PlayImportParseResponse(BaseModel):
    """Everything the wizard needs to open its Players and Games steps."""

    plays: list[ParsedPlay] = []
    # Distinct player names in first-seen order — the Players step's rows.
    players: list[str] = []
    games: list[ParsedGameRef] = []
    # Total plays after `count` expansion, so the client can show the real
    # number before it builds the list.
    total_plays: int = 0
    # Anything the model flagged as guessed or unreadable. Shown on the
    # Review step; never a reason to fail the request.
    warnings: list[str] = []


class PlayImportRequest(BaseModel):
    """One chunk of an import. Same per-play shape as POST /plays."""

    plays: list[PlayCreate] = Field(..., min_length=1, max_length=IMPORT_CHUNK_MAX)


class PlayImportResultItem(BaseModel):
    """What happened to one play in the chunk, by its index in the request."""

    index: int
    id: Optional[str] = None
    # True when this play's client_key was already stored — a retry of a chunk
    # whose response was lost, which is what makes resuming an import safe.
    duplicate: bool = False
    error: Optional[str] = None


class PlayImportResponse(BaseModel):
    """Per-play outcomes for one chunk, so a partial failure stays legible."""

    imported: int = 0
    duplicate: int = 0
    failed: int = 0
    results: list[PlayImportResultItem] = []


class PlayImportDeleteResponse(BaseModel):
    """How many plays a delete actually removed.

    Zero is a legitimate answer, not an error: an id that belongs to somebody
    else matches no rows, which is the same outcome as an id that never
    existed. The routes deliberately do not distinguish the two — telling a
    caller "that batch exists but is not yours" would be a disclosure.
    """

    deleted: int = 0


class PlayImportSummary(BaseModel):
    """One past import, as the Settings list shows it."""

    batch_id: str
    imported_at: Optional[datetime] = None
    play_count: int = 0
    game_count: int = 0
    # Capped at four in the RPC — a batch spanning fifteen games would push a
    # paragraph into a settings row. `game_count` beside it stays exact.
    game_names: list[str] = []
    first_played_at: Optional[date] = None
    last_played_at: Optional[date] = None


class PlayImportListResponse(BaseModel):
    imports: list[PlayImportSummary] = []
