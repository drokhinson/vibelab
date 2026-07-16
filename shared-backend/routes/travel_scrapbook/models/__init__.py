"""Pydantic request/response models for Travel Scrapbook.

Split by domain to stay under the ~300-line file budget:
  core.py      — profile, capture/sources, scraps, inbox
  trip.py      — anchors, trips, route optimization, exports
  timeline.py  — day-by-day timeline markers/days/suggestions
  community.py — cross-user community place pool
  social.py    — trip members, invitations, vibes

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
from .community import (  # noqa: F401
    CommunityPlaceResponse,
    CommunityPlacesResponse,
    CommunitySaveRequest,
    CommunitySourceRef,
)
from .timeline import (  # noqa: F401
    TimelineDay,
    TimelineMarker,
    TimelineResponse,
    TimelineSuggestion,
    UnscheduledPlan,
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
