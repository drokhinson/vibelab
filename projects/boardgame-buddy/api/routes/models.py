"""Pydantic models for BoardgameBuddy."""

from datetime import date, datetime
from typing import Annotated, Any, Literal, Union
from pydantic import (
    UUID4,
    AfterValidator,
    BaseModel,
    BeforeValidator,
    Field,
    SecretStr,
    computed_field,
    field_validator,
    model_validator,
)

from .constants import (
    MAX_AFFILIATE_DISCLOSURE_CHARS,
    MAX_AFFILIATE_LABEL_CHARS,
    MAX_AFFILIATE_NOTES_CHARS,
    MAX_AFFILIATE_TAG_CHARS,
    MAX_AFFILIATE_TEMPLATE_CHARS,
    AdminRunLevel,
    AdminRunTool,
    AffiliateSurface,
    ChapterReportStatus,
    DiscoverReasonKind,
    FeedbackStatus,
    IMPORT_CHUNK_MAX,
    MAX_BUDDY_ALIAS_CHARS,
    MAX_PLAY_TEAM_CHARS,
    MAX_FEEDBACK_BODY_CHARS,
    MAX_IMPORT_CHARS,
    MAX_IMPORT_HINT_CHARS,
    MAX_IMPORT_IMAGES,
    MAX_SCORING_ROW_LABEL_CHARS,
    MAX_SCORING_ROW_NOTE_CHARS,
    MAX_RELEASE_NOTICE_BODY_CHARS,
    MAX_RELEASE_NOTICE_LINK_LABEL_CHARS,
    MAX_RELEASE_NOTICE_LINK_ROUTE_CHARS,
    MAX_RELEASE_NOTICE_TITLE_CHARS,
    MAX_SCORING_TEMPLATE_ROWS,
    BgaAuthState,
    BgaFetchPhase,
    BgaFetchState,
    BgaFetchStepState,
    BgaMatchReason,
    BggAuthState,
    BggCheckPhase,
    BggCheckState,
    BggCheckStepState,
    BggPullChange,
    BggPushChange,
    BggUnpushableReason,
    BuddySuggestionSource,
    ChapterLayout,
    CollectionStatus,
    ExportDataset,
    FeedCardKind,
    NotificationKind,
    PlayLinkGroup,
    PlayMode,
    PlaySessionStatus,
    PushTier,
    RunState,
    RunStepState,
    ScoringGridMode,
    ScoringRowColor,
    SessionPhase,
)


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


class BackfillPassResponse(BaseModel):
    """Outcome of ONE PASS of an admin catalog backfill.

    One model for both of them (images and metadata) because it was always one
    shape: they had a `RefreshImagesResponse` and a `RefreshDescriptionsResponse`
    with the same three fields, and the former's docstring said so.

    A pass is bounded server-side so it fits inside the platform's request
    timeout, so one call is usually NOT the whole catalog. `remaining` is how
    many rows the run still has work to do on, and the browser keeps asking
    until it reads 0 — a pass that cannot produce a falsy `remaining` is a
    drain that never ends, which is the bug that left the image re-host running
    exactly once.

    `failed` counts rows in batches that errored out. The loop swallows those
    so one bad chunk cannot abort a fifty-chunk run, which otherwise leaves an
    admin staring at "updated: 40" with no hint that 20 more silently didn't
    land.
    """

    updated: int
    failed: int = 0
    remaining: int = 0


class AdminReviewCounts(BaseModel):
    """How many items each admin tool has waiting.

    Backs the notification dot on the Settings gear and the per-tool badges in
    the Settings admin card. `total` is computed rather than sent so the two
    can never disagree.
    """

    chapter_reports: int = 0
    missing_images: int = 0
    # Catalog games short of anything one /thing?stats=1 read would give them —
    # a description, BGG stats, publisher credits, or a year (migration 046).
    #
    # ONE field where there were three. They were three counts of three
    # overlapping queues, so a game missing both its blurb and its year was
    # counted twice and the gear's dot over-reported. It is also deliberately
    # NOT the backfill's queue predicate: this counts rows that are still
    # incomplete, including ones BoardGameGeek has nothing more to give, so it
    # is not expected to reach zero. The queue that has to terminate is
    # `bgg_meta_synced_at IS NULL`, and it lives in the endpoint.
    missing_metadata: int = 0

    @computed_field  # type: ignore[misc]
    @property
    def total(self) -> int:
        return self.chapter_reports + self.missing_images + self.missing_metadata


# ── Scoring grids (migration 018) ─────────────────────────────────────────────
# Defined up here rather than with the chapters that author them, because a
# play and a live session each carry a snapshot of one and both are declared
# further up the file than the chapter block.

class ScoringRow(BaseModel):
    """One labelled row of a scoring grid — an Everdell "Prosperity", an
    Arboretum species."""

    label: str = Field(..., min_length=1, max_length=MAX_SCORING_ROW_LABEL_CHARS)
    color: ScoringRowColor = ScoringRowColor.NEUTRAL
    # Optional. How this row is scored, written by the template's author and
    # read by whoever is scoring: it surfaces only on the grid itself, behind an
    # info button beside the label, and never in the template's own listing.
    note: str | None = Field(None, max_length=MAX_SCORING_ROW_NOTE_CHARS)


class ScoringGrid(BaseModel):
    """The body of a layout='scoring_grid' chapter.

    `v` is here from the start so the document is migratable later (a subtotal
    row kind, a per-row cap): free to add now, impossible to retrofit. `mode`
    (migration 032) is that extension point being used for the first time.
    """

    v: int = 1
    # How an EXPANSION's grid meets the base game's — appended to it, or
    # instead of it. NULL on a base game's own grid, where the question does
    # not arise. The client may leave it out entirely; the write path resolves
    # it against the game the chapter is FOR, which is the only place that
    # knows whether that game is an expansion — see
    # services/chapter_grid.resolve_grid_mode.
    mode: ScoringGridMode | None = None
    rows: list[ScoringRow] = Field(
        ..., min_length=1, max_length=MAX_SCORING_TEMPLATE_ROWS
    )


class ScoringSnapshotRow(ScoringRow):
    """A row as it lands on a COMPOSED scorepad (migration 032).

    `source_color` is the `boardgamebuddy_games.expansion_color` of the
    expansion whose grid contributed the row, and None for a row from whichever
    grid leads the composition. It draws a rule down the RIGHT edge of the row's
    header cell, which is how a scorer tells "this row came with Pearlbrook"
    from "this row is the base game's" at a glance.

    A SECOND channel from `color`, not a replacement for it: `color` is the
    author's tint for what the row IS (a palette slug the stylesheet owns), and
    this is the provenance of where it came FROM. They are independent, so they
    get independent marks on OPPOSITE EDGES of the same cell — the left rule and
    the wash stay the author's, the right rule is the expansion's. Sharing one
    edge would mean an add-on's rows losing the tint their author chose.

    Deliberately not on ScoringRow itself: an authored grid has no provenance to
    record — every one of its rows is its own — so the field would be a
    permanently-null column on the authoring path and something the editor could
    be talked into sending.
    """

    # A hex from the games table, not a palette slug: expansion colours are
    # per-game data assigned at import, not one of the ten row tints. The client
    # sets it as a custom property and never as a literal `color:`, which is the
    # one legitimate inline-colour case in .claude/rules/theming.md §10.
    source_color: str | None = Field(None, max_length=32)


class ScoringTemplatePart(BaseModel):
    """One chapter that contributed rows to a COMPOSED template (migration 032).

    A play with expansions can be scored on rows drawn from several grids at
    once — the base game's, plus every add-on expansion's. `rows` above is the
    flattened result, which is what every renderer wants; this is the seam list
    beside it, so a reader can still say where a row came from and the play
    screen can name the composition ("Everdell score sheet + Pearlbrook")
    without re-deriving it from a guide that may since have changed.

    Provenance only, exactly like PlayScoringTemplate.chapter_id: nothing joins
    on these ids and they are allowed to dangle.
    """

    chapter_id: str | None = None
    game_id: str | None = None
    game_name: str | None = None
    # NULL for the base-game part; a ScoringGridMode value for an expansion's.
    mode: ScoringGridMode | None = None
    # How many of the flattened rows this part contributed, in order — so the
    # seams can be found without matching labels.
    row_count: int = 0


class PlayScoringTemplate(ScoringGrid):
    """The snapshot a play or a live session keeps of the grid it was scored on.

    `chapter_id` is provenance only — nothing joins on it and it is allowed to
    dangle, because the chapter it names is community-owned and may be edited or
    deleted long after the play. See the COMMENT ON boardgamebuddy_plays
    .scoring_template for the full argument.

    On a COMPOSED template (base game + add-on expansions) `chapter_id` names
    the part that supplied the leading rows — the base game's grid, or the
    replace-mode expansion grid standing in for it — and `parts` lists every
    contributor in row order. A single-grid template leaves `parts` None rather
    than writing a one-element list, so the common case reads exactly as it did
    before migration 032.

    The inherited MAX_SCORING_TEMPLATE_ROWS ceiling still applies to a
    composed template: composition is capped at the same number where it
    happens, so a snapshot over the ceiling is a bug rather than something to
    accommodate here.
    """

    chapter_id: str | None = None
    title: str | None = None
    parts: list[ScoringTemplatePart] | None = None
    # Widened from ScoringGrid's `list[ScoringRow]`: a composed row carries the
    # colour of the expansion it came from. Same ceiling, since composition is
    # capped at it where it happens.
    rows: list[ScoringSnapshotRow] = Field(
        ..., min_length=1, max_length=MAX_SCORING_TEMPLATE_ROWS
    )
    # Inherited from ScoringGrid and meaningless here: a COMPOSED template has
    # no single mode — its parts each have one, and they are in `parts`. Kept
    # (rather than made an error) so a client sending a chapter's document
    # straight through is not rejected over a field nothing reads, and
    # excluded from serialization so the stored snapshot does not carry a null
    # that looks like an answer.
    mode: ScoringGridMode | None = Field(default=None, exclude=True)


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
    # All optional so settings can save name, avatar and notification tier
    # independently.
    display_name: str | None = None
    avatar: Avatar | None = None
    # How much this account wants pushed to its devices (migration 017). Saved
    # through this endpoint rather than a /push route of its own because it is
    # an account preference like the two above, and this is already the app's
    # one profile-save path — the FE merges the response onto window.store.user
    # and every subscriber re-renders. Typed by the enum so an unknown value is
    # a 422 here rather than a CHECK violation in Postgres.
    push_tier: PushTier | None = None


class ProfileResponse(BaseModel):
    id: str
    display_name: str
    # Stable handle (migration 017). Readonly in the FE; search matches it.
    username: str
    avatar: Avatar | None = None
    is_admin: bool = False
    # TRUE for brand-new accounts that have not yet completed the
    # "Create your profile" modal (migration 030). Cleared by the first
    # successful POST /profile.
    needs_setup: bool = False
    # Defaulted rather than required: a profile row read by an older cached
    # client, or written before migration 017, has no value and must read as
    # "off" rather than 500 the whole profile fetch.
    push_tier: PushTier = PushTier.NONE
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
    bgg_username: str | None = None


class BggSyncSummary(BaseModel):
    """Result of POST /bgg/sync — a COLLECTION sync that also counts plays.

    Collection counts landed in their respective tables synchronously, plus the
    pending count the background worker will drain after importing the missing
    games from BGG.

    Plays are DETECTED here and imported elsewhere. This endpoint used to write
    them too; they go through the play importer now (POST /bgg/plays/pending →
    the wizard → POST /plays/import), so that nothing reaches
    boardgamebuddy_plays the user has not reviewed. The fields below were
    `plays_imported` / `plays_pending` and were RENAMED rather than left at
    zero: a count that silently means something else is the quietly-wrong
    number this whole change is about.
    """
    bgg_username: str
    collection_imported: int
    collection_pending: int
    # BGG plays with no row in boardgamebuddy_plays for this user yet. Drives
    # the done screen's "Import N plays" hand-off into the importer.
    plays_new: int = 0
    # Every play on the BGG account, for the copy around the number above.
    plays_total: int = 0
    # True when the /plays read ran out of warm-up retries. Without this a
    # failed read is indistinguishable from "nothing new", and the done screen
    # would hide the importer hand-off from an account with hundreds waiting.
    plays_read_failed: bool = False
    # Count of distinct BGG game ids queued by this sync (one BGG /thing call
    # per id). Drives the "Importing X of Y" progress bar. Collection-only
    # since plays stopped being written here — a game that exists solely to
    # carry a play is the importer's to fetch, on demand, in its Games step.
    unique_games_to_import: int = 0
    # True when BGG kept returning "still preparing" for every batch and the
    # sync ended up with nothing to import. The FE shows a "try again shortly"
    # toast instead of "Imported 0".
    warm_up_retry_pending: bool = False


class BggSyncStatus(BaseModel):
    """Result of GET /bgg/sync/status. Used by the FE to poll progress."""
    bgg_username: str | None = None
    auth_state: BggAuthState = BggAuthState.UNLINKED
    # Lifetime row counters in boardgamebuddy_bgg_pending_imports. Kept for
    # back-compat with the existing settings header copy.
    pending_count: int = 0
    errored_count: int = 0
    last_completed_at: datetime | None = None
    # Session-scoped progress, anchored by profiles.bgg_last_sync_started_at.
    # Counted in distinct BGG game ids so the "X of Y" number matches the
    # number of /thing calls the worker actually makes.
    session_started_at: datetime | None = None
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
    catalog_session_started_at: datetime | None = None
    catalog_session_total: int = 0
    catalog_session_done: int = 0
    catalog_session_errored: int = 0
    catalog_session_game_names: list[str] = []


class BggDiffItem(BaseModel):
    """One planned BgB -> BGG change, as one row of the comparison."""
    bgg_id: int
    game_id: str | None = None          # None for a clear — no local row
    game_name: str
    thumbnail_url: str | None = None
    change: BggPushChange
    local_status: CollectionStatus | None = None    # None for a clear
    remote_status: CollectionStatus | None = None   # None for an add
    # True when POST /bgg/check had to import this game into the catalog just
    # to be able to name it here. The FE tags those rows, because they are the
    # surprising ones: they are NOT on the BgB shelf, so the push clears them.
    newly_catalogued: bool = False


class BggPullItem(BaseModel):
    """The same comparison read the other way: what an import would do here."""
    bgg_id: int
    game_name: str
    change: BggPullChange
    local_status: CollectionStatus | None = None
    remote_status: CollectionStatus | None = None


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
    done: int | None = None
    total: int | None = None
    detail: str | None = None
    retry: BggCheckRetry | None = None


class BggCheckProgressResponse(BaseModel):
    """Result of GET /bgg/check/progress — what POST /bgg/check is doing now.

    `state = unknown` means we have no record, which is NOT the same as
    finished: the record lives in an in-process cache that a restart clears
    while the POST itself is still running. The FE renders unknown as "still
    working" and takes completion from the POST's own resolution.
    """
    state: BggCheckState = BggCheckState.UNKNOWN
    kind: Literal["check", "push_plan", "none"] = "none"
    check_id: str | None = None
    started_at: datetime | None = None
    updated_at: datetime | None = None
    steps: list[BggCheckStep] = []
    warm_up_failed: bool = False
    error: str | None = None


# ── Admin run progress (GET /admin/runs, GET /admin/runs/{tool}) ──────────────
# The same checklist shape as BggCheckStep above, plus the two things an admin
# run has that a user's comparison does not: a journal of per-item outcomes,
# and a life that spans several requests. Declared here, next to the model it
# mirrors, so the two cannot drift apart unnoticed.

class AdminRunStep(BaseModel):
    """One row of an admin run's checklist.

    `key` is a bare str rather than an enum because the phase vocabulary varies
    by tool — trending walks AdminTrendingPhase, the four backfills walk
    AdminBackfillPhase — and a union here would let a response validate against
    the wrong tool's phases.
    """
    key: str
    state: RunStepState = RunStepState.IDLE
    done: int | None = None
    total: int | None = None
    detail: str | None = None
    retry: BggCheckRetry | None = None


class AdminRunEvent(BaseModel):
    """One line of the run log — a game imported, a batch that failed, a row
    that would not write. This is what the checklist cannot say: which item."""
    at: datetime
    level: AdminRunLevel = AdminRunLevel.INFO
    phase: str
    pass_no: int = 0
    message: str


class AdminRunTotals(BaseModel):
    """Cumulative across every pass of a run. `remaining` is the server's
    current view of the queue rather than a running sum, which is what lets the
    client decide whether to ask for another pass."""
    updated: int = 0
    failed: int = 0
    remaining: int = 0


class AdminRunSummary(BaseModel):
    """One row of GET /admin/runs — everything the Settings status pill needs
    and nothing it does not.

    Deliberately journal-free: that card polls every tool at once and is not
    the log, so it must not cost a few hundred event rows a second to paint a
    pill that says "Running · 4 of 10".
    """
    tool: AdminRunTool
    state: RunState = RunState.UNKNOWN
    run_id: str | None = None
    pass_no: int = 0
    started_at: datetime | None = None
    updated_at: datetime | None = None
    started_by: str | None = None
    totals: AdminRunTotals = AdminRunTotals()
    steps: list[AdminRunStep] = []
    error: str | None = None


class AdminRunProgressResponse(AdminRunSummary):
    """GET /admin/runs/{tool} — the summary above plus the log itself.

    `state = unknown` means this process has no record, which for an admin run
    means NOTHING HAS RUN IN THE LAST TEN MINUTES — the page renders its idle
    "Run now" state. That is the opposite reading from
    BggCheckProgressResponse, where unknown means "still working"; see
    RunState's docstring for why the two differ.

    `tool` is optional here and required on the summary: a response for a tool
    with no record still has to name the tool it is about.
    """
    tool: AdminRunTool | None = None
    events: list[AdminRunEvent] = []
    # How many oldest lines the 200-entry cap dropped, so a long drain's log
    # says "and 340 earlier lines" instead of quietly starting mid-run.
    events_dropped: int = 0


class BggPushBody(BaseModel):
    """POST /bgg/push. `checked_at` names the comparison the user reviewed, so
    the push can commit that one instead of sweeping BGG again."""
    checked_at: datetime | None = None


class BggPushSummary(BaseModel):
    """Result of POST /bgg/push — what was queued, before the worker runs."""
    bgg_username: str
    queued: int = 0
    adds: int = 0
    updates: int = 0
    clears: int = 0
    unpushable: int = 0
    warm_up_retry_pending: bool = False
    # True when this committed the comparison the user reviewed rather than
    # sweeping BoardGameGeek all over again. The push log narrates the two
    # differently, because "Re-checked your BoardGameGeek collection" is a
    # sentence about work that, on the fast path, nobody did.
    reused_comparison: bool = False


class BggPushError(BaseModel):
    """One game whose push failed, named so the user knows what is unresolved."""
    game_name: str
    message: str


class BggPushStatus(BaseModel):
    """Result of GET /bgg/push/status. The FE poll target while a push drains."""
    bgg_username: str | None = None
    auth_state: BggAuthState = BggAuthState.UNLINKED
    pending_count: int = 0
    errored_count: int = 0
    last_completed_at: datetime | None = None
    session_started_at: datetime | None = None
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
    bgg_id: int | None = None
    name: str
    year_published: int | None = None
    min_players: int | None = None
    max_players: int | None = None
    playing_time: int | None = None
    thumbnail_url: str | None = None
    image_url: str | None = None
    theme_color: str | None = None
    is_expansion: bool = False
    base_game_bgg_id: int | None = None
    expansion_color: str | None = None
    rulebook_url: str | None = None
    play_mode: PlayMode = PlayMode.COMPETITIVE
    # BGG geek rating (1..10) and overall rank, backfilled into the catalog by
    # POST /games/admin/backfill-metadata (migration 038, 045). Optional on purpose:
    # NULL means "not synced yet", and a client holding a pre-038 cached row
    # simply reads None — no cache SCHEMA_VERSION bump needed.
    bgg_rating: float | None = None
    bgg_rank: int | None = None
    # Number of expansion rows in boardgamebuddy_games that point at this
    # game (via base_game_bgg_id == this.bgg_id). Populated by the list
    # endpoints so browse/search tiles can show a "git-fork N" badge.
    # Defaults to 0 for callers that don't bother computing it.
    expansion_count: int = 0

    @computed_field  # type: ignore[misc]
    @property
    def bgg_url(self) -> str | None:
        return f"https://boardgamegeek.com/boardgame/{self.bgg_id}" if self.bgg_id else None


def _null_list_to_empty(v: Any) -> Any:
    """NULL → [] for a nullable array column.

    `publishers` is nullable with no DB default (migration 040) so that NULL
    can mean "never synced" to the backfill's queue. A reader has no use for
    that distinction and Pydantic would reject the None outright, so it lands
    here as the empty list every consumer already handles.
    """
    return [] if v is None else v


class GameDetail(GameSummary):
    description: str | None = None
    categories: list[str] = []
    mechanics: list[str] = []
    # BGG's publisher credits in BGG's order, capped at 4 by the import
    # (migration 040). The game page names the first; the rest are there for
    # any later edition list. On GameDetail and not GameSummary on purpose —
    # no rail or search tile shows a publisher, so it stays out of
    # game_select_clause() and off every list payload.
    #
    # Defaults to [], which flattens the column's two absences (NULL = never
    # synced, '{}' = synced and BGG credits nobody) into one. That is the right
    # shape for a reader: both mean "no publisher to show", and a client
    # holding a row cached before 040 reads the same empty list.
    publishers: Annotated[list[str], BeforeValidator(_null_list_to_empty)] = []
    created_at: datetime
    # Populated on expansion rows so the FE can render a "Back to <base>" link
    # without a second lookup. Resolved via base_game_bgg_id at read time.
    base_game_id: str | None = None
    base_game_name: str | None = None


class MissingMetadataGame(GameSummary):
    """One row of GET /games/admin/missing-metadata.

    A GameSummary plus the two things only this screen needs: WHAT is missing,
    and whether we have already asked BoardGameGeek.

    `missing` is a list of field names rather than four booleans so the panel
    can say "no description, no year" in one line without four ternaries, and
    so adding a fifth field to the sweep does not change this shape.

    `checked_at` is what lets a row explain itself. A game still listed after a
    sync is not a bug and not a stalled queue — it is a game BoardGameGeek has
    nothing more to give, and the row says so instead of looking stuck. It is
    also the one field that distinguishes "never asked" from "asked, and this
    is all there is".
    """

    missing: list[str] = []
    checked_at: datetime | None = None


class GameListResponse(BaseModel):
    games: list[GameSummary]
    total: int
    page: int
    per_page: int


# ── BoardGameGeek plays, as the importer previews them ────────────────────────
#
# These live down here rather than up with the other Bgg* models because each
# row carries a resolved GameSummary, and GameSummary is defined above. The
# alternative was a forward reference plus a model_rebuild() at the foot of the
# file, which is machinery for nothing.


class BggPendingPlayer(BaseModel):
    """One seat on a BGG play, before the importer maps it onto anybody."""
    # BGG's own display name for the seat, or their handle when the play only
    # recorded one. Never empty — the parser drops a seat that names nobody.
    name: str
    # The BGG account at this seat, when the play records one. This is what
    # lets the importer seat the syncing user without guessing at a name
    # match, and it is the only field here that is an identity rather than a
    # label.
    username: str | None = None
    is_winner: bool = False


class BggPendingPlay(BaseModel):
    """One BGG play this account has not imported yet."""
    bgg_play_id: int
    bgg_id: int
    # BGG's name for the game, kept even when `game` resolves — the Games step
    # has to be able to say what it is asking about, and a game the catalog
    # lacks has nothing else to be called.
    bgg_game_name: str | None = None
    played_at: date
    notes: str | None = None
    # BGG lets one play stand for N sittings. Echoed, never expanded: N rows
    # would share one bgg_play_id and the partial UNIQUE would reject all but
    # the first. The review warns about it instead.
    quantity: int = 1
    players: list[BggPendingPlayer] = []
    # The catalog row for `bgg_id`, or None when BgB has never seen this game.
    # The importer's Games step imports those on demand rather than the server
    # queueing every one of them — a user only pays for the games whose plays
    # they are actually bringing over.
    game: GameSummary | None = None


class BggPendingPlaysResponse(BaseModel):
    """Result of POST /bgg/plays/pending — the importer's BoardGameGeek source.

    `total_new` counts every play that is missing, `plays` carries at most
    MAX_BGG_PENDING_PLAYS of them (newest first). The two differ on a large
    history, which is what `truncated` is for: every imported play keeps its
    bgg_play_id, so "run it again for the rest" is a loop that terminates.
    """
    bgg_username: str
    plays: list[BggPendingPlay] = []
    total_new: int = 0
    truncated: bool = False
    fetched_at: datetime
    # True when this was served from the read a sync had just taken
    # (services/bgg_plays_cache.py) rather than by walking BGG again. Reported
    # so a slow first preview and an instant one are distinguishable in logs.
    reused_read: bool = False
    # True when the /plays read ran out of warm-up retries. `plays` is then
    # empty and that emptiness means "we could not look", not "nothing new".
    read_failed: bool = False
    # Distinct player names across `plays`, first-seen order and first-seen
    # casing — the rows of the importer's Players step. Same rule as
    # play_import_service.distinct_player_names: a name written "Mick" must not
    # come back "mick" because a later play happened to lowercase it.
    players: list[str] = []


class BggSearchResult(BaseModel):
    bgg_id: int
    name: str
    year_published: int | None = None
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
    bgg_owned: int | None = Field(
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
    status: CollectionStatus
    added_at: datetime
    last_played_at: date | None = None
    play_count: int = 0
    game: GameSummary
    # No nested expansions: the web client asks for the flat shelf with
    # expansions included (exclude_expansions=false) and nests them itself in
    # web/domain/expansion-tree.js — nesting in SQL would silently drop an
    # owned expansion whose base game the viewer doesn't own.


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

    A flat collection read used to cost three unbounded round trips to produce
    these; the only consumer read four fields off it and discarded the rest.
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
    score: int | None = None
    # Real-account player id. Populated when the FE picks this player from
    # the user's accepted-buddy list; None for free-text ghost players.
    # Backend uses it to populate play_players.player_user_id (migration 009)
    # so the new feed RPC can resolve the winner's display name.
    user_id: str | None = None
    # Per-round score breakdown (migration 028). Only sent when more than
    # one round was tracked — the FE drops it for ≤1-round plays so the
    # column stays NULL for the simple-score path.
    round_scores: list[int | None] | None = None
    # The side this seat played on, free text as the host typed it
    # (migration 048). None for every competitive and co-op play. The client
    # caps its own input at 6 characters for column width; this cap is about
    # the data, not that column — see MAX_PLAY_TEAM_CHARS.
    team: str | None = Field(None, max_length=MAX_PLAY_TEAM_CHARS)

    @field_validator("team")
    @classmethod
    def _blank_team_is_none(cls, v: str | None) -> str | None:
        """An untagged seat is NULL, never "".

        Not an edge case — it is the common one. PlaySession seeds every seat
        with team:"" and writes "" back when a tag is cleared, so without this
        every untagged seat in the app would carry the same empty-string tag and
        group into one anonymous side. bgb_log_play does the same NULLIF for the
        RPC path; this covers PUT /plays/{id}, which writes the rows directly.
        """
        v = (v or "").strip()
        return v or None

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

        A breakdown of nothing but NULLs is the exception, and it is not a
        zero: it means rounds were added and never filled in. Summing it to 0
        stored a scoreline for a play that recorded no result, which then read
        as a loss in the feed caption and in every win-rate denominator. Leave
        `score` alone there — the client sends NULL for exactly this case.
        """
        if self.round_scores and any(v is not None for v in self.round_scores):
            self.score = sum(v or 0 for v in self.round_scores)
        return self


class PlayExpansionRef(BaseModel):
    expansion_game_id: str
    name: str
    color: str | None = None


class PlayCreate(BaseModel):
    game_id: str
    played_at: date
    players: list[PlayerEntry] = []
    notes: str | None = None
    photo_url: str | None = None
    expansion_ids: list[str] = []
    # Optional per-play scoring style override (migration 007). When None,
    # the play inherits the game's stored play_mode at insert time.
    play_mode: PlayMode | None = None
    # Idempotency key for offline-queued plays (migration 048). The web app's
    # outbox stamps one UUID per queued play and re-sends it on every flush
    # attempt, so a retry after a lost response returns the original play
    # instead of writing a duplicate. Omitted by live writes, where two
    # identical POSTs legitimately mean two plays.
    client_key: UUID4 | None = None
    # Where the play happened, ISO 3166-1 alpha-2 (migration 065). Country
    # granularity is the whole design: it answers "what gets played in
    # Germany" without a location permission and without being able to say
    # where anybody lives. The client resolves it from the device timezone and
    # the host can correct it in Settle Up; None whenever it can't be resolved,
    # which is a legitimate row and never an error.
    country_code: CountryCode | None = None
    # Migration 005. Shared by every play in one run of identical imported
    # plays — same game, same date, same players, same winner, and the same
    # note and scores as each other, if any. Indistinguishable, which is not
    # the same as featureless: a run whose entry carried "league night" is
    # still one run, and the client's own key is what decides (a play with a
    # detail nobody else shares is alone at its key and never tagged). The feed
    # and the plays log show one card per run; every counter still sees the
    # individual rows. Set ONLY by the Settings importer: a live log is one
    # play and stands for itself.
    import_group_id: UUID4 | None = None
    # Migration 007. One id per IMPORT, where the group above is one per RUN.
    # It is what makes "undo that whole paste" expressible — a series of run
    # deletions could never say it, because an import also writes one-offs that
    # carry no group at all. imported_at is stamped server-side from this.
    import_batch_id: UUID4 | None = None
    # Migration 018. Snapshot of the scoring-grid chapter this play was scored
    # on, or None for the plain R1..Rn grid. A snapshot rather than a chapter
    # id because the chapter is community-owned and may later be edited or
    # deleted; see the COMMENT ON boardgamebuddy_plays.scoring_template.
    scoring_template: PlayScoringTemplate | None = None
    # Migration 040. The Board Game Arena table this play was imported from,
    # and the key a re-import dedupes on — unique per user, so BGA history can
    # be imported repeatedly and only ever offer what is new. Set ONLY by the
    # wizard's BGA branch; every other origin leaves it None.
    bga_table_id: int | None = None
    # Migration 044. The BoardGameGeek play this row came from, set ONLY by the
    # importer's BoardGameGeek source. It is a second idempotency key beside
    # client_key, and the only one that can recognise a play the retired
    # POST /bgg/sync write path already landed — those rows carry a
    # bgg_play_id and no client_key, so nothing derived from the wizard's own
    # draft ids could ever match them. bgb_log_play pre-checks it and the
    # partial UNIQUE on (user_id, bgg_play_id) backs the check up.
    #
    # A live POST /plays could name an arbitrary id and squat that slot. The
    # index is per-user, so the only account anyone can do that to is their
    # own; gt=0 is therefore the whole validation this needs.
    bgg_play_id: int | None = Field(default=None, gt=0)


def validated_roster(players: list[PlayerEntry]) -> list[PlayerEntry]:
    """The seats of a play, checked against migration 023's two invariants.

    A SEAT NAMES SOMEBODY. `player_display_name` is a plain TEXT column and ""
    is not NULL, so a blank seat clears the identity CHECK and lands an
    anonymous row on the scoreboard; those are dropped rather than rejected,
    matching bgb_log_play, because a trailing empty row is a form artifact and
    not something the user did. What IS rejected is a roster with nothing left
    in it — every play has somebody at the table, and the three importers each
    wrote plays that had nobody until 023.

    ONE ACCOUNT, ONE SEAT. Two spellings of one buddy is the thing the notes
    importer's Players step exists to resolve; if it resolves them to the same
    account they are one seat, not two, and a play seating Jasmine twice — once
    winning — is what shipped before. The unique index added by 023 is the
    backstop; this is the readable error.

    Ghost seats are deliberately not deduped: two Daves at one table is a real
    roster, and the place to notice that two spellings meant one person is the
    mapping step, which now collapses them before the write.
    """
    seated = [p for p in players if (p.user_id or (p.name or "").strip())]
    if not seated:
        raise ValueError("A play needs at least one player.")
    accounts = [p.user_id for p in seated if p.user_id]
    if len(set(accounts)) != len(accounts):
        raise ValueError("That play seats the same person twice.")
    return seated


class PlayUpdate(BaseModel):
    # Full replacement of the play. Mirrors PlayCreate.
    played_at: date
    # The game this play records. Omitted-means-keep, like play_mode and
    # country_code below — a client that offers no way to change the game must
    # not be able to move a play by leaving the field out.
    #
    # Supplying a DIFFERENT id pivots the play: the commonest edit on this
    # surface is "I logged the wrong game", and before this the only way to say
    # it was to delete the play and re-enter the table, the scores and the
    # photo. The per-player scores come with it — a score is a number somebody
    # got at a table, not a property of the box — while the two things that
    # genuinely belonged to the old game do not. See _update_play_sync.
    game_id: str | None = None
    players: list[PlayerEntry] = []
    notes: str | None = None
    photo_url: str | None = None
    expansion_ids: list[str] = []
    play_mode: PlayMode | None = None
    # Migration 060. Like play_mode, only written when the request carries one:
    # an edit form that doesn't offer the field must not silently wipe the
    # country the play was logged with.
    country_code: CountryCode | None = None
    # Migration 018, and only written when supplied, for exactly the reason
    # above: the play-detail popup's edit mode round-trips the snapshot it was
    # given and never offers a way to change it (editing row labels is a
    # chapter edit — this play's copy is deliberately frozen). The one thing
    # that CLEARS it is a game pivot, and that is decided server-side rather
    # than by an absent field, for the same reason.
    scoring_template: PlayScoringTemplate | None = None

    @model_validator(mode="after")
    def _check_roster(self) -> "PlayUpdate":
        """Migration 023's roster gate, on the one write path that isn't an RPC.

        PUT /plays/{id} is a full replacement done in Python — it deletes every
        seat and re-inserts the body's — so bgb_log_play never sees it. Raising
        here rejects the request BEFORE the delete, which is the whole point: a
        roster refused halfway through would leave the play with no seats at
        all, which is the bug this is here to prevent.

        PlayCreate deliberately has no such validator. Every path that builds
        one ends at bgb_log_play, which checks the same two things and answers
        with a per-play error envelope — and a chunk of fifty imported plays
        must land the other forty-nine rather than 422 over one bad row.
        """
        self.players = validated_roster(self.players)
        return self


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
    user_id: str | None = None
    name: str
    # Linked-account avatar config (migration 029). NULL for ghost players
    # (player_user_id IS NULL) and for accounts that haven't customized
    # their badge — the FE renders the BGB default in both cases.
    avatar: Avatar | None = None
    is_winner: bool
    score: int | None = None
    # Per-round score breakdown (migration 028). NULL for legacy plays
    # and for any play with ≤1 rounds — the FE only persists the array
    # when there were multiple rounds.
    round_scores: list[int | None] | None = None
    # The side this seat played on (migration 048). NULL for every play logged
    # before it, every competitive and co-op play, and a team play whose sides
    # were never named. Defaulted rather than required because the roster RPCs
    # this model validates are not all re-emitted — one that omits the key must
    # still parse.
    team: str | None = None


class PlayResponse(BaseModel):
    id: str
    game_id: str
    game_name: str
    game_thumbnail: str | None = None
    played_at: date
    notes: str | None = None
    players: list[PlayPlayerResponse] = []
    photo_url: str | None = None
    expansions: list[PlayExpansionRef] = []
    created_at: datetime
    # Resolved scoring style for this play. Set from PlayCreate.play_mode if
    # provided, else inherited from the game at insert time. Always populated.
    play_mode: PlayMode = PlayMode.COMPETITIVE
    # ISO 3166-1 alpha-2 where the play happened (migration 065). None for
    # every play logged before 060 and for any client that couldn't resolve
    # one, so every reader has to handle its absence.
    country_code: str | None = None
    # The scoring grid this play was scored on (migration 018), or None for the
    # plain R1..Rn grid. Defaulting to None matters: bgb_feed_plays is not
    # re-emitted by 018, so rows it feeds validate unchanged and simply arrive
    # without labels until the popup revalidates through GET /plays/{id}.
    scoring_template: PlayScoringTemplate | None = None
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
    email: str | None = None
    avatar: Avatar | None = None


# ── Reference-guide chapters ──────────────────────────────────────────────────

class ChapterTypeResponse(BaseModel):
    id: str
    label: str
    icon: str | None = None
    display_order: int


class ChapterCreate(BaseModel):
    chapter_type: str
    # Optional for (and only for) layout='scoring_grid', whose title is DERIVED
    # from the game rather than typed — see services/chapter_grid.grid_title.
    # A text chapter still requires one, which the validator below enforces:
    # widening the field would otherwise let a titleless prose chapter through
    # to a NOT NULL column.
    title: str | None = None
    content: str
    layout: ChapterLayout = ChapterLayout.TEXT
    # Required for (and only for) layout='scoring_grid'. Mirrors the DB's
    # bgb_chapters_grid_shape CHECK so a mismatched pair is a 422 here rather
    # than a constraint violation from Postgres.
    grid: ScoringGrid | None = None

    @model_validator(mode="after")
    def _grid_matches_layout(self) -> "ChapterCreate":
        wants_grid = self.layout is ChapterLayout.SCORING_GRID
        if wants_grid and self.grid is None:
            raise ValueError("layout 'scoring_grid' requires a grid")
        if not wants_grid and self.grid is not None:
            raise ValueError("grid is only valid with layout 'scoring_grid'")
        if not wants_grid and not (self.title or "").strip():
            raise ValueError("title is required")
        return self


class ChapterGenerateRequest(BaseModel):
    """Ask the AI to draft a chapter of this type for the game in the path."""

    chapter_type: str
    # Optional free-text steer from the wizard's "head start" step ("just the
    # endgame trigger and final scoring"). Absent or blank means a general
    # chapter for the type. Capped in the model so an oversized body is a 422
    # rather than a token bill — the service truncates again defensively.
    prompt: str | None = Field(None, max_length=500)


class ChapterGenerateResponse(BaseModel):
    """A draft only — the editor fills its form with this and the user reviews,
    edits, and saves. Nothing is persisted by the generate call itself."""

    chapter_type: str
    title: str
    content: str


class ChapterGridGenerateRequest(BaseModel):
    """Ask the AI to rough out a scoring grid for the game in the path.

    No `chapter_type`, unlike ChapterGenerateRequest: a grid is one type by
    definition (services/chapter_grid.SCORING_GRID_CHAPTER_TYPE) and asking for
    it would only invite a caller to name a different one.
    """

    # Optional free-text steer from the grid wizard's head-start step ("we play
    # with Pearlbrook"). Same cap, and the same reasons, as the chapter drafter
    # above: an oversized body is a 422 rather than a token bill, and the
    # service truncates again defensively.
    prompt: str | None = Field(None, max_length=500)
    # The mode the author has picked for an EXPANSION's grid (migration 032),
    # and the one field here that changes what gets drafted rather than merely
    # steering it: an add-on wants the two or three rows the expansion BRINGS,
    # a replacement wants the whole reprinted sheet. Resolved against the game
    # exactly as the write path resolves it (services/chapter_grid.resolve_mode)
    # — ignored for a base game, defaulted to add_on for an expansion that names
    # none — so the rows cannot be drafted for one mode and saved under another.
    mode: ScoringGridMode | None = None


class ChapterGridGenerateResponse(BaseModel):
    """A draft only — the wizard loads these rows into its editor and the author
    renames, recolours, reorders and deletes before saving. Nothing is persisted
    by the generate call itself.

    Carries a whole `ScoringGrid` rather than a bare row list so the draft is
    the same shape ChapterCreate.grid takes: the client can hand it back
    unchanged, and a row that would 422 on save cannot come out of here.
    """

    grid: ScoringGrid


class ChapterUpdate(BaseModel):
    chapter_type: str | None = None
    # None means "not supplied". A scoring grid's title is derived from its game
    # on every write, so the editor sends none for one and anything a client
    # does send for one is overwritten rather than honoured.
    title: str | None = None
    content: str | None = None
    layout: ChapterLayout | None = None
    # None means "not supplied", so this shape cannot CLEAR a grid. That is
    # correct: a chapter never changes layout in practice, and the editor sends
    # layout + grid together or neither.
    grid: ScoringGrid | None = None


class ChapterResponse(BaseModel):
    id: str
    game_id: str
    chapter_type: str
    chapter_type_label: str | None = None
    chapter_type_icon: str | None = None
    chapter_type_order: int = 0
    title: str
    layout: str
    content: str
    # Present only for layout='scoring_grid'. Inherited by ChapterPoolItem and
    # MyGuideChapterResponse, which is every surface that renders a chapter.
    grid: ScoringGrid | None = None
    created_by: str | None = None
    created_by_name: str | None = None
    updated_at: datetime
    # Source-game tagging — populated whenever the response might mix chapters
    # from multiple games (base + expansions). Always equals (game_id, game
    # name, expansion_color) for the chapter's defining game; source_color is
    # None for base games and the boardgamebuddy_games.expansion_color for
    # expansion rows.
    source_game_id: str | None = None
    source_game_name: str | None = None
    source_color: str | None = None
    # The source game's BoardGameGeek id, populated alongside the rest of the
    # source tagging. It is the ORDERING key when several add-on expansions
    # contribute rows to one scorepad (migration 032): BGG ids ascend roughly
    # with publication, every client sorts the same way, and the alternative —
    # whatever order the guide's merged response happened to arrive in — would
    # give two people at the same table different scorepads. None for a game
    # this app knows about but BGG does not.
    source_bgg_id: int | None = None


class ChapterPoolItem(ChapterResponse):
    # Number of users who have this chapter in their guide. Browse pool
    # rows are sorted by `popularity DESC, created_at DESC`.
    popularity: int = 0
    # Whether the calling user already has this chapter in their guide.
    # Frontend hides rows where this is true. Anon callers always see
    # `in_my_guide=false`.
    in_my_guide: bool = False
    # Whether the calling user has turned this chapter down (migration 033).
    # Mutually exclusive with in_my_guide — one row in
    # boardgamebuddy_user_chapters carries one state, so both can never be
    # true. Anon callers always see `disliked=false`.
    #
    # Disliked rows stay ON the wire rather than being dropped server-side:
    # the builder needs them for its Disliked section, and shipping them with
    # the pool it already fetches is one round trip where a second endpoint
    # would be two. The client is what hides them from the browse list.
    disliked: bool = False


class ChapterPoolCountResponse(BaseModel):
    # How many chapters exist for a game, with none of them on the wire. The
    # reference guide needs the number to say "3 of 12" on its Edit-chapters
    # button; pulling /chapter-pool for it would carry every chapter's full
    # markdown body to render one integer.
    #
    # Viewer-scoped since migration 033: the caller's own disliked chapters
    # are subtracted, because a chapter they have turned down is not one their
    # guide is missing. An anonymous caller gets the unfiltered total.
    total: int = 0


class MyGuideChapterResponse(ChapterResponse):
    added_at: datetime


class AddChapterRequest(BaseModel):
    chapter_id: str


class ChapterReportCreate(BaseModel):
    reason: str | None = Field(None, max_length=500)


class ChapterReportResponse(BaseModel):
    id: str
    chapter_id: str
    chapter_title: str
    chapter_content_preview: str
    chapter_type: str
    chapter_type_label: str | None = None
    game_id: str
    game_name: str
    reporter_id: str
    reporter_name: str | None = None
    reason: str | None = None
    status: ChapterReportStatus
    created_at: datetime
    resolved_at: datetime | None = None


# ── Expansions ────────────────────────────────────────────────────────────────

class ExpansionListItem(BaseModel):
    expansion_game_id: str
    bgg_id: int | None = None
    name: str
    thumbnail_url: str | None = None
    # Full-size box art. The expansion reel crops its polaroids at 132x110,
    # which upscales BGG's ~200px thumbnail; the web client prefers this and
    # falls back to thumbnail_url when a game has no re-hosted image.
    image_url: str | None = None
    color: str | None = None
    is_enabled: bool = False
    rulebook_url: str | None = None
    # Which base game this expansion extends. Only the catalog endpoint sets
    # it — /games/{id}/expansions is already scoped to one base game, so there
    # it would be the same value on every row.
    base_game_bgg_id: int | None = None


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

    rulebook_url: str | None = None


# ── Mutual buddy graph (migration 008) ────────────────────────────────────────

class BuddyEdgeResponse(BaseModel):
    """An accepted buddy edge from the current user's perspective."""

    id: str
    other_user_id: str
    other_display_name: str
    other_username: str | None = None
    other_avatar: Avatar | None = None
    # The CURRENT USER's private nickname for this buddy, or None. Never
    # populated for the other party: it is read off whichever of
    # boardgamebuddy_buddy_edges.alias_by_a / alias_by_b belongs to the viewer,
    # so each side of an edge sees only the alias it set itself.
    other_alias: str | None = None
    accepted_at: datetime | None = None
    created_at: datetime


class BuddyAliasUpdate(BaseModel):
    """Set or clear the viewer's private alias for one buddy.

    None and a whitespace-only string both mean CLEAR — the client's "Remove
    alias" button and an emptied text field are the same act, and making the
    caller distinguish them would be a second way to say one thing.
    """

    alias: str | None = Field(None, max_length=MAX_BUDDY_ALIAS_CHARS)


class BuddyRequestResponse(BaseModel):
    """A pending buddy request, either incoming or outgoing."""

    id: str
    direction: Literal["incoming", "outgoing"]
    other_user_id: str
    other_display_name: str
    other_avatar: Avatar | None = None
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
    username: str | None = None
    avatar: Avatar | None = None
    relation: Literal["none", "buddies", "outgoing", "incoming", "blocked"] = "none"


# ── Played-with discovery (real accounts + ghost players) ─────────────────────

class PlayedWithUser(BaseModel):
    """A real-account player who appears in plays the viewer is part of."""

    user_id: str
    display_name: str
    avatar: Avatar | None = None
    play_count: int
    is_buddy: bool = False
    has_pending_request: bool = False
    pending_request_direction: Literal["incoming", "outgoing"] | None = None
    # Edge id of the pending request, so the row can offer Cancel (outgoing) or
    # Accept (incoming) without a second /buddies/requests round trip.
    pending_request_id: str | None = None


class GhostPlayer(BaseModel):
    """A free-text nickname the viewer recorded in plays without an account."""

    display_name: str
    play_count: int
    last_played_at: date | None = None


class PendingBuddyEdge(BaseModel):
    """A live buddy request the viewer is a party to, either direction.

    Not an accepted edge and not offered as one: the picker seats these people
    (they have accounts, and the request is evidence they are at the table
    tonight) while the client paints the direction as the row's reason. No
    alias field — an alias needs an accepted edge, so a pending one can never
    carry a nickname to show.
    """

    id: str
    other_user_id: str
    other_display_name: str
    other_username: str | None = None
    other_avatar: Avatar | None = None
    direction: Literal["incoming", "outgoing"]
    created_at: datetime


class PlayPartnersResponse(BaseModel):
    """Everything the Gather player picker needs, in one payload.

    Mirrors the shape Buddy.allBuddies() caches on the FE and the
    `play_partners` block of /bootstrap, so all three read the same thing.
    """

    accounts: list[BuddyEdgeResponse] = []
    # Migration 049. Its own list rather than more `accounts` rows: every
    # surface that reads this bundle paints `accounts` as "your buddies", and
    # these people are not buddies yet.
    pending: list[PendingBuddyEdge] = []
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


class GhostRenameRequest(BaseModel):
    """Fix the spelling of one ghost nickname across the viewer's plays.

    The sibling of GhostMergeRequest, and the same write underneath — but a
    different act. Merge answers "these two ghosts are one person" and picks
    its target from ghosts that already exist; this one answers "I typed it
    wrong", so the new name is free text and a change of CASE alone ("dave" →
    "Dave") is a legitimate edit rather than the no-op merge rejects.
    """

    display_name: str
    new_display_name: str


class GhostRenameResponse(BaseModel):
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
    owner_username: str | None = None
    owner_avatar: Avatar | None = None
    ghost_display_name: str
    # lower(btrim(display_name)) — the claim key. The FE addresses rows by it,
    # so two spellings of one ghost stay one row under the finger.
    ghost_name_key: str
    play_count: int
    last_played_at: date | None = None
    last_game_name: str | None = None
    match_score: float | None = None
    # Set only when the viewer already has a claim on this ghost. A pending one
    # keeps the row visible with a disabled "Requested" chip rather than
    # vanishing; every other status filters the row out server-side.
    claim_status: str | None = None
    claim_id: str | None = None


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
    blocked_reason: str | None = None


class GhostClaimResponse(BaseModel):
    """One claim, from whichever side is looking at it."""

    id: str
    direction: Literal["incoming", "outgoing"]
    # The OTHER party: the claimant on an incoming claim, the owner on an
    # outgoing one. Mirrors BuddyRequestResponse.
    other_user_id: str
    other_display_name: str
    other_username: str | None = None
    other_avatar: Avatar | None = None
    ghost_display_name: str
    play_count: int = 0
    last_played_at: date | None = None
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
    """Result of a player self-removing from one or more plays (turning their
    rows into ghosts). rows_updated is how many seats actually moved — 0 when
    the caller wasn't a player, or when every id named a play they logged
    themselves."""

    rows_updated: int


# ── Notifications: things that happened TO you ────────────────────────────────

class Notification(BaseModel):
    """One row on the unified notifications feed.

    Three kinds share one row shape, one cursor and one read watermark, which is
    the whole point: a feed assembled client-side from three endpoints cannot
    page, and would need three unread counts to add up to one dot.

    `kind` says which block below is populated. `actor_*` is the only group
    present on every kind, because "who did this" is the one question all three
    answer — a play_link's actor logged the play, a buddy_request's sent it, a
    buddy_accepted's said yes.

    On a play_link row, an entry is not a play but one act of linking, and
    `play_group` says which grouping produced it. `play_id` is the entry's
    representative — the most recent play in it, which is what the card names
    and opens — while `play_ids` holds the whole set. The unlink does NOT send
    that set back for a batch: `import_batch_id` does the job in one field, so
    a 214-play import is one tick and one short request.
    """

    entry_key: str
    kind: NotificationKind
    occurred_at: datetime
    is_unread: bool = False

    actor_id: str | None = None
    actor_display_name: str | None = None
    actor_username: str | None = None
    actor_avatar: dict[str, Any] | None = None

    # PLAY_LINK only. Every field in this block is None on a buddy row —
    # play_ids included, rather than an empty list: one rule with no exception
    # is what lets a reader check `kind` and stop thinking about it.
    play_group: PlayLinkGroup | None = None
    play_id: str | None = None
    play_ids: list[str] | None = None
    group_count: int | None = None
    game_count: int | None = None
    played_from: date | None = None
    played_to: date | None = None
    game_id: str | None = None
    game_name: str | None = None
    game_thumbnail_url: str | None = None
    import_batch_id: str | None = None

    # BUDDY_REQUEST / BUDDY_ACCEPTED only. The edge id POST /buddies/{id}/accept
    # and /reject take, so a request can be answered where it is read. Those
    # routes 409 an edge that is no longer pending, which is the correct answer
    # for a derived feed — somebody may have accepted from the Buddies screen
    # while this list was open — and the client treats it as "already handled,
    # drop the row" rather than as an error.
    edge_id: str | None = None


class NotificationsResponse(BaseModel):
    """A page of notifications plus the unread total.

    `unread` counts every unread row the account has, not just this page — it
    feeds the header bell's dot, which has to be right before anything is
    scrolled.

    The cursor is a PAIR. Three sources feeding one ordering makes ties on
    `occurred_at` ordinary rather than rare, and a cursor that is not total
    skips rows at every tie, so `next_cursor_key` carries the last row's
    `entry_key` as the tiebreak. Both are None at the end of the list.
    """

    items: list[Notification]
    next_cursor: datetime | None = None
    next_cursor_key: str | None = None
    unread: int = 0


class NotificationsSeenRequest(BaseModel):
    """How far the client actually read.

    Sending the newest `occurred_at` the client was shown, rather than letting
    the server use now(), is what stops a notification that arrives between the
    list request and this call from being marked seen without ever having been
    displayed.
    """

    through: datetime | None = None


class NotificationsSeenResponse(BaseModel):
    """The watermark that now stands, after the monotonic merge."""

    seen_at: datetime
    unread: int = 0


class LinkUnlinkRequest(BaseModel):
    """What to remove yourself from — plays, runs, or whole imports.

    All three lists are optional but at least one must be non-empty, or the
    request is a no-op that reads like a bug. Capped because the body is the
    only thing bounding the UPDATE; a batch id stands in for its whole import,
    so the caps bound the request, not what one tap can undo.
    """

    play_ids: list[str] = Field(default_factory=list, max_length=500)
    import_group_ids: list[str] = Field(default_factory=list, max_length=200)
    import_batch_ids: list[str] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def _at_least_one(self) -> "LinkUnlinkRequest":
        if not (self.play_ids or self.import_group_ids or self.import_batch_ids):
            raise ValueError("Name at least one play, run or import to unlink from.")
        return self


# ── Public profile view (Strava-style) ────────────────────────────────────────

class PublicProfileResponse(BaseModel):
    """Always 200 — profiles are fully public per product decision."""

    id: str
    display_name: str
    username: str
    avatar: Avatar | None = None
    created_at: datetime
    # Whether the viewer has an accepted mutual edge with this profile. The FE
    # uses this to swap the "Add buddy" button for an "Unfriend" affordance.
    is_buddy: bool = False
    # Whether a pending request exists in either direction. FE shows
    # "Request sent" / "Accept request" instead of "Add buddy".
    has_pending_request: bool = False
    pending_request_direction: Literal["incoming", "outgoing"] | None = None
    # Edge id of that pending request. The relation button needs it to cancel
    # an outgoing request (or accept an incoming one) in place.
    pending_request_id: str | None = None


class FavoriteGame(BaseModel):
    """The game the viewer has played the most. None when no plays exist."""

    game_id: str
    name: str
    play_count: int


class StatsResponse(BaseModel):
    total_plays: int = 0
    unique_games: int = 0
    win_count: int = 0
    last_played_at: date | None = None
    hours_played: float = 0.0
    # owned_games excludes expansions — the count the user thinks of as
    # "my games". owned_expansions is the secondary counter for box clutter.
    owned_games: int = 0
    owned_expansions: int = 0
    favorite_game: FavoriteGame | None = None


# ── Play sessions (short-code lobby) ──────────────────────────────────────────

class SessionParticipantResponse(BaseModel):
    id: str
    user_id: str | None = None
    display_name: str
    joined_at: datetime
    avatar: Avatar | None = None
    # The side this seat is on, free text as the host typed it (migration 050).
    # None on every competitive and co-op lobby, and on a team lobby whose sides
    # were never named — which is also every row written before that migration,
    # so the default is what keeps an old session valid. This is the only way a
    # spectator learns the pairings: their mirror holds no local draft, and
    # until it existed a team night looked like six identical columns to
    # everyone but the host.
    team: str | None = None


class SessionScoreRow(BaseModel):
    """One cell of the live grid, keyed by roster row (migration 053)."""

    participant_id: str
    round_index: int
    score: int | None = None


class SessionResponse(BaseModel):
    id: str
    code: str
    status: PlaySessionStatus
    # Host-driven cursor through the Gather → Play → Settle Up flow
    # (migration 026). Defaults to gather for legacy rows that pre-date
    # the column.
    phase: SessionPhase = SessionPhase.GATHER
    host_user_id: str
    game_id: str | None = None
    game: GameSummary | None = None
    participants: list[SessionParticipantResponse] = []
    # Live grid snapshot, populated only while phase='play' (migration 054).
    # A spectator who joined after Gather has no participant row, so the
    # scores table's RLS SELECT policy returns them nothing and Realtime is
    # silent for them; this is how their mirror gets the host's scores. Empty
    # (never absent) in every other phase.
    scores: list[SessionScoreRow] = []
    created_at: datetime
    expires_at: datetime
    finalized_play_id: str | None = None
    # The scoring grid the host applied to this lobby (migration 018). This is
    # the only way the labels reach a spectator: their mirror holds no local
    # draft and sizes itself from `scores` above.
    scoring_template: PlayScoringTemplate | None = None
    # How the host is scoring this table (migration 050). None = never said,
    # which every session written before that migration is, and which both ends
    # read as competitive. Not cosmetic: it is the gate on whether a side's
    # seats merge into ONE grid column, so a mirror without it would draw a
    # team night as separate columns while the host's screen drew it as sides.
    play_mode: PlayMode | None = None


class SessionCreate(BaseModel):
    game_id: str | None = None


class SessionScoringTemplateUpdate(BaseModel):
    """Body for PATCH /sessions/{code}/scoring-template.

    null clears the template, which is non-destructive — the rows and their
    scores stay, only the labels go.
    """

    template: PlayScoringTemplate | None = None


class SessionUpdateBody(BaseModel):
    # Currently the only field a host may change on an open lobby. Sent as
    # null when clearing the pick, set to a game UUID when (re)selecting one.
    game_id: str | None = None


class SessionPhaseUpdate(BaseModel):
    phase: SessionPhase


class SessionJoinBody(BaseModel):
    # Used only when the caller is not authenticated (guest join). When a real
    # user joins, the display_name is taken from their profile and this field
    # is ignored.
    display_name: str | None = None


class SessionAddParticipantBody(BaseModel):
    # Host-only "add to lobby" body. Pass user_id when adding a real-account
    # buddy; leave it null when adding a ghost (name-only) player. display_name
    # is required either way — for accounts it's the live display name as the
    # host knows them (idempotent dedup matches on user_id, not name).
    user_id: str | None = None
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


class SessionTeamsBody(BaseModel):
    """Host-only "publish the team setup" body: how the table is being scored,
    and the WHOLE {participant_id: tag} map.

    One body rather than two endpoints because the two are one fact on the
    client. A side's seats share a single cell in the scoring grid, and that
    merge is gated on the mode — a mirror holding the tags but not the mode
    would draw a grid the host's own screen is not drawing.

    `teams` is a full replacement, not a patch. A participant the map omits has
    their tag cleared, which is how a side the host deletes — or a whole set of
    tags abandoned when they switch the game type back to competitive — stops
    banding every spectator's grid. The host's draft is the only place a tag is
    ever typed, so the map is always complete with respect to it.

    Tags normalize the way PlayerEntry.team does: trimmed, and "" stored as
    NULL. That blank is the common case rather than an edge one — PlaySession
    seeds every seat with team:"" and writes "" back when a tag is cleared, so
    without it every untagged seat would share one anonymous side.
    """

    play_mode: PlayMode | None = None
    teams: dict[str, str | None] = Field(default_factory=dict)

    @field_validator("teams")
    @classmethod
    def _normalize_tags(cls, v: dict[str, str | None]) -> dict[str, str | None]:
        if len(v) > 64:
            raise ValueError("too many participants")
        out: dict[str, str | None] = {}
        for pid, tag in v.items():
            tag = (tag or "").strip()
            if len(tag) > MAX_PLAY_TEAM_CHARS:
                raise ValueError(
                    f"team tag longer than {MAX_PLAY_TEAM_CHARS} characters"
                )
            out[pid] = tag or None
        return out


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
    host_avatar: Avatar | None = None
    game: GameSummary | None = None
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
    collection_status: str | None = None


class UnifiedSearchResponse(BaseModel):
    results: list[UnifiedSearchHit] = []
    # Always present; only populated when include_bgg=true was passed.
    bgg_results: list[BggSearchResult] = []
    # True when the caller passed include_bgg=true (regardless of whether BGG
    # actually returned anything). Lets the FE tell "BGG fetched but empty"
    # apart from "BGG not requested".
    bgg_searched: bool = False


class CatalogIndexRow(BaseModel):
    """One base game, as little of it as a search row needs to PAINT.

    Short keys on purpose: this row is emitted once per game in the catalog
    and the count is what sets the payload size, so every byte of key name is
    paid thousands of times. The client (domain/catalog-index.js) widens these
    back into GameSummary field names on receipt.
    """
    id: str
    name: str
    # year_published
    y: int | None = None
    # min_players / max_players / playing_time
    mn: int | None = None
    mx: int | None = None
    t: int | None = None
    # thumbnail_url — a PATH relative to `thumb_base` when the cover is on the
    # configured R2 origin (almost all of them), the absolute URL otherwise.
    th: str | None = None


class CatalogIndexResponse(BaseModel):
    """Every base game in the catalog, in one response, for client-side search."""
    games: list[CatalogIndexRow] = []
    count: int = 0
    # True when the catalog outgrew the hard row cap and `games` is a prefix.
    # The client must then treat the index as advisory and keep /search.
    truncated: bool = False
    # Origin to prepend to a relative `th` (no trailing slash). Empty when
    # covers are not re-hosted, in which case every `th` is absolute.
    thumb_base: str = ""
    generated_at: str


# ── Feed cards ────────────────────────────────────────────────────────────────

class FeedPlayUser(BaseModel):
    id: str
    display_name: str
    avatar: Avatar | None = None


class FeedPlayParticipant(BaseModel):
    user_id: str
    display_name: str


class FeedReactor(BaseModel):
    """One person who said good game to a play (migration 016)."""

    user_id: str
    display_name: str | None = None
    avatar: Avatar | None = None


class FeedPlayCard(BaseModel):
    kind: Literal[FeedCardKind.PLAY] = FeedCardKind.PLAY
    play_id: str
    user: FeedPlayUser
    game: GameSummary
    played_at: date
    created_at: datetime
    notes: str | None = None
    photo_url: str | None = None
    play_mode: PlayMode = PlayMode.COMPETITIVE
    winner_display_name: str | None = None
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
    import_group_id: str | None = None
    # The paste this play came from (migration 007, on the feed payload since
    # 022), or None for a live log. The feed groups imported plays by
    # (played_at, LOGGER) rather than by roster, so one afternoon's import is
    # one section instead of one per permutation of who was at the table — and
    # `import_group_id` cannot answer "was this imported", because the importer
    # sets it only on plays it found indistinguishable from another in the same
    # paste. Every one-off in a paste carries a batch id and no group id.
    import_batch_id: str | None = None
    # ── Migration 015 — the whole play, so the card's other two faces are free.
    #
    # The front paints from the fields above; the back and the detail popup each
    # used to call GET /plays/{id} on open, which cost a spinner on every first
    # flip and fetched the same row twice when a user flipped and then maximised.
    #
    # `players` is the full, UNFILTERED scorecard — every seat including ghosts,
    # with score and round_scores — and is deliberately NOT a replacement for
    # `participants` above. The two have different filters because they answer
    # different questions: `participants` is the session grouping key and the
    # source of the clickable names in the feed's session header, so it stays
    # limited to people the viewer can navigate to; `players` is the scoreboard.
    #
    # Same shape as PlayResponse's own fields, so the client adapts a feed card
    # into a play with a rename and no reshaping.
    players: list[PlayPlayerResponse] = []
    expansions: list[PlayExpansionRef] = []
    country_code: str | None = None
    # ── Migration 031 — the play's frozen copy of the chapter's scoring grid.
    #
    # Same field as PlayResponse.scoring_template, and here for the same reason
    # the roster is: the detail popup paints synchronously from a seed projected
    # off this card, and without the template that first paint gets the round
    # grid wrong — no Rounds section at all on a single-round play, generic
    # R1..Rn labels on a multi-round one — so the confirming render after
    # GET /plays/{id} had to repaint the whole card.
    #
    # Defaults to None so a database still on the pre-031 RPC serves cards
    # without it, exactly as today, rather than erroring.
    scoring_template: PlayScoringTemplate | None = None
    # ── Migration 016 — the "Good game" reaction.
    #
    # Per PLAY, though the UI draws it per session: a feed session is grouped
    # client-side off `played_at | participants`, and participants is filtered
    # per viewer, so no two viewers agree on a session key and there is nothing
    # stable to store. The footer aggregates these across the night's cards.
    #
    # `reactors` is capped at 8 by the RPC because the footer draws three
    # avatars; `reaction_count` is the exact total and is what the number comes
    # from, so the cap can never make the count wrong.
    reaction_count: int = 0
    viewer_reacted: bool = False
    reactors: list[FeedReactor] = []


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
    avatar: Avatar | None = None
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
    via_user_id: str | None = None
    via_display_name: str | None = None
    # Which tier the candidate came from (migration 063). Only the onboarding
    # endpoint sets it — the Feed rail and GET /buddies/suggested return
    # earned-signal candidates exclusively, so their counts already say why a
    # suggestion is there. None means "derive the reason from the counts",
    # which is what every pre-060 caller of the shared tile does.
    source: BuddySuggestionSource | None = None


class FeedSuggestedBuddiesCard(BaseModel):
    kind: Literal[FeedCardKind.SUGGESTED_BUDDIES] = FeedCardKind.SUGGESTED_BUDDIES
    suggestions: list[FeedSuggestedBuddy]


FeedCard = Union[
    FeedPlayCard,
    FeedHotGamesCard,
    FeedSuggestedBuddiesCard,
]


# ── Web Push ─────────────────────────────────────────────────────────────────


class PushConfigResponse(BaseModel):
    """What the client needs before it can subscribe.

    `enabled` is not derivable client-side: with no VAPID keys configured the
    server cannot sign a push, so the Settings card must render its "not
    available" state rather than offering a control that would take a
    permission prompt and then silently never deliver anything.
    """

    enabled: bool
    vapid_public_key: str | None = None


class PushSubscriptionCreate(BaseModel):
    """One device's subscription, straight from PushSubscription.toJSON().

    Shaped to what the browser hands over rather than to the table, so the
    client posts what it has without reshaping it.
    """

    endpoint: str = Field(..., min_length=1, max_length=2048)
    p256dh: str = Field(..., min_length=1, max_length=256)
    auth: str = Field(..., min_length=1, max_length=256)
    user_agent: str | None = Field(None, max_length=512)


class PushSubscriptionDelete(BaseModel):
    """The device to forget. Identified by endpoint, which is what the browser
    holds — a client has no idea what row id we gave it."""

    endpoint: str = Field(..., min_length=1, max_length=2048)


class PlayReactionRequest(BaseModel):
    """The plays a single tap covers.

    A list rather than one id because the surface is the SESSION footer: one tap
    reacts to every play of that night at once. One play is just a list of one,
    which is what a future per-card control would send.

    Capped because the list is unbounded work: one request inserts one row per
    id and filters the plays with a single `in_()`, so nothing but this bound
    stops a client asking for either at any size. 100 is far above any real
    game night — the neighbouring bulk requests cap at 200-500 for the same
    reason.
    """

    play_ids: list[str] = Field(..., max_length=100)


class PlayReactionResponse(BaseModel):
    """What the write actually touched, so the client can reconcile.

    `play_ids` echoes only the plays that were affected — the caller's OWN plays
    are dropped server-side (you do not congratulate yourself), so this can be
    shorter than what was sent, and an optimistic client needs to know which.
    """

    play_ids: list[str]
    reacted: bool
    # Null on a delete. One id per tap, shared by every row it wrote.
    reaction_group_id: str | None = None


class FeedPageResponse(BaseModel):
    cards: list[FeedCard]
    # Composite "played_at|created_at" of the last play on this page; null =
    # no more pages. The FE round-trips this string back as ?cursor=… on the
    # next call (no parsing required).
    next_cursor: str | None = None


class HotGamesResponse(BaseModel):
    games: list[FeedHotGamesEntry] = []
    window_days: int


class SuggestedBuddiesResponse(BaseModel):
    suggestions: list[FeedSuggestedBuddy] = []


# ── Discover ──────────────────────────────────────────────────────────────────
# One bundle for the whole tab (GET /discover), assembled by
# services/discovery_service.build_bundle. Four sections, each independently
# empty-able, so a BGG outage or a brand-new account degrades one rail rather
# than the screen.

class DiscoverPick(BaseModel):
    """One "Picked for you" tile: the game plus the reason it is there."""
    game: GameSummary
    reason_kind: DiscoverReasonKind
    # The one line the tile shows — "Because you play Wingspan". Formatted
    # server-side by discovery_service.format_reason so there is one writer;
    # the client never composes it from the fields below.
    reason_label: str
    reason_game_id: str | None = None
    shared_mechanics: list[str] = []
    shared_categories: list[str] = []
    # True when the viewer had no shelf and no plays to profile, so this row
    # is a catalog-rank fallback rather than a personal pick.
    cold_start: bool = False


class DiscoverTrendingEntry(BaseModel):
    """One row of BGG's hot list. `game` is None when the catalog does not
    have it yet — the tile renders from the BGG fields and a tap imports."""
    bgg_id: int
    rank: int
    name: str
    year_published: int | None = None
    thumbnail_url: str | None = None
    game: GameSummary | None = None
    # From bgb_bgg_hot_latest (migration 039): where the game sat in the run
    # ~a day earlier. rank_delta positive = climbing; None when there is no
    # comparison run or the game was not in it. is_new = absent from the
    # comparison run. Both None/False on the live-/hot fallback.
    rank_delta: int | None = None
    is_new: bool = False


class DiscoverDormantEntry(BaseModel):
    """An owned game the viewer has not played in a while. last_played_at is
    None when they have never logged it at all."""
    game: GameSummary
    last_played_at: date | None = None


class HotRefreshResult(BaseModel):
    """What one POST /discover/admin/refresh-trending did."""
    captured_at: datetime
    items: int                     # rows written for this run
    imported: int                  # hot games the catalog lacked and now has
    skipped: list[int] = []        # bgg_ids still missing after the per-run import cap
    failed: list[int] = []         # bgg_ids whose import raised
    pruned: int = 0                # snapshot rows older than the retention window


class DiscoverBundleResponse(BaseModel):
    picks: list[DiscoverPick] = []
    trending: list[DiscoverTrendingEntry] = []
    # BGG did not answer. The picks still paint; the trending rail shows its
    # own error branch instead of the whole tab failing.
    trending_error: bool = False
    new_this_year: list[GameSummary] = []
    new_year: int
    back_on_shelf: list[DiscoverDormantEntry] = []
    dormant_days: int
    generated_at: datetime


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
    unlocked_at: datetime | None = None


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
    hint: str | None = Field(None, max_length=MAX_IMPORT_HINT_CHARS)
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
    score: int | None = None


class ParsedPlay(BaseModel):
    """One play the model found — or `count` identical repeats of it.

    `count` is what keeps a 106-play tally note inside one small reply: the
    model writes the run once and says how long it is, and the client expands
    it into individual draft plays.
    """

    game: str
    played_at: date | None = None
    count: int = 1
    notes: str | None = None
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
    id: str | None = None
    # True when this play's client_key was already stored — a retry of a chunk
    # whose response was lost, which is what makes resuming an import safe.
    duplicate: bool = False
    error: str | None = None


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
    imported_at: datetime | None = None
    play_count: int = 0
    game_count: int = 0
    # Capped at four in the RPC — a batch spanning fifteen games would push a
    # paragraph into a settings row. `game_count` beside it stays exact.
    game_names: list[str] = []
    first_played_at: date | None = None
    last_played_at: date | None = None


class PlayImportListResponse(BaseModel):
    imports: list[PlayImportSummary] = []


class PlayImportRunItem(BaseModel):
    """One row of an import's contents: a RUN of identical plays, or a one-off.

    Collapsed on COALESCE(import_group_id, id), so a one-off is a run of one
    and the client needs no branch between the two cases. The importer sets a
    group id only on plays it judged indistinguishable from another in the same
    paste, so every one-off in a batch arrives here with `import_group_id`
    None — and `group_count` 1 — rather than being left out.

    `play_id` is the group's representative: the LOWEST id in it, the rule
    bgb_plays_page and bgb_feed_plays already use. That matters because it is
    what makes the play this row opens the same play those surfaces show, so a
    `play-changed` echo patches the same row everywhere.
    """

    play_id: str
    import_group_id: str | None = None
    group_count: int = 1
    game_id: str
    game_name: str
    game_thumbnail: str | None = None
    played_at: date
    notes: str | None = None
    players: list[PlayPlayerResponse] = []


class PlayImportDetailResponse(BaseModel):
    """One import and what it wrote — the imports spoke's drill-down.

    `batch` is the SAME PlayImportSummary the list endpoint hands back, not a
    second shape saying the same things: the spoke's index row and its detail
    header render from one model, so they cannot drift.
    """

    batch: PlayImportSummary
    runs: list[PlayImportRunItem] = []


# ── Data export ───────────────────────────────────────────────────────────────

class ExportDatasetInfo(BaseModel):
    """One tickable row on the export sheet.

    `row_count` is what makes the sheet worth reading rather than a list of
    abstract nouns — "Plays · 214" tells someone whether the tick is worth
    making, and a zero tells them there is nothing there without downloading a
    zip to find out. It counts TOP-LEVEL records, not every row the tick
    writes: a play's seats are children of the play, so Plays reports plays and
    not seats, while buddies and ghost players are siblings and are summed.

    `files` names what the tick actually puts in the archive, so the relational
    fan-out (a play plus its roster) is stated up front rather than being a
    surprise inside the zip.
    """

    id: ExportDataset
    label: str
    blurb: str
    row_count: int = 0
    files: list[str] = []


class ExportManifestResponse(BaseModel):
    """Everything the export sheet needs to paint itself, in one call."""

    datasets: list[ExportDatasetInfo] = []


# ── Dev feedback board ────────────────────────────────────────────────────────

class FeedbackOptionResponse(BaseModel):
    """One row of either lookup table — a type or a topic.

    Shaped identically to ChapterTypeResponse because it is the same kind of
    thing: a seeded option the client renders by label and icon rather than
    hardcoding. `icon` is a Lucide slug into web/ui/icons.js, never an emoji.
    """

    id: str
    label: str
    icon: str | None = None
    display_order: int


class FeedbackCreate(BaseModel):
    """A new item for the board.

    `feedback_type` and `topic` are plain strings validated against their lookup
    tables at write time rather than enums, because the option sets live in the
    database and adding one must not need a deploy. The route raises 400 on an
    unknown id — same shape as _validate_chapter_type.
    """

    feedback_type: str
    topic: str
    # min_length=1 as well as the cap: the client trims before sending, and a
    # body of spaces is not feedback. The route strips again rather than trusting
    # it, since this model is also the API's public contract.
    body: str = Field(..., min_length=1, max_length=MAX_FEEDBACK_BODY_CHARS)


class FeedbackResponse(BaseModel):
    """One board row, as bgb_feedback_list returns it.

    The type and topic display fields ride along denormalised so the list paints
    from one round trip — the client never has to join against the lookup
    endpoints to render a row.

    `viewer_liked` is computed against the caller, so the like button knows its
    own state without a second read, and `like_count` is aggregated in SQL rather
    than stored on the item.
    """

    id: str
    user_id: str
    author_name: str | None = None
    feedback_type: str
    feedback_type_label: str | None = None
    feedback_type_icon: str | None = None
    topic: str
    topic_label: str | None = None
    topic_icon: str | None = None
    body: str
    status: FeedbackStatus
    resolved_at: datetime | None = None
    resolver_name: str | None = None
    created_at: datetime
    like_count: int = 0
    viewer_liked: bool = False


class FeedbackLikeResponse(BaseModel):
    """What a like toggle settled on, so an optimistic client can reconcile.

    Both the flag and the fresh count come back: the client painted its own
    guess before the request went out, and reconciling against a server-counted
    total is what keeps two people liking the same item at once from leaving
    either of them one behind.
    """

    feedback_id: str
    liked: bool
    like_count: int
# ── Release notices ───────────────────────────────────────────────────────────

class ReleaseNotice(BaseModel):
    """One admin-authored what's-new note.

    `published_at is None` IS the draft flag — there is no separate status
    field, here or in the table (migration 042). The same timestamp is the sort
    key and the unit `profiles.release_notices_seen_at` compares against.
    """

    id: str
    title: str
    body_md: str
    link_route: str | None = None
    link_label: str | None = None
    published_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @computed_field
    @property
    def published(self) -> bool:
        """Sugar for the admin list, which shows drafts and published together."""
        return self.published_at is not None


class ReleaseNoticeListResponse(BaseModel):
    """Both list endpoints return this — the archive and the admin list."""

    items: list[ReleaseNotice] = []


class ReleaseNoticeWriteRequest(BaseModel):
    """A new notice. Always created as a draft.

    `published_at` is deliberately absent: publishing is its own act with its
    own route, never a field the client sets. A caller-supplied timestamp could
    be backdated, which would sort the notice behind watermarks users already
    hold and make it invisible to exactly the people it was written for.
    """

    title: str = Field(min_length=1, max_length=MAX_RELEASE_NOTICE_TITLE_CHARS)
    body_md: str = Field(min_length=1, max_length=MAX_RELEASE_NOTICE_BODY_CHARS)
    link_route: str | None = Field(
        default=None, max_length=MAX_RELEASE_NOTICE_LINK_ROUTE_CHARS
    )
    link_label: str | None = Field(
        default=None, max_length=MAX_RELEASE_NOTICE_LINK_LABEL_CHARS
    )


class ReleaseNoticePatchRequest(BaseModel):
    """An edit. Every field optional, but an empty body is a no-op that reads
    like a bug, so it is refused the way LinkUnlinkRequest refuses one."""

    title: str | None = Field(
        default=None, min_length=1, max_length=MAX_RELEASE_NOTICE_TITLE_CHARS
    )
    body_md: str | None = Field(
        default=None, min_length=1, max_length=MAX_RELEASE_NOTICE_BODY_CHARS
    )
    link_route: str | None = Field(
        default=None, max_length=MAX_RELEASE_NOTICE_LINK_ROUTE_CHARS
    )
    link_label: str | None = Field(
        default=None, max_length=MAX_RELEASE_NOTICE_LINK_LABEL_CHARS
    )
    # Distinguishes "leave the link alone" from "clear the link": an absent key
    # is the former, `clear_link: true` the latter. Without it a notice's link
    # could be set but never removed, since None is also the absent value.
    clear_link: bool = False

    @model_validator(mode="after")
    def _at_least_one(self) -> "ReleaseNoticePatchRequest":
        if not (
            self.title
            or self.body_md
            or self.link_route
            or self.link_label
            or self.clear_link
        ):
            raise ValueError("Name at least one field to change.")
        return self


class ReleaseNoticesSeenRequest(BaseModel):
    """How far the popup actually got.

    Sending the newest `published_at` the client was SHOWN, rather than letting
    the server use now(), is what stops a notice published between /bootstrap
    and this call from being marked seen without ever having been on screen.
    That race is ordinary rather than contrived here — the admin publishes from
    inside this same app.
    """

    through: datetime | None = None


class ReleaseNoticesSeenResponse(BaseModel):
    """The watermark that now stands, after the monotonic merge."""

    seen_at: datetime


# ── Board Game Arena import (migration 043) ──────────────────────────────────
#
# The wizard's third source. Everything here is REQUEST/RESPONSE shape only —
# what BGA's own wire looks like lives in routes/bga_endpoints.py, which is
# quarantined on purpose.
#
# One rule governs the whole block: no model below carries `bga_password_enc`
# or `bga_session_cookies`, ever. api/tests/test_bga_secrets.py asserts it,
# because "we forgot to leave the cookies out of a response" is the kind of
# mistake that reads fine in review.


class BgaLinkRequest(BaseModel):
    """Credentials for the wizard's account step.

    SecretStr so the password cannot be printed by an accidental repr of the
    request — the same guard BggLinkRequest uses.
    """

    username: str = Field(min_length=1, max_length=120)
    password: SecretStr


class BgaLinkStatus(BaseModel):
    """Whether a BGA account is linked, and what the account step should say."""

    bga_username: str | None = None
    bga_player_id: str | None = None
    auth_state: BgaAuthState = BgaAuthState.UNLINKED
    last_import_at: datetime | None = None


class BgaDraftSeat(BaseModel):
    """One chair at an imported table.

    `handle` is the BGA username, which is all BGA gives about an opponent —
    there is no email and no other identifier, which is why the wizard
    remembers handle→person mappings rather than matching on anything else.

    `is_winner` is derived from BGA's own `rank == 1`, not from the scores:
    re-deriving it would disagree with the site on every game where the low
    score wins. Both stay editable in the shared review.
    """

    handle: str
    score: int | None = None
    rank: int | None = None
    is_winner: bool = False


class BgaDraftTable(BaseModel):
    """One finished BGA table, as a play the user has not yet agreed to."""

    bga_table_id: int
    game_name: str = ""
    bga_game_id: str | None = None
    played_at: date | None = None
    seats: list[BgaDraftSeat] = []


class BgaHandleMatch(BaseModel):
    """Who the server thinks a BGA handle is, and on what evidence.

    `reason` is carried so the wizard can LABEL A SUGGESTION BY ITS REASON
    rather than by a score (.claude/rules/web-frontend.md): "Matched before"
    and "@handle is Marcus Chen on BoardgameBuddy" are different claims and
    deserve different words.

    REMEMBERED and VIEWER are safe to apply silently. CROSS_ACCOUNT is not —
    it is somebody else's claim about a shared username — so it is returned as
    a suggestion the wizard shows as undoable, never pre-applied.
    """

    handle: str
    reason: BgaMatchReason = BgaMatchReason.NONE
    player_user_id: str | None = None
    player_display_name: str | None = None
    username: str | None = None
    avatar: dict[str, Any] | None = None


class BgaFetchResponse(BaseModel):
    """Everything the wizard needs to open its Players step, in one call.

    `games` is the same ParsedGameRef list the note importer's parse returns,
    produced by the same play_import_service.match_games, so the Games step
    renders identically for both sources and there is no second round trip.
    """

    tables: list[BgaDraftTable] = []
    handles: list[BgaHandleMatch] = []
    games: list[ParsedGameRef] = []
    # Tables seen in the history that are already in this account's plays.
    # Reported rather than hidden: "12 you already had" is the sentence that
    # makes a second import legible.
    skipped: int = 0
    # A cap was hit and there is older history still on BGA. The wizard says so
    # and offers another run; the history is complete across runs.
    truncated: bool = False


class BgaFetchStep(BaseModel):
    """One row of the sweep's checklist."""

    key: BgaFetchPhase
    state: BgaFetchStepState = BgaFetchStepState.IDLE
    done: int | None = None
    total: int | None = None
    detail: str | None = None


class BgaFetchProgressResponse(BaseModel):
    """The sweep's ledger, polled while it runs.

    UNKNOWN with no steps is the honest answer when this process has no record
    — an in-process ledger, one uvicorn worker, see services/bga_progress.py.
    The FE renders it as "still working", never as done.
    """

    state: BgaFetchState = BgaFetchState.UNKNOWN
    fetch_id: str | None = None
    started_at: datetime | None = None
    updated_at: datetime | None = None
    steps: list[BgaFetchStep] = []
    truncated: bool = False
    error: str | None = None


class BgaPlayerLink(BaseModel):
    """One handle→person mapping the wizard wants remembered."""

    bga_handle: str = Field(min_length=1, max_length=120)
    player_user_id: str | None = None
    player_display_name: str | None = None

    @model_validator(mode="after")
    def _names_somebody(self) -> "BgaPlayerLink":
        """A link that names nobody is not a link.

        Mirrors boardgamebuddy_bga_player_links' identity CHECK, so a payload
        that would violate it is rejected here with a readable 422 rather than
        reaching Postgres as a constraint error.
        """
        display = (self.player_display_name or "").strip()
        if not self.player_user_id and not display:
            raise ValueError("a link must name an account or a display name")
        self.player_display_name = display or None
        return self


class BgaRememberRequest(BaseModel):
    """A batch of mappings to remember, written after a successful import."""

    links: list[BgaPlayerLink] = Field(min_length=1, max_length=200)


class BgaRememberResponse(BaseModel):
    stored: int = 0


# ── Affiliate partners (migration 046) ───────────────────────────────────────
#
# A partner is LIVE only when enabled AND it holds a credential (a tracking
# tag or a wrapper link). `enabled` is never a field on the write model:
# enabling is its own POST, refused without a credential, so a row can never
# be switched on by a stray PATCH.

class AffiliatePartner(BaseModel):
    """One retailer row, as the admin screen sees it."""

    id: str
    label: str
    url_template: str
    wrapper_template: str | None = None
    tracking_tag: str | None = None
    disclosure: str | None = None
    notes: str | None = None
    display_order: int = 0
    enabled: bool = False
    updated_at: datetime | None = None

    @computed_field
    @property
    def has_credential(self) -> bool:
        return bool((self.tracking_tag or "").strip() or (self.wrapper_template or "").strip())

    @computed_field
    @property
    def live(self) -> bool:
        """The one rule every reader-facing path applies."""
        return self.enabled and self.has_credential


class AffiliatePartnerListResponse(BaseModel):
    items: list[AffiliatePartner] = []


class AffiliatePartnerPatchRequest(BaseModel):
    """An edit. Every field optional; an empty body is refused. No `enabled`."""

    label: str | None = Field(default=None, min_length=1, max_length=MAX_AFFILIATE_LABEL_CHARS)
    url_template: str | None = Field(default=None, min_length=8, max_length=MAX_AFFILIATE_TEMPLATE_CHARS)
    wrapper_template: str | None = Field(default=None, max_length=MAX_AFFILIATE_TEMPLATE_CHARS)
    tracking_tag: str | None = Field(default=None, max_length=MAX_AFFILIATE_TAG_CHARS)
    disclosure: str | None = Field(default=None, max_length=MAX_AFFILIATE_DISCLOSURE_CHARS)
    notes: str | None = Field(default=None, max_length=MAX_AFFILIATE_NOTES_CHARS)
    display_order: int | None = Field(default=None, ge=0, le=1000)
    # An absent key means "leave it alone", and None is also the absent value —
    # so clearing a credential needs its own flag (release-notices' clear_link).
    clear_tag: bool = False
    clear_wrapper: bool = False
    clear_disclosure: bool = False

    @model_validator(mode="after")
    def _at_least_one(self) -> "AffiliatePartnerPatchRequest":
        if not any([
            self.label, self.url_template, self.wrapper_template, self.tracking_tag,
            self.disclosure, self.notes, self.display_order is not None,
            self.clear_tag, self.clear_wrapper, self.clear_disclosure,
        ]):
            raise ValueError("Name at least one field to change.")
        return self


class AffiliateLink(BaseModel):
    """One pill on a game page: where it goes and what must be said beside it."""

    partner_id: str
    label: str
    url: str
    disclosure: str | None = None


class AffiliateLinkListResponse(BaseModel):
    """`live` is false with an empty list when no partner is switched on, which
    is what every reader-facing surface renders NOTHING from."""

    game_id: str | None = None
    links: list[AffiliateLink] = []
    live: bool = False


class AffiliateLinkPreview(BaseModel):
    """The admin editor's preview: the URL a partner WOULD produce, live or not."""

    partner_id: str
    game_name: str
    url: str
    live: bool


class AffiliateClickRequest(BaseModel):
    partner_id: str = Field(min_length=2, max_length=40)
    game_id: str | None = None
    surface: AffiliateSurface = AffiliateSurface.GAME_DETAIL


class AffiliateClickCount(BaseModel):
    partner_id: str
    label: str
    clicks: int


class AffiliateClickSummary(BaseModel):
    days: int
    total: int
    by_partner: list[AffiliateClickCount] = []


# ── Admin usage (migration 047) ──────────────────────────────────────────────

class BucketUsage(BaseModel):
    """One R2 bucket's footprint, as `object_store.usage()` reports it.

    `configured` is False for an unset bucket, which is a supported state and
    not an error (local dev has no R2 credentials). `error` carries a listing
    failure for THIS bucket only — the two buckets have separate permissions,
    so one refusing must not hide the other's number. `truncated` means the
    walk hit its page ceiling and the figures are a floor, which the UI renders
    as "at least".
    """

    configured: bool = False
    objects: int = 0
    bytes: int = 0
    truncated: bool = False
    error: str | None = None


class BucketUsageResponse(BaseModel):
    """Both R2 buckets, keyed by object_store's store names (plays / games).

    A plain dict rather than two named fields: the keys are object_store.PLAYS
    and .GAMES, and naming them again here is a second place for that pair to
    drift when a third bucket appears.
    """

    buckets: dict[str, BucketUsage] = {}
