"""Shared Pydantic response models used across all project APIs."""

from pydantic import BaseModel


class HealthResponse(BaseModel):
    project: str
    status: str


class StatusResponse(BaseModel):
    status: str


class ErrorDetail(BaseModel):
    detail: str
