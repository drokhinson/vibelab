"""Pydantic request/response models for Travel Scrapbook.

Split by domain to stay under the ~300-line file budget:
  core.py      — profile, capture/sources, scraps, inbox
  trip.py      — anchors, trips, exports
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
    GeoFacets,
    InboxCountResponse,
    InboxResponse,
    InboxScrapResponse,
    MessageResponse,
    PagedScrapsResponse,
    PlanScheduleRequest,
    ProfileResponse,
    ProfileUpdateRequest,
    RatingRequest,
    ScrapConsensus,
    ScrapListResponse,
    ScrapResponse,
    ScrapUpdateRequest,
    ScrapVibe,
    SetTripsRequest,
    SourceRef,
    SourceResponse,
    SourceScrapsResponse,
    TripSuggestion,
    TripWishlistResponse,
    TripWishlistScrap,
    VisitedPageResponse,
)
from .trip import (  # noqa: F401
    AnchorCreateRequest,
    AnchorResponse,
    AnchorUpdateRequest,
    ExportPlanItem,
    ExportRequest,
    MapsLeg,
    MapsLinksResponse,
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
    SuggestionCategoryFacet,
    TripSuggestionItem,
    TripSuggestionsResponse,
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
