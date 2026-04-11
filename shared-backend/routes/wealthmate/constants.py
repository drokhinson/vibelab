"""Shared constants for WealthMate API."""

from enum import StrEnum

TYPE_LABEL = {
    "checking_personal": "Bank Account",
    "checking_joint": "Bank Account",
    "savings": "Bank Account",
    "401k": "401(k)",
    "roth_ira": "Roth IRA",
    "retirement_other": "Retirement",
    "investment": "Investment",
    "property_personal": "Property",
    "property_rental": "Rental Property",
    "car_loan": "Car Loan",
    "mortgage": "Mortgage",
    "loan": "Loan",
    "other": "Other Account",
    "other_liability": "Other Liability",
}

LABEL_TO_ACCOUNT_TYPE = {
    "bank account": "savings",
    "401(k)": "401k",
    "roth ira": "roth_ira",
    "retirement": "retirement_other",
    "investment": "investment",
    "property": "property_personal",
    "rental property": "property_rental",
    "car loan": "car_loan",
    "mortgage": "mortgage",
    "loan": "loan",
    "other account": "other",
    "other liability": "other_liability",
}

CSV_HEADERS = ["Checkin Date", "Account Name", "Account Type", "Current Value", "Balance Owed"]

FREQUENCY_MONTHLY_MULTIPLIER = {
    "weekly": 4.333,
    "monthly": 1.0,
    "quarterly": 1.0 / 3.0,
    "yearly": 1.0 / 12.0,
}


# ── Enums ─────────────────────────────────────────────────────────────────────

class AccountType(StrEnum):
    CHECKING_PERSONAL = "checking_personal"
    CHECKING_JOINT = "checking_joint"
    SAVINGS = "savings"
    FOUR01K = "401k"
    ROTH_IRA = "roth_ira"
    RETIREMENT_OTHER = "retirement_other"
    INVESTMENT = "investment"
    PROPERTY_PERSONAL = "property_personal"
    PROPERTY_RENTAL = "property_rental"
    CAR_LOAN = "car_loan"
    MORTGAGE = "mortgage"
    LOAN = "loan"
    OTHER = "other"
    OTHER_LIABILITY = "other_liability"


class Frequency(StrEnum):
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    YEARLY = "yearly"


class InvitationStatus(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    DECLINED = "declined"


class InviteAction(StrEnum):
    ACCEPT = "accept"
    DECLINE = "decline"


class CheckinStatus(StrEnum):
    IN_PROGRESS = "in_progress"
    SUBMITTED = "submitted"
