"""
routes/daywordplay/models.py
Pydantic request/response models for Day Word Play.
"""
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


class CreateGroupBody(BaseModel):
    name: str


class JoinGroupBody(BaseModel):
    code: str


class SubmitSentenceBody(BaseModel):
    sentence: str
