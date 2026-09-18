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
# No fallback: unset, QR codes refuse to mint or redeem (503) rather than sign
# with a secret anyone can read out of this file.
BGB_QR_SECRET = os.environ.get("BGB_QR_SECRET") or None
QR_TOKEN_ALGORITHM = "HS256"
# Three minutes. Long enough for three people around a table to each get their
# phone out; short enough that a screenshot or a shoulder-surfed photo is worth
# nothing by the time anyone acts on it. The frontend re-mints at 150s so a
# sheet left open never shows a dead code.
QR_TOKEN_TTL_SECONDS = 180


class ChapterReportStatus(StrEnum):
    OPEN = "open"
    RESOLVED = "resolved"


class FeedbackStatus(StrEnum):
    """The two halves of the Dev feedback board.

    An enum and not a lookup table, which is the opposite of what feedback_type
    and topic get — and the split is deliberate. Those two carry a label, an icon
    and a display order, so they are presentation the frontend must not hardcode
    and a deploy must not be needed to change; this carries none of the three.
    It is two words the code branches on. Same reading as ChapterReportStatus
    above, whose column this one mirrors.
    """

    OPEN = "open"
    RESOLVED = "resolved"


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


class DiscoverReasonKind(StrEnum):
    """Why a game is on the Discover tab's "Picked for you" rail.

    Mirrors the reason_kind text bgb_discover_recommendations (migration 038)
    returns; services/discovery_service.format_reason turns each into the one
    line the tile shows. The order here is the RPC's precedence order.
    """

    BECAUSE_YOU_PLAY = "because_you_play"      # a seed game shares ≥2 mechanics
    SHARED_MECHANICS = "shared_mechanics"      # ≥1 mechanic in the taste profile
    SHARED_CATEGORIES = "shared_categories"    # ≥1 category in the taste profile
    FITS_YOUR_TABLE = "fits_your_table"        # seat count + playtime match
    HIGHLY_RATED = "highly_rated"              # nothing personal; the BGG prior


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


def auth_state_from(status: dict) -> BggAuthState:
    """The state a bgb_bgg_*_status RPC row implies."""
    if not status.get("bgg_username"):
        return BggAuthState.UNLINKED
    if status.get("has_credentials"):
        return BggAuthState.LINKED
    return BggAuthState.RELINK_REQUIRED


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


class RunState(StrEnum):
    """Whether a narrated run is going, and whether we can still see it.

    UNKNOWN is not an error and not a success — it means THIS PROCESS HAS NO
    RECORD, and what that implies depends on who is asking:

      • The BGG check (BggCheckState below) is started by the same request that
        is being narrated, so no record while the POST is still in flight means
        a restart or a poll landing on a worker that never ran it. The FE must
        render that as "still working", never as done.
      • An admin run is started from its own page and its ledger outlives the
        run by ten minutes, so no record means "nothing has run recently" and
        the page renders its idle state.

    Do not collapse those two readings into one FE branch.
    """

    UNKNOWN = "unknown"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class RunStepState(StrEnum):
    """One checklist row's state. SKIPPED is a step that was not needed."""

    IDLE = "idle"
    ACTIVE = "active"
    DONE = "done"
    SKIPPED = "skipped"


# The BGG check named these two first and forty-odd call sites plus two
# response models import them under those names. They were always generic —
# services/step_progress.py now shares them with the BGA sweep and the admin
# runs — so they are aliases rather than a rename, which would have been a
# sweep with no behaviour change at the end of it.
BggCheckState = RunState
BggCheckStepState = RunStepState


class BgaAuthState(StrEnum):
    """Surfaced on /bga/link so the wizard's account step knows what to render.

    The same three states as BggAuthState and deliberately not shared with it:
    the two accounts link independently, and a user can be LINKED on one while
    RELINK_REQUIRED on the other.
    """

    UNLINKED = "unlinked"                # No bga_username on profile
    LINKED = "linked"                    # Username + encrypted password present
    RELINK_REQUIRED = "relink_required"  # Username, but nothing we can decrypt


def bga_auth_state_from(profile: dict) -> BgaAuthState:
    """The state a profile row implies for Board Game Arena."""
    if not profile.get("bga_username"):
        return BgaAuthState.UNLINKED
    if profile.get("bga_password_enc"):
        return BgaAuthState.LINKED
    return BgaAuthState.RELINK_REQUIRED


class BgaFetchPhase(StrEnum):
    """The phases POST /bga/tables/fetch walks, in the order it runs them.

    ORDER IS LOAD-BEARING: the FE renders the checklist by iterating this enum,
    so a phase's position here is its position on screen. Every phase is
    emitted from the start — including DETAIL, which is skipped whenever BGA's
    history pages carry their own rosters — because a row appearing halfway
    down a running checklist reads worse than one that turns out not to have
    been needed.
    """

    SIGN_IN = "sign_in"   # Reusing or refreshing the stored session
    HISTORY = "history"   # Walking getGames pages, newest first
    KNOWN = "known"       # Dropping tables already imported
    DETAIL = "detail"     # Per-table rosters, only when history lacked them
    MATCH = "match"       # Game names against the catalog, handles against people


# The BGA sweep's own names for the same two vocabularies, kept as aliases for
# the same reason as BggCheckState above: the sweep's modules and its response
# model import them by these names, and the values were already identical
# member for member. A sweep with UNKNOWN still reads as "still working" — see
# RunState's docstring for why that is the sweep's reading and not the admin
# runs'.
BgaFetchState = RunState
BgaFetchStepState = RunStepState


class AdminRunTool(StrEnum):
    """The admin catalog jobs that narrate themselves on /admin/run/:tool.

    The value IS the url segment and the ledger's cache key, so renaming one
    orphans any run in flight and any bookmark. TRENDING is the odd one: it is
    a single request, and the two BGG_* are drained in passes by the browser
    (see AdminBackfillPhase).

    BGG_METADATA was three tools — descriptions, stats and publishers — until
    they became one. They asked BoardGameGeek the SAME question: one
    /thing?stats=1 response carries the blurb, the four stats, the publisher
    links and the year, which is what import_game_from_bgg has always done with
    it. Three tools meant walking the catalog three times to read one document,
    and a game short of two fields being counted twice by the admin badge.
    Images stays its own tool because it is genuinely different work: one BGG
    call plus two downloads and two uploads per game, which is why its pass is
    a tenth the size.
    """

    TRENDING = "trending"
    BGG_IMAGES = "bgg-images"
    BGG_METADATA = "bgg-metadata"


class AdminTrendingPhase(StrEnum):
    """The phases POST /discover/admin/refresh-trending walks, in order.

    ORDER IS LOAD-BEARING — the FE renders the checklist by walking this enum,
    so a phase's position here is its position on screen. Same contract as
    BggCheckPhase.
    """

    FETCH = "fetch"          # BGG's hot list
    SNAPSHOT = "snapshot"    # this run's rows
    PRUNE = "prune"          # runs past the retention window
    DIFF = "diff"            # which hot games the catalog lacks
    IMPORT = "import"        # throttled, capped at HOT_IMPORT_PER_RUN
    CACHES = "caches"


class AdminBackfillPhase(StrEnum):
    """The phases ONE PASS of a catalog backfill walks, in order.

    A cold catalog takes many passes — each is bounded server-side so it fits
    inside the platform's request timeout — and every pass walks these three
    again. The ledger keeps its journal and its totals across passes, so the
    checklist restarts while the log below it does not. See
    services/admin_run_progress.py.

    THREE PHASES, NOT FOUR. Fetching from BGG and writing what came back are
    one interleaved loop — a batch is fetched, its rows are written, then the
    next batch — so a separate WRITE phase would have to ping-pong with FETCH
    on every chunk, and `begin()` marks earlier phases done. FETCH counts
    batches and carries the running save count in its detail; which individual
    row failed to write is a journal line, which is where per-item outcomes
    belong anyway.
    """

    SCAN = "scan"      # page_all over the catalog for what is still missing
    FETCH = "fetch"    # BGG, in throttled batches, writing as it goes
    CACHES = "caches"


class AdminRunLevel(StrEnum):
    """A journal entry's severity. INFO is a thing that worked — the run log
    is as much about what succeeded as about what did not."""

    INFO = "info"
    WARN = "warn"
    ERROR = "error"


class BgaMatchReason(StrEnum):
    """Why a BGA handle was resolved to the person it was.

    Surfaced per row so the wizard can LABEL A SUGGESTION BY ITS REASON rather
    than by the score that ranked it (.claude/rules/web-frontend.md). The order
    here is the resolution ladder's precedence, best evidence first.
    """

    VIEWER = "viewer"                  # The handle is the importer's own
    REMEMBERED = "remembered"          # boardgamebuddy_bga_player_links
    CROSS_ACCOUNT = "cross_account"    # Another account linked this handle
    FUZZY = "fuzzy"                    # The name ranker's best guess
    NONE = "none"                      # Nothing — a new ghost


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

# Plays returned by one POST /bgg/plays/pending, newest first. Matched to
# MAX_IMPORT_PLAYS on purpose — the importer's review, its localStorage draft
# and its chunked write are sized for that number whatever the source is.
#
# Truncating is safe in a way it would not be for a pasted note: every play the
# importer lands keeps its bgg_play_id, so the next preview excludes it and
# "run it again for the rest" is a loop that terminates. A BGG account with
# 1,240 plays imports in three passes rather than one, and the review says so.
MAX_BGG_PENDING_PLAYS = 500

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

# Longest Dev feedback body. Room for a real bug report — what you did, what you
# expected, what happened — without turning a board that is skimmed into one that
# is read. Well above MAX_BUDDY_ALIAS_CHARS above and well under MAX_IMPORT_CHARS
# below, which is what the two bounds are for. The cap is enforced on the request
# model rather than as a CHECK: it is an editorial limit on a textarea, not an
# invariant the database needs.
MAX_FEEDBACK_BODY_CHARS = 2000

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


# Rows per page when a read walks a whole table (services/_helpers.page_all).
# PostgREST caps an unbounded select at 1000, and a read that silently stops
# at row 1000 is worse than one that fails — the export looks complete, the
# BGG push clears games the user still owns.
DB_PAGE_SIZE = 1000

# Refuse to page forever if a filter ever stops narrowing. No account is
# anywhere near this; it exists so a bug cannot turn one read into an
# unbounded walk of the table.
DB_PAGE_MAX_ROWS = 200_000

# Ids per `.in_()` filter when the export reads child rows for a set of plays.
# UUIDs are 36 characters and PostgREST puts the whole list in the query
# string, so a larger chunk risks a 414 from whatever proxy sits in front of
# Supabase rather than a clean error.
EXPORT_IN_CHUNK = 100


# ── Scoring templates (migration 018) ────────────────────────────────────────


class ChapterLayout(StrEnum):
    """How a guide chapter's body is stored.

    Mirrors the CHECK on boardgamebuddy_guide_chapters.layout — the DB values
    ARE these values.

    This is not the same axis as `chapter_type`, though the two are 1:1 for
    grids. The type is an FK to a lookup table and says what the chapter is
    ABOUT; the layout says what shape its body is stored in, and so is what the
    grid-shape CHECK, the ?layout= pool filter and every renderer branch read.
    services/chapter_grid.validate_layout_pairing keeps the pair honest.
    """

    TEXT = "text"                  # Markdown, rendered by web/ui/markdown.js
    SCORING_GRID = "scoring_grid"  # Labelled rows the play screen fills in


class ScoringRowColor(StrEnum):
    """Row-header tint for one scoring-grid row.

    A SLUG, never a hex. The grid lands on the cream scorepad — a paper surface
    that stays light in both themes — so only a fixed palette the stylesheet
    owns can be guaranteed legible there, and a literal colour travelling
    through a data path is what .claude/rules/theming.md §10 forbids.

    This enum is the only place the set is VALIDATED; the hexes live in
    styles.css (--row-*) and the editor's swatch chips in
    web/widgets/scoring-template-editor.js mirror both. Adding a colour means
    touching all three, plus the two COMMENT ON COLUMN strings and STRUCTURE.md
    that describe the set in prose.

    Spectrum order, so the editor's 5x2 swatch grid is scannable. Position
    carries no meaning — the slug is the key.
    """

    NEUTRAL = "neutral"
    RED = "red"
    PINK = "pink"
    RUST = "rust"
    BROWN = "brown"
    GOLD = "gold"
    YELLOW = "yellow"
    GREEN = "green"
    BLUE = "blue"
    PURPLE = "purple"


class ScoringGridMode(StrEnum):
    """How an EXPANSION's scoring grid meets the base game's.

    A grid written for an expansion is not a scorepad in its own right — the
    expansion is played WITH the base game, and the two either share one
    scorepad or the expansion brings its own. Which of the two is a property of
    the expansion, known by whoever writes its grid, so it is stored on the
    grid rather than guessed at the table:

      * ADD_ON — the expansion's rows are APPENDED to the base game's grid.
        Everdell + Pearlbrook: the base fourteen rows plus Pearl and Wonders.
      * REPLACE — the expansion's rows ARE the scorepad, and the base game's
        grid is not used at all. A legacy/campaign box that reprints the whole
        score sheet with its own categories.

    NULL on a BASE game's grid, and that absence is meaningful: the mode
    answers "how does this meet the base game's grid", which a base game's own
    grid cannot be asked. services/chapter_grid.resolve_grid_mode is the one
    place that decides, and it defaults an expansion grid that names no mode to
    ADD_ON — the commoner shape by far, and the one that loses nothing if it is
    wrong (the rows are still on the table; a wrong REPLACE would have hidden
    the base game's).

    The DB stores this INSIDE the `grid` JSONB rather than in a column of its
    own (migration 032): it is part of the grid document, versioned by the same
    `v`, and nothing queries or sorts by it.
    """

    ADD_ON = "add_on"
    REPLACE = "replace"


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

# Optional per-row explanation of HOW the row is scored ("2 pts per card in
# your city, 3 if it is unique"). Never rendered in the header cell itself — a
# 0.72rem cell has no room for a second line — but behind an info button beside
# the label, which opens the text in the project's one-button information modal
# (widgets/round-score-grid.js -> PolaroidPopup.alert). That modal is why this
# is 200 rather than the 80 a title= tooltip could carry: the field is an
# explanation the author writes once for the table to read mid-game, not a
# four-word hint. Nothing in SQL caps it — bgb_chapters_grid_shape counts rows,
# not characters — so this constant and the editor's mirror of it are the
# ceiling.
MAX_SCORING_ROW_NOTE_CHARS = 200


# ── Release notices ──────────────────────────────────────────────────────────

class ReleaseNoticeStatus(StrEnum):
    """The admin list's filter, and only that.

    Deliberately NOT a row state: `published_at IS NULL` is the one draft flag
    (migration 042). A status column beside the timestamp would be two sources
    of truth for one fact, written by three routes and correct only if all
    three remember.
    """

    ALL = "all"
    DRAFT = "draft"
    PUBLISHED = "published"


# How many unseen notices the popup carries at once. Someone six releases
# behind gets the newest five, not the oldest five — the rest stay in the
# Settings archive. Five is about the point where "here is what you missed"
# stops being a welcome and starts being a wall.
RELEASE_NOTICES_POPUP_MAX = 5

# A title is one line on a 390px card in the app's display face.
MAX_RELEASE_NOTICE_TITLE_CHARS = 120

# The body is the whole point and it is markdown, so this is generous — but it
# is bounded, because the popup is a card the user cannot scroll past to reach
# their app. Past this, write two notices.
MAX_RELEASE_NOTICE_BODY_CHARS = 8000

# "Take me there" / "See the Discover tab". A button label, not a sentence.
MAX_RELEASE_NOTICE_LINK_LABEL_CHARS = 40

# A router route name from web/domain/view.js's _routes table. Not validated
# against a server-side enum: the backend has no route table, so any enum here
# would be a copy that drifts the first time a route is renamed. The admin
# picker offers only param-free routes, and both render paths drop the button
# when router.pathFor() cannot build a URL.
MAX_RELEASE_NOTICE_LINK_ROUTE_CHARS = 64


# ── Affiliate partners (migration 046) ───────────────────────────────────────

class AffiliateSurface(StrEnum):
    """Where a partner pill was tapped. Mirrors the CHECK on
    boardgamebuddy_affiliate_clicks.surface."""

    GAME_DETAIL = "game_detail"
    DISCOVER = "discover"


# The retailer's name on a pill: "Noble Knight Games" is the long end.
MAX_AFFILIATE_LABEL_CHARS = 60
# A store URL or a network redirect with its placeholders. Impact links run
# ~120 characters before the destination.
MAX_AFFILIATE_TEMPLATE_CHARS = 500
# An Amazon Store ID is ~12 characters; a network sub-id can be longer.
MAX_AFFILIATE_TAG_CHARS = 100
# One required sentence, not a paragraph.
MAX_AFFILIATE_DISCLOSURE_CHARS = 300
# The operator hint in the editor.
MAX_AFFILIATE_NOTES_CHARS = 600
