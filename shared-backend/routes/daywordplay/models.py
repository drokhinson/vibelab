"""
routes/daywordplay/models.py
Pydantic request/response models for Day Word Play.
"""
from typing import Optional
from pydantic import BaseModel


class UpsertProfileBody(BaseModel):
    username: str
    display_name: Optional[str] = None
    email: Optional[str] = None


class CreateGroupBody(BaseModel):
    name: str


class JoinGroupBody(BaseModel):
    code: str


class ReviewJoinRequestBody(BaseModel):
    action: str  # "approve" or "deny"


class SubmitSentenceBody(BaseModel):
    sentence: str


class ReusableSentencesResponse(BaseModel):
    reusable_sentences: list[dict]


class AddWordBody(BaseModel):
    word: str
    part_of_speech: str
    definition: str
    etymology: Optional[str] = None


class ProposeWordBody(BaseModel):
    word: str
    part_of_speech: str
    definition: str
    etymology: Optional[str] = None


class VoteCountItem(BaseModel):
    sentence_id: str
    vote_count: int
    i_voted: bool


class VoteCountsResponse(BaseModel):
    vote_counts: list[VoteCountItem]
    has_voted: bool


class BulkSentenceItem(BaseModel):
    id: str
    sentence: str
    user_id: str
    username: str
    display_name: str
    vote_count: int
    i_voted: bool
    is_mine: bool


class BulkYesterdayGroupEntry(BaseModel):
    word: Optional[dict] = None
    date: str
    sentences: list[BulkSentenceItem]
    has_voted: bool


class BulkYesterdayResponse(BaseModel):
    groups: dict[str, BulkYesterdayGroupEntry]
