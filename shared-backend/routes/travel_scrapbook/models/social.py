"""Social models: trip members, invitations, and per-traveler vibes."""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, model_validator

from ..constants import InviteAction, MemberStatus, TripMemberRole, TripVibe


# ── Trip sharing (members + invitations) ──────────────────────────────────────

class MemberInviteRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=30,
                          description="Handle of the user to invite")
    role: TripMemberRole = Field(
        TripMemberRole.COLLABORATOR, description="viewer or collaborator")

    @model_validator(mode="after")
    def _reject_owner(self) -> "MemberInviteRequest":
        if self.role == TripMemberRole.OWNER:
            raise ValueError("role must be viewer or collaborator")
        return self


class MemberRoleUpdateRequest(BaseModel):
    role: TripMemberRole

    @model_validator(mode="after")
    def _reject_owner(self) -> "MemberRoleUpdateRequest":
        if self.role == TripMemberRole.OWNER:
            raise ValueError("role must be viewer or collaborator")
        return self


class InviteRespondRequest(BaseModel):
    action: InviteAction


class TripMemberResponse(BaseModel):
    user_id: str
    username: str
    display_name: str
    role: TripMemberRole
    status: MemberStatus = MemberStatus.ACCEPTED   # owner row is always 'accepted'


class TripMembersResponse(BaseModel):
    members: list[TripMemberResponse]              # owner first


class InvitationResponse(BaseModel):
    """A pending invite shown to the invitee."""
    trip_id: str
    trip_name: str
    cover_icon: str = "plane"
    role: TripMemberRole
    owner_display_name: Optional[str] = None
    invited_by_display_name: Optional[str] = None
    created_at: datetime


class InvitationsResponse(BaseModel):
    invitations: list[InvitationResponse]


# ── Vibes ─────────────────────────────────────────────────────────────────────

class VibeRequest(BaseModel):
    level: TripVibe
