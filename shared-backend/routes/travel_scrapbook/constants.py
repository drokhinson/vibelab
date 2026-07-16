"""Constants and enums for Travel Scrapbook."""

from enum import StrEnum

APP_NAME = "travel-scrapbook"

# Gemini model used for place extraction. This is a tiny structured-extraction
# task (~500 in / ~150 out tokens per scrap) that sits well inside the free
# tier. We use the Google-maintained "-latest" alias rather than a pinned model
# ID: the previously pinned gemini-2.5-flash was pulled from the API on
# 2026-07-09 (ahead of its announced shutdown), 404-ing every request. The alias
# hot-swaps to the current Flash-Lite release (gemini-3.1-flash-lite as of
# 2026-07) with a 2-week email notice before any behavior change, so a silent
# early deprecation can't take the app down again. Swap to gemini-flash-latest
# for a stronger (still free-tier) model if extraction quality needs it.
GEMINI_MODEL = "gemini-flash-lite-latest"

# Cache namespaces (shared-backend/cache.py)
CACHE_NS_CATEGORIES = "ts.categories"
CACHE_NS_GEOCODE = "ts.geocode"

CATEGORIES_TTL_SECONDS = 60 * 60          # 1 hour
GEOCODE_TTL_SECONDS = 60 * 60 * 24 * 30   # 30 days

# ── Capture / places pipeline parameters ─────────────────────────────────────
# A place within this distance of a trip's geocoded destination is auto-staged
# onto that trip. 100 km covers a metro area plus typical day-trips from a
# city-centroid destination (Tokyo→Hakone ≈ 85 km) while staying well under
# inter-destination distances for separate trips; nearest-match tie-breaking
# plus the staging review step absorb the ambiguity.
TRIP_MATCH_RADIUS_KM = 100.0
# Same-name places within this distance are the same POI. 500 m tolerates
# Nominatim centroid-vs-entrance jitter (~100–300 m) while keeping same-name
# chain branches (two Starbucks across town) distinct.
PLACE_DEDUPE_RADIUS_KM = 0.5
# One listicle/reel fans out into at most this many places.
MAX_PLACES_PER_SOURCE = 8
LLM_MAX_TOKENS_MULTI = 1000
# Trip suggestions offered on inbox cards reach a bit beyond the auto-stage radius.
TRIP_SUGGEST_RADIUS_KM = 2 * TRIP_MATCH_RADIUS_KM
MAX_TRIP_SUGGESTIONS = 3
# A source stuck in 'processing' longer than this lost its BackgroundTask
# (deploy/restart) — GET /inbox sweeps it to failed so retry is offered.
SOURCE_PROCESSING_TIMEOUT_SECONDS = 10 * 60
# Personal capture tokens (iOS Shortcut) are prefixed for recognizability.
CAPTURE_TOKEN_PREFIX = "tsc_"


class ScrapStatus(StrEnum):
    """A scrap is the user's saved place — in the inbox, staged on a trip
    awaiting review, or approved into a trip."""
    INBOX = "inbox"
    STAGED = "staged"
    APPROVED = "approved"


class SourceStatus(StrEnum):
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


class CapturedVia(StrEnum):
    """How a source URL arrived."""
    PASTE = "paste"
    BOOKMARKLET = "bookmarklet"
    SHARE = "share"          # Android PWA share target
    SHORTCUT = "shortcut"    # iOS Shortcut → POST /capture with a capture token


class GeocodeConfidence(StrEnum):
    HIGH = "high"       # matched "name, city, country"
    MEDIUM = "medium"   # matched "name, country"
    LOW = "low"         # matched city centroid only
    NONE = "none"       # not geocoded


class AnchorRole(StrEnum):
    START = "start"
    END = "end"
    STAY = "stay"


class AnchorType(StrEnum):
    """How you arrive at / depart from a start or end anchor."""
    AIRPORT = "airport"
    TRAIN_STATION = "train_station"
    CAR_RENTAL = "car_rental"
    OTHER = "other"


class EnrichErrorKind(StrEnum):
    NETWORK = "network"   # page unreachable AND no LLM result possible
    BLOCKED = "blocked"   # page refused us (403/login wall) and URL-only pass failed
    LLM = "llm"           # LLM call failed (missing key, API error)
    GEOCODE = "geocode"   # reserved: geocode hard-failed (soft misses stay 'ready')
    NO_PLACE = "no_place" # LLM succeeded but found zero places on the page
