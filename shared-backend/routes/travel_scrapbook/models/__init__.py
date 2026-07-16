"""Pydantic request/response models for Travel Scrapbook.

Split by domain to stay under the ~300-line file budget:
  core.py   — profile, capture/sources, scraps, inbox
  trip.py   — anchors, trips, route optimization, exports
  social.py — trip members, invitations, vibes

Everything is re-exported here so `from .models import X` keeps working.
"""

from .core import (  # noqa: F401
    AssignManyRequest,
    AssignRequest,
    CaptureRequest,
    CaptureTokenCreateResponse,
    CaptureTokenStatusResponse,
    CategoryResponse,
    InboxCountResponse,
    InboxResponse,
    InboxScrapResponse,
    MessageResponse,
    ProfileResponse,
    ProfileUpdateRequest,
    RatingRequest,
    ScrapConsensus,
    ScrapListResponse,
    ScrapResponse,
    ScrapUpdateRequest,
    ScrapVibe,
    SourceRef,
    SourceResponse,
    SourceScrapsResponse,
    TripSuggestion,
    TripWishlistResponse,
    TripWishlistScrap,
)
from .trip import (  # noqa: F401
    AnchorCreateRequest,
    AnchorResponse,
    AnchorUpdateRequest,
    MapsLeg,
    MapsLinksResponse,
    RouteLeg,
    RouteOptimizeRequest,
    RouteOptimizeResponse,
    TripCreateRequest,
    TripListResponse,
    TripResponse,
    TripSummaryResponse,
    TripUpdateRequest,
)
from .social import (  # noqa: F401
    InvitationResponse,
    InvitationsResponse,
    InviteRespondRequest,
    MemberInviteRequest,
    MemberRoleUpdateRequest,
    TripMemberResponse,
    TripMembersResponse,
    VibeRequest,
)
