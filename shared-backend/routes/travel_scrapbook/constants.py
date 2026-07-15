"""Constants and enums for Travel Scrapbook."""

from enum import StrEnum

APP_NAME = "travel-scrapbook"

# Claude model used for place extraction. Haiku is the cheapest tier and this
# is a tiny structured-extraction task (~500 in / ~150 out tokens per scrap).
HAIKU_MODEL = "claude-haiku-4-5"

# Cache namespaces (shared-backend/cache.py)
CACHE_NS_CATEGORIES = "ts.categories"
CACHE_NS_GEOCODE = "ts.geocode"

CATEGORIES_TTL_SECONDS = 60 * 60          # 1 hour
GEOCODE_TTL_SECONDS = 60 * 60 * 24 * 30   # 30 days


class ScrapStatus(StrEnum):
    PENDING = "pending"
    READY = "ready"
    FAILED = "failed"


class GeocodeConfidence(StrEnum):
    HIGH = "high"       # matched "name, city, country"
    MEDIUM = "medium"   # matched "name, country"
    LOW = "low"         # matched city centroid only
    NONE = "none"       # not geocoded


class AnchorRole(StrEnum):
    START = "start"
    END = "end"
    STAY = "stay"


class EnrichErrorKind(StrEnum):
    NETWORK = "network"   # page unreachable AND no LLM result possible
    BLOCKED = "blocked"   # page refused us (403/login wall) and URL-only pass failed
    LLM = "llm"           # Anthropic call failed (missing key, API error)
    GEOCODE = "geocode"   # reserved: geocode hard-failed (soft misses stay 'ready')
