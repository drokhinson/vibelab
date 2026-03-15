"""Shared constants for WealthMate API."""

import os

JWT_SECRET = os.environ.get("WEALTHMATE_JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"

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
