"""Pydantic request body models for WealthMate API."""

from typing import Optional
from pydantic import BaseModel

from .constants import AccountType, Frequency, InviteAction


class RegisterBody(BaseModel):
    username: str
    password: str
    display_name: Optional[str] = None
    email: Optional[str] = None


class LoginBody(BaseModel):
    username: str
    password: str


class CreateCoupleBody(BaseModel):
    pass  # no body needed


class InviteBody(BaseModel):
    to_username: str


class InviteRespondBody(BaseModel):
    action: InviteAction


class CreateAccountBody(BaseModel):
    name: str
    account_type: AccountType
    owner_user_id: Optional[str] = None
    url: Optional[str] = None
    notes: Optional[str] = None
    sort_order: Optional[int] = 0
    # Optional loan details
    original_loan_amount: Optional[float] = None
    interest_rate: Optional[float] = None
    loan_term_months: Optional[int] = None
    origination_date: Optional[str] = None
    lender_name: Optional[str] = None


class UpdateAccountBody(BaseModel):
    name: Optional[str] = None
    account_type: Optional[AccountType] = None
    owner_user_id: Optional[str] = None
    url: Optional[str] = None
    notes: Optional[str] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None
    # Optional loan details
    original_loan_amount: Optional[float] = None
    interest_rate: Optional[float] = None
    loan_term_months: Optional[int] = None
    origination_date: Optional[str] = None
    lender_name: Optional[str] = None


class StartCheckinBody(BaseModel):
    checkin_date: str  # ISO date string e.g. "2026-03-14"


class SaveValueBody(BaseModel):
    current_value: Optional[float] = None
    balance_owed: Optional[float] = None
    data_source: Optional[str] = "manual"


class CreateExpenseGroupBody(BaseModel):
    name: str
    description: Optional[str] = None


class AddExpenseItemBody(BaseModel):
    description: str
    amount: float
    item_date: Optional[str] = None


class CreateRecurringExpenseBody(BaseModel):
    name: str
    amount: float
    frequency: Optional[Frequency] = Frequency.MONTHLY
    category: Optional[str] = "other"
    start_date: Optional[str] = None
    notes: Optional[str] = None


class UpdateRecurringExpenseBody(BaseModel):
    name: Optional[str] = None
    amount: Optional[float] = None
    frequency: Optional[Frequency] = None
    category: Optional[str] = None
    start_date: Optional[str] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None


class ResetPasswordBody(BaseModel):
    username: str
    recovery_code: str
    new_password: str


class UpdateEmailBody(BaseModel):
    email: str
