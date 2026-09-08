"""Constants and enums for BoardgameBuddy."""

import os
from enum import StrEnum


# ── Add-a-buddy QR tokens ────────────────────────────────────────────────────
# Signs the short-lived tokens the add-a-buddy QR code encodes (see
# services/buddy_qr_service.py). A dedicated secret rather than a reused app
# one: it is the only thing giving these tokens domain separation, so a token
# minted here can never validate against another endpoint and no other app's
# token validates here. Rotating this value is also the revocation lever — it
# invalidates every outstanding code at once, which is why the tokens
# themselves carry no server-side state.
BGB_QR_SECRET = os.environ.get("BGB_QR_SECRET", "dev-secret-change-me")
QR_TOKEN_ALGORITHM = "HS256"
# Three minutes. Long enough for three people around a table to each get their
# phone out; short enough that a screenshot or a shoulder-surfed photo is worth
# nothing by the time anyone acts on it. The frontend re-mints at 150s so a
# sheet left open never shows a dead code.
QR_TOKEN_TTL_SECONDS = 180


class CollectionStatus(StrEnum):
    OWNED = "owned"
    # Legacy synthetic shelf — derived from boardgamebuddy_plays, never written
    # to boardgamebuddy_collections after migration 010. Kept on the enum so
    # existing /collection endpoints can still serve the "Played" filter while
    # the new Feed/Profile views replace them.
    PLAYED = "played"
    WISHLIST = "wishlist"
    # A game the user sold, gifted or donated (migration 069). Persisted, and
    # deliberately asymmetric: it is a SUBSET OF OWNED for display — the Owned
    # shelf lists it alongside owned games, dimmed and stamped — and NOT OWNED
    # for counting, so every owned total (the Owned tab count, the profile
    # "Owned Games" stat, owned-expansion counts, the Shelf of Shame) skips it.
    # Distinct from deleting the row, which means "this was never mine".
    PREV_OWNED = "prev_owned"


# The statuses a request for the "owned" shelf actually matches. Only the
# surfaces that BUILD the Owned grid use this; every plain `status = 'owned'`
# filter elsewhere is correct as it stands, because prev_owned must not be
# counted as owned. See constants above and migration 069.
OWNED_SHELF_STATUSES: tuple[str, ...] = (
    CollectionStatus.OWNED.value,
    CollectionStatus.PREV_OWNED.value,
)


class BuddyEdgeStatus(StrEnum):
    """Lifecycle of a mutual buddy edge (boardgamebuddy_buddy_edges)."""

    PENDING = "pending"
    ACCEPTED = "accepted"
    BLOCKED = "blocked"


class GhostClaimStatus(StrEnum):
    """Lifecycle of a ghost account claim (boardgamebuddy_ghost_claims, 070).

    Unlike BuddyEdgeStatus this never deletes: the (owner, ghost_name_key,
    claimant) triple is unique, so status mutates in place and reject_count
    survives a re-ask. That is what makes the two-strike rule stick.
    """

    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    # The claimant's "Not me" — suppresses the suggestion without telling the
    # owner anything. Reversible: a later claim flips the same row to pending.
    DISMISSED = "dismissed"
    # Another claimant's accept took the ghost. The rows this claim points at
    # no longer exist, so it can never succeed.
    SUPERSEDED = "superseded"


class BuddySuggestionSource(StrEnum):
    """Why a buddy suggestion is in the list (migration 063).

    The onboarding "Add buddies" step ranks two tiers of candidate, and the
    tile's reason line can't be derived from the counts alone: an ACTIVE
    candidate carries mutual_count = 0 and play_count = 0, which the shared
    rail would otherwise label "Mutual buddy". The tier is the label."""

    # An earned signal — a shared play or a shared accepted buddy. The same
    # candidates bgb_suggested_buddies returns for the Feed rail.
    GRAPH = "graph"
    # Community fallback: people logging plays lately. Only the onboarding
    # step uses this tier, because a brand-new account has no earned signal
    # to rank on and an empty discovery screen is the failure case there.
    ACTIVE = "active"
    # A candidate promoted client-side out of the preloaded second hop
    # (migration 072): a buddy of someone the user has just ticked. Never
    # returned in the top-level `suggestions` list — the server sets it on the
    # rows inside `network`, and the deck renders them when that tick happens.
    NETWORK = "network"


# How many of each suggestion's buddies to preload, and the ceiling on the
# whole second hop. 12 suggestions × 6 is 72 rows before the total bites, and
# the endpoint ships a profile for every one it returns — so the pair is the
# payload budget for the onboarding step, not a ranking knob.
ONBOARDING_NETWORK_PER_SEED = 6
ONBOARDING_NETWORK_LIMIT = 48


class PlaySessionStatus(StrEnum):
    """Lifecycle of a short-code play-logging session."""

    OPEN = "open"
    FINALIZED = "finalized"
    ABANDONED = "abandoned"


class SessionPhase(StrEnum):
    """Host-driven cursor through the Gather → Play → Settle Up flow
    (migration 026). Joiners watch this via Supabase Realtime and auto-
    advance their read-only mirror when the host moves forward."""

    GATHER = "gather"
    PLAY = "play"
    SETTLE = "settle"
    FINALIZED = "finalized"
    ABANDONED = "abandoned"


# Allowed phase transitions. Forward moves drive the host through the
# guided flow; one-step backward moves let the host bounce back to a
# previous step (Play → Gather, Settle → Play) when they tap the
# top-left back arrow. Terminal states (finalized / abandoned) are
# absorbing — no resurrections.
ALLOWED_PHASE_TRANSITIONS: dict[SessionPhase, frozenset[SessionPhase]] = {
    SessionPhase.GATHER: frozenset({SessionPhase.PLAY, SessionPhase.ABANDONED}),
    SessionPhase.PLAY: frozenset(
        {SessionPhase.GATHER, SessionPhase.SETTLE, SessionPhase.ABANDONED}
    ),
    SessionPhase.SETTLE: frozenset(
        {SessionPhase.PLAY, SessionPhase.FINALIZED, SessionPhase.ABANDONED}
    ),
    SessionPhase.FINALIZED: frozenset(),
    SessionPhase.ABANDONED: frozenset(),
}


class FeedCardKind(StrEnum):
    """Card types the Feed view can render."""

    PLAY = "play"
    HOT_GAMES = "hot_games"
    SUGGESTED_BUDDIES = "suggested_buddies"


class NotificationKind(StrEnum):
    """What one row on the notifications feed is about.

    The feed is a UNION of three derived sources rather than a table — see
    bgb_notifications, migration 009 — and each member names both its source
    and the timestamp it is ordered by: PLAY_LINK from play_players.linked_at,
    BUDDY_REQUEST from buddy_edges.created_at, BUDDY_ACCEPTED from
    buddy_edges.accepted_at. The kind also says which block of optional fields
    on the Notification model is populated.

    "Good game" reactions are deliberately NOT here. They live on the feed card
    that earned them and nowhere else — see reaction_service.

    ADDING A MEMBER IS A DEPLOY-ORDER CONSTRAINT, not just an edit. Notification
    .kind is typed by this enum, so a row carrying a value the running backend
    does not know fails model_validate and 500s the whole page — and that page
    is /notifications AND the /bootstrap gather. Ship the enum first, then the
    migration that starts emitting the value.
    """

    PLAY_LINK = "play_link"
    BUDDY_REQUEST = "buddy_request"
    BUDDY_ACCEPTED = "buddy_accepted"


# ── Web Push (migration 017) ─────────────────────────────────────────────────
# VAPID identifies THIS server to the push services, which is what lets a
# browser's subscription be bound to us and to nobody else. Three values, all
# unset in local dev by default — push_service.enabled() reads that as "the
# feature is off" and every send returns immediately, so the app runs complete
# and unbroken with no keys anywhere.
#
# Generate a pair with (needs the deps in requirements.txt):
#   python -c "from py_vapid import Vapid; from cryptography.hazmat.primitives import serialization as s; import base64; v=Vapid(); v.generate_keys(); \
#     print('public :', base64.urlsafe_b64encode(v.public_key.public_bytes(s.Encoding.X962, s.PublicFormat.UncompressedPoint)).decode().rstrip('=')); \
#     print('private:', base64.urlsafe_b64encode(v.private_key.private_numbers().private_value.to_bytes(32,'big')).decode().rstrip('='))"
#
# THE SHAPES, because getting them wrong fails in the BROWSER with a message
# that names neither variable: the public key is an uncompressed P-256 point —
# 65 bytes, leading 0x04, so 87 base64url characters starting with 'B' — and the
# private key is the raw 32-byte scalar, 43 characters. SPKI/DER (122 chars,
# starting 'MFkwEwYHKoZI') is what most "export the public key" snippets hand
# you and is the commonest mistake; PEM and a compressed point (44 chars) are
# the others. push_service._valid_public_key() rejects all of them at boot and
# reports the feature as off, so a bad deploy is diagnosable from the log.
#
# ROTATING THE PUBLIC KEY INVALIDATES EVERY SUBSCRIPTION. A browser binds its
# subscription to the applicationServerKey it subscribed with, so a new pair
# makes every stored row undeliverable — the endpoints stay valid-looking and
# the sends simply fail. Rotation therefore means: change both values, then
# TRUNCATE boardgamebuddy_push_subscriptions, and every client re-subscribes on
# its next launch (domain/push.js re-syncs on boot). Do not rotate one of the
# pair alone; the private key must match the public one clients hold.
BGB_VAPID_PUBLIC_KEY = os.environ.get("BGB_VAPID_PUBLIC_KEY", "")
BGB_VAPID_PRIVATE_KEY = os.environ.get("BGB_VAPID_PRIVATE_KEY", "")
# The spec requires a contact the push service can reach if this server starts
# misbehaving. "mailto:you@example.com" or an https:// URL.
BGB_VAPID_SUBJECT = os.environ.get("BGB_VAPID_SUBJECT", "mailto:dev@example.com")

# How long a push service should hold an undelivered message for a phone that is
# off. Four hours: long enough to survive a night's sleep or a flat battery,
# short enough that "Priya said good game" cannot arrive two days late and read
# as something that just happened.
PUSH_TTL_SECONDS = 4 * 60 * 60

# Seconds to wait on one push service before giving up on that device. These
# run in a background task, so nobody is watching — but a hung connection would
# hold a worker thread, and a table of eight people is eight of them.
PUSH_TIMEOUT_SECONDS = 10.0


class PushTier(StrEnum):
    """How much of the notification feed an account wants pushed to its devices.

    CUMULATIVE, not three separate buckets: ALL means actionable AND
    informative. The question a person is really answering is "how much do you
    want to hear from this", and a ladder answers it in one glance where two
    independent switches make them reason about four combinations.

    Values are the DB values — boardgamebuddy_profiles.push_tier carries a CHECK
    on exactly these three strings (migration 017).
    """

    NONE = "none"
    ACTIONABLE = "actionable"
    ALL = "all"


class PushEvent(StrEnum):
    """The things worth waking a phone for.

    Deliberately NOT the same list as NotificationKind. The bell records what
    happened; a push interrupts someone, so this list is shorter in one
    direction (no push for a bulk import that would fire six phones at once)
    and longer in another — SESSION_INVITE and GHOST_CLAIM are real
    interruptions that the derived bell has no row for, and ACHIEVEMENT is a
    thing the app already tells you about in a popup you have to be present to
    see.

    "Good game" is absent from BOTH lists on purpose. A like is the lightest
    thing that happens in this app; it belongs on the feed card that earned it,
    and neither a bell row nor a buzz is worth spending on it.
    """

    BUDDY_REQUEST = "buddy_request"
    SESSION_INVITE = "session_invite"
    PLAY_LINK = "play_link"
    GHOST_CLAIM = "ghost_claim"
    BUDDY_ACCEPTED = "buddy_accepted"
    ACHIEVEMENT = "achievement"


# Which tier each event needs before it may be sent. The split IS the feature:
# ACTIONABLE is the set that is waiting on the recipient to do something, ALL
# adds the pleasant noise. A new event must be added here or it can never be
# delivered — push_service treats a missing entry as ALL-only rather than
# guessing, so forgetting fails quiet-and-safe rather than loud-and-annoying.
PUSH_EVENT_TIER: dict[PushEvent, PushTier] = {
    PushEvent.BUDDY_REQUEST: PushTier.ACTIONABLE,
    PushEvent.SESSION_INVITE: PushTier.ACTIONABLE,
    PushEvent.PLAY_LINK: PushTier.ACTIONABLE,
    PushEvent.GHOST_CLAIM: PushTier.ACTIONABLE,
    PushEvent.BUDDY_ACCEPTED: PushTier.ALL,
    PushEvent.ACHIEVEMENT: PushTier.ALL,
}

# Ranked weakest to strongest, so "does this tier admit this event" is one
# index comparison rather than a table of pairs.
_PUSH_TIER_RANK: dict[str, int] = {
    PushTier.NONE: 0,
    PushTier.ACTIONABLE: 1,
    PushTier.ALL: 2,
}


def push_tier_admits(tier: str, event: PushEvent) -> bool:
    """Would an account on `tier` accept `event`?

    NONE admits nothing — including an event whose required tier somehow
    resolves to NONE, which is why the rank of the required tier is compared
    against the account's rather than the two merely being unequal.
    """
    have = _PUSH_TIER_RANK.get(tier or PushTier.NONE, 0)
    need = _PUSH_TIER_RANK.get(PUSH_EVENT_TIER.get(event, PushTier.ALL), 2)
    return have > 0 and have >= need


class PlayLinkGroup(StrEnum):
    """How a play_link row's member plays were collapsed into one entry.

    One act of linking, not one play: BATCH is a single paste of an imported
    note, RUN a run of identical plays inside a pre-batch import, and ACT
    everything else keyed on (owner, linked_at) — which is what makes a
    retroactive ghost link across forty old plays read as the one thing it was.
    """

    BATCH = "batch"
    RUN = "run"
    ACT = "act"




class CollectionSort(StrEnum):
    ALPHABETICAL = "alphabetical"
    LAST_PLAYED = "last_played"
    ADDED_AT = "added_at"


class CatalogSort(StrEnum):
    """Row order for GET /games.

    NEWEST is the historical default and stays the default: the Game Explorer
    and every other paginated catalog caller was built against created_at DESC.
    ALPHABETICAL is what a browse-the-whole-library screen wants — the Add
    Games page scrolls the entire catalog, where import order is noise.
    """

    NEWEST = "newest"
    ALPHABETICAL = "alphabetical"


class BggAuthState(StrEnum):
    """Surfaced on /bgg/sync/status so the FE knows which card to render."""

    UNLINKED = "unlinked"            # No bgg_username on profile
    LINKED = "linked"                # Username + encrypted password present
    RELINK_REQUIRED = "relink_required"  # Username only (legacy public link)


class BggPushChange(StrEnum):
    """What one planned BgB -> BGG change does, as the user reads it.

    Note the payload branches on whether a collid was resolved, NOT on this:
    an ADD can still edit an existing BGG collection row (see
    boardgamebuddy_bgg_push_queue.bgg_collid). This is the label, not the plan.
    """

    ADD = "add"        # In BgB; no flag BgB owns is set on BGG
    UPDATE = "update"  # On both sides, statuses disagree
    CLEAR = "clear"    # Flagged on BGG, absent from the BgB shelf


class BggPullChange(StrEnum):
    """The same comparison read the other way — what an import would do locally.

    A pull is destructive too: it overwrites BgB shelf statuses from BGG. It
    has no 'remove' member because the importer only ever upserts.
    """

    ADD = "add"        # On BGG, not on the BgB shelf -> a new collection row
    UPDATE = "update"  # On both sides -> BgB's status is overwritten
    HELD = "held"      # Would change, but _hold_prev_owned refuses to


class BggUnpushableReason(StrEnum):
    """Why a BgB collection row cannot be represented on BGG at all."""

    NO_BGG_ID = "no_bgg_id"  # A game BgB has that BoardGameGeek does not


class BggCheckPhase(StrEnum):
    """The phases POST /bgg/check walks, in the order it runs them.

    ORDER IS LOAD-BEARING: the FE renders the checklist by iterating this enum,
    so a phase's position here is its position on screen. Every phase is
    emitted from the start — including COLLIDS, which is often skipped — because
    a row appearing halfway down a running checklist reads worse than one that
    turns out not to have been needed.
    """

    GUARDS = "guards"
    COLLECTION = "collection"
    SHELF = "shelf"
    COMPARE = "compare"
    CATALOG = "catalog"
    COLLIDS = "collids"
    QUEUE = "queue"


class BggCheckState(StrEnum):
    """Whether a comparison is running, and whether we can still see it.

    UNKNOWN is not an error. Progress lives in an in-process cache, so a
    restart — or a poll landing on a worker that never ran the check — reads as
    UNKNOWN while the POST itself is still perfectly alive. The FE must render
    that as "still working", never as done.
    """

    UNKNOWN = "unknown"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class BggCheckStepState(StrEnum):
    """One checklist row's state. SKIPPED is a step that was not needed."""

    IDLE = "idle"
    ACTIVE = "active"
    DONE = "done"
    SKIPPED = "skipped"


class PlayMode(StrEnum):
    """Scoring style for a game / play. Persisted on boardgamebuddy_games.play_mode."""

    COMPETITIVE = "competitive"  # Per-player scores; highest total wins (today's UI)
    COOP = "coop"                # All players win or all players lose together
    TEAM = "team"                # Players assigned to teams; the winning team takes it


# BGG mechanic value → PlayMode default. Each entry is checked against the
# game's mechanics array; the first match wins, so COOP entries come before
# TEAM (a game tagged both Cooperative and Team-Based should play as coop).
# BGG's XML returns the mechanic as just "Cooperative" / "Team-Based" in
# practice; the " Game" forms are kept as a defensive fallback in case a
# historical sync path used the longer wording.
BGG_MECHANIC_TO_MODE: list[tuple[str, PlayMode]] = [
    ("Cooperative", PlayMode.COOP),
    ("Cooperative Game", PlayMode.COOP),
    ("Team-Based", PlayMode.TEAM),
    ("Team-Based Game", PlayMode.TEAM),
]


def derive_play_mode(mechanics: list[str] | None) -> PlayMode:
    """Map a BGG mechanics array to its default PlayMode."""
    mset = set(mechanics or [])
    for tag, mode in BGG_MECHANIC_TO_MODE:
        if tag in mset:
            return mode
    return PlayMode.COMPETITIVE



# Cycle through this palette when auto-assigning a color to a newly imported
# expansion. Index = number of existing expansions on the same base game,
# modulo length. Saturated, mutually distinct, contrast-tested against both
# luxury (dark) and parchment (scroll) backgrounds.
EXPANSION_COLOR_PALETTE: list[str] = [
    "#f97316",  # orange
    "#06b6d4",  # cyan
    "#a855f7",  # purple
    "#22c55e",  # green
    "#eab308",  # yellow
    "#ef4444",  # red
    "#ec4899",  # pink
    "#3b82f6",  # blue
]


# ── Play importer (Settings → Import plays) ──────────────────────────────────
# Budgets for the paste-a-note importer. These are true compile-time values —
# request ceilings and a model budget — not an option set, so they belong here
# rather than in a table (.claude/rules/database-supabase.md).

# Longest note the parse endpoint accepts. A phone screenshot transcribed by
# hand runs to a few thousand characters; 20k is roomy for a multi-year Notes
# entry and still ~5k prompt tokens.
MAX_IMPORT_CHARS = 20_000

# Longest optional "how is this organised" hint. Long enough for a paragraph,
# short enough that it can't smuggle a second note past MAX_IMPORT_CHARS.
MAX_IMPORT_HINT_CHARS = 1_000

# Photographs of a note, instead of (or beside) pasted text. Four because a
# notebook page photographs as one image and a spread as two — four covers a
# double spread or a long list shot in sections, and past that the model is
# being asked to hold more page than it reads reliably in one pass.
MAX_IMPORT_IMAGES = 4

# Decoded bytes per image. The client re-encodes to a 2000px-edge JPEG before
# upload, which lands a page of handwriting around 400 KB; 4 MiB is the ceiling
# for a photo that arrives some other way, and it is the number the client's
# own compressor is told to respect. Base64 inflates the wire size by a third,
# so four at the cap is ~21 MB of request — hence the total below, which is the
# limit that actually protects the endpoint.
MAX_IMPORT_IMAGE_BYTES = 4 * 1024 * 1024

# Decoded bytes across every image in one parse. Four compressed pages come in
# far under this; it exists so a caller cannot send four maximum-size images
# and make one request weigh twenty megabytes.
MAX_IMPORT_IMAGES_TOTAL_BYTES = 8 * 1024 * 1024

# Ceiling on plays after `count` expansion. The reference note is 106 plays;
# 500 leaves headroom for a multi-game note without letting one paste write an
# unbounded number of rows.
MAX_IMPORT_PLAYS = 500

# Ceiling on a single play entry's `count`. A tally run of a few hundred is
# plausible; anything past this is the model mis-reading a number.
MAX_REPEAT_COUNT = 300

# Plays per POST /plays/import call. The client chunks to this so a long import
# reports real progress and a failure costs one chunk, not the whole run.
IMPORT_CHUNK_MAX = 50

# Players per parsed play. Guards a malformed reply from expanding into a
# thousand play_players rows.
MAX_IMPORT_PLAYERS_PER_PLAY = 12

# Longest player / game name kept from the model's reply.
MAX_IMPORT_NAME_CHARS = 80

# Longest private buddy alias. A label, not a bio: long enough for "Dave from
# the Tuesday group", short enough that it cannot smuggle a paragraph into a row
# the person it names can never see. Mirrors MAX_IMPORT_NAME_CHARS' reasoning.
MAX_BUDDY_ALIAS_CHARS = 60

# Catalog candidates offered per unmatched game name in the Games step.
IMPORT_GAME_CANDIDATES = 6


# ── Data export ──────────────────────────────────────────────────────────────

class ExportDataset(StrEnum):
    """The slices of an account a user can tick in Settings → Data management.

    One member per checkbox on the export sheet, NOT one per table: a dataset
    is a thing a person recognises owning ("my plays"), and several of them
    fan out to more than one CSV inside the zip because the shape is genuinely
    relational — a play has a roster and the roster is where the scores are,
    and flattening that into one file loses either the seats or the play.

    The values are the wire contract (`?dataset=plays&dataset=guides`) and
    they name the CSVs inside the zip, so renaming one is a breaking change to
    a file somebody has already downloaded.

    `profile`, `expansions`, `buddies` and `achievements` were members and are
    deliberately gone: the profile row is one line the README's own header
    already states, owned expansions now ride in `collection.csv`, and the
    other two were checkboxes nobody opens this sheet for. Removing the members
    rather than leaving them as no-ops is the point — FastAPI validates the
    query against this enum before the route body reaches the registry, so a
    stale `?dataset=profile` from an old tab answers 422 instead of blowing up
    on a missing key. Do not re-add one without a builder behind it.
    """

    COLLECTION = "collection"
    PLAYS = "plays"
    PLAYS_DETAIL = "plays_detail"
    GUIDES = "guides"


# Rows per page when the export walks a table. PostgREST caps an unbounded
# select at 1000, and an export that silently stops at row 1000 is worse than
# one that fails — the file looks complete. Same reasoning (and the same
# safety bound below) as services/bgg_compare_service.py._load_local_collection.
EXPORT_PAGE_SIZE = 1000

# Refuse to page forever if a filter ever stops narrowing. No account is
# anywhere near this; it exists so a bug cannot turn one download into an
# unbounded read of the table.
EXPORT_MAX_ROWS = 200_000

# Ids per `.in_()` filter when the export reads child rows for a set of plays.
# UUIDs are 36 characters and PostgREST puts the whole list in the query
# string, so a larger chunk risks a 414 from whatever proxy sits in front of
# Supabase rather than a clean error.
EXPORT_IN_CHUNK = 100


# ── Scoring templates (migration 018) ────────────────────────────────────────


class ChapterLayout(StrEnum):
    """How a guide chapter's body is stored.

    Mirrors the CHECK on boardgamebuddy_guide_chapters.layout — the DB values
    ARE these values. `scoring_grid` is a layout of the `scoring` chapter type,
    not a type of its own: the guide scroll groups by chapter_type with one
    header per type, so a 7th type would split a user's scoring material into
    two sections both labelled "scoring".
    """

    TEXT = "text"                  # Markdown, rendered by web/ui/markdown.js
    SCORING_GRID = "scoring_grid"  # Labelled rows the play screen fills in


class ScoringRowColor(StrEnum):
    """Row-header tint for one scoring-grid row.

    A SLUG, never a hex. The grid lands on the cream scorepad — a paper surface
    that stays light in both themes — so only a fixed palette the stylesheet
    owns can be guaranteed legible there, and a literal colour travelling
    through a data path is what .claude/rules/theming.md §10 forbids. These six
    mirror COLOR_SWATCHES in web/views/reference-guide-add-view.js, which are
    already contrast-tuned for parchment.
    """

    NEUTRAL = "neutral"
    GOLD = "gold"
    GREEN = "green"
    BLUE = "blue"
    RUST = "rust"
    PURPLE = "purple"


# Rows in one scoring template. boardgamebuddy_play_session_scores.round_index
# is CHECK'd 0..63 and template rows occupy the low indexes, so 24 leaves 40
# rounds of headroom for the extras a scorer appends before a live-scores write
# starts failing — and those writes are fire-and-forget, so it would fail
# silently. Do not raise this without raising that CHECK. Also enforced in SQL
# by bgb_chapters_grid_shape.
MAX_SCORING_TEMPLATE_ROWS = 24

# A row label is the first column of a horizontally-scrolling table whose
# header cell is `white-space: nowrap`. Longer than this and the score columns
# start off-screen on a 390px phone.
MAX_SCORING_ROW_LABEL_CHARS = 24

# Optional per-row hint ("3 pts each"). v1 renders it only into the row's
# title= / aria-label — a 0.72rem header cell has no room for a second line.
MAX_SCORING_ROW_NOTE_CHARS = 80
