"""Pydantic request body models for SpotMe API."""

from typing import Optional
from pydantic import BaseModel


class RegisterBody(BaseModel):
    username: str
    password: str
    display_name: Optional[str] = None
    email: Optional[str] = None


class LoginBody(BaseModel):
    username: str
    password: str


class ResetPasswordBody(BaseModel):
    username: str
    recovery_code: str
    new_password: str


class ProfileUpdateBody(BaseModel):
    display_name: Optional[str] = None
    bio: Optional[str] = None
    avatar_url: Optional[str] = None


class LocationUpdateBody(BaseModel):
    home_lat: Optional[float] = None
    home_lng: Optional[float] = None
    home_label: Optional[str] = None


class TravelingUpdateBody(BaseModel):
    traveling_to_lat: float
    traveling_to_lng: float
    traveling_to_label: str
    traveling_from: str
    traveling_until: str


class DiscoverableBody(BaseModel):
    is_discoverable: bool


class AddHobbyBody(BaseModel):
    hobby_id: str
    proficiency: str
    notes: Optional[str] = None


class UpdateHobbyBody(BaseModel):
    proficiency: Optional[str] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None


class CreateHobbyBody(BaseModel):
    name: str
    category_id: str
