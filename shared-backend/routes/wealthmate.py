"""
routes/wealthmate.py — WealthMate API routes
All routes at /api/v1/wealthmate/...

Supabase tables (all prefixed wealthmate_):
  wealthmate_users              — id, username, display_name, password_hash
  wealthmate_couples            — id, created_at
  wealthmate_couple_members     — id, couple_id, user_id, role, joined_at
  wealthmate_invitations        — id, from_user_id, to_username, couple_id, status
  wealthmate_accounts           — id, couple_id, owner_user_id, name, account_type, ...
  wealthmate_account_loan_details — account_id (PK), original_loan_amount, ...
  wealthmate_checkins           — id, couple_id, initiated_by_user_id, checkin_date, status
  wealthmate_checkin_values     — id, checkin_id, account_id, current_value, balance_owed, ...
  wealthmate_expense_groups     — id, couple_id, name, description
  wealthmate_expense_items      — id, group_id, description, amount, item_date
  wealthmate_recurring_expenses — id, couple_id, name, amount, frequency, category, ...
"""

import csv
import io
import os
import secrets
from datetime import datetime, date, timezone
from typing import Optional

import bcrypt
import jwt
from fastapi import APIRouter, HTTPException, Depends, Header, UploadFile, File
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from db import get_supabase
from auth import hash_password, verify_password, create_token, decode_token, extract_bearer_token

router = APIRouter(prefix="/api/v1/wealthmate", tags=["wealthmate"])

JWT_SECRET = os.environ.get("WEALTHMATE_JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"

# ---------------------------------------------------------------------------
# CSV export/import type mappings
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

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
    action: str  # "accept" or "decline"

class CreateAccountBody(BaseModel):
    name: str
    account_type: str
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
    account_type: Optional[str] = None
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
    frequency: Optional[str] = "monthly"
    category: Optional[str] = "other"
    start_date: Optional[str] = None
    notes: Optional[str] = None

class UpdateRecurringExpenseBody(BaseModel):
    name: Optional[str] = None
    amount: Optional[float] = None
    frequency: Optional[str] = None
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

# ---------------------------------------------------------------------------
# Auth helpers (thin wrappers around shared auth module)
# ---------------------------------------------------------------------------

def _hash_password(password: str) -> str:
    return hash_password(password)


def _verify_password(password: str, password_hash: str) -> bool:
    return verify_password(password, password_hash)


def _create_token(user_id: str, username: str, couple_id: Optional[str] = None) -> str:
    return create_token(
        {"user_id": user_id, "username": username, "couple_id": couple_id},
        JWT_SECRET, JWT_ALGORITHM,
    )


def _decode_token(token: str) -> dict:
    return decode_token(token, JWT_SECRET, JWT_ALGORITHM)


def _get_couple_id_for_user(user_id: str) -> Optional[str]:
    """Look up the couple_id for a user, or return None."""
    sb = get_supabase()
    result = (
        sb.table("wealthmate_couple_members")
        .select("couple_id")
        .eq("user_id", user_id)
        .execute()
    )
    if result.data:
        return result.data[0]["couple_id"]
    return None


async def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    """FastAPI dependency — extracts and validates JWT from Authorization header."""
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header required")
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Authorization header must be: Bearer <token>")
    payload = _decode_token(parts[1])
    # Refresh couple_id in case it changed since token was issued
    couple_id = _get_couple_id_for_user(payload["user_id"])
    # Auto-create household if missing (handles users registered before solo-first change)
    if not couple_id:
        sb = get_supabase()
        couple_result = sb.table("wealthmate_couples").insert({}).execute()
        if couple_result.data:
            couple_id = couple_result.data[0]["id"]
            sb.table("wealthmate_couple_members").insert({
                "couple_id": couple_id,
                "user_id": payload["user_id"],
                "role": "owner",
            }).execute()
    payload["couple_id"] = couple_id
    return payload


def _require_couple(user: dict) -> str:
    """Return couple_id or raise 400 if user is not in a couple."""
    couple_id = user.get("couple_id")
    if not couple_id:
        raise HTTPException(status_code=400, detail="You are not part of a couple yet")
    return couple_id


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@router.get("/health")
async def health():
    return {"project": "wealthmate", "status": "ok"}


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@router.post("/auth/register")
async def register(body: RegisterBody):
    sb = get_supabase()
    # Check username uniqueness
    existing = (
        sb.table("wealthmate_users")
        .select("id")
        .eq("username", body.username)
        .execute()
    )
    if existing.data:
        raise HTTPException(status_code=409, detail="Username already taken")

    password_hash = _hash_password(body.password)
    recovery_code = secrets.token_urlsafe(16)
    recovery_hash = _hash_password(recovery_code)
    user_data = {
        "username": body.username,
        "display_name": body.display_name or body.username,
        "password_hash": password_hash,
        "recovery_hash": recovery_hash,
    }
    if body.email:
        user_data["email"] = body.email
    result = sb.table("wealthmate_users").insert(user_data).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create user")

    user = result.data[0]

    # Auto-create a solo household so the user can start immediately
    couple_result = sb.table("wealthmate_couples").insert({}).execute()
    couple_id = couple_result.data[0]["id"] if couple_result.data else None
    if couple_id:
        sb.table("wealthmate_couple_members").insert({
            "couple_id": couple_id,
            "user_id": user["id"],
            "role": "owner",
        }).execute()

    token = _create_token(user["id"], user["username"], couple_id)
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"],
            "couple_id": couple_id,
        },
        "recovery_code": recovery_code,
    }


@router.post("/auth/login")
async def login(body: LoginBody):
    sb = get_supabase()
    result = (
        sb.table("wealthmate_users")
        .select("*")
        .eq("username", body.username)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=401, detail="Invalid username or password")

    user = result.data[0]

    # Dev convenience: allow dummy accounts to login with "password"
    is_dummy = body.username in ("adam", "eve") and body.password == "password"
    if not is_dummy:
        if not _verify_password(body.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid username or password")

    couple_id = _get_couple_id_for_user(user["id"])
    token = _create_token(user["id"], user["username"], couple_id)
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"],
            "couple_id": couple_id,
        },
    }


@router.post("/auth/reset-password")
async def reset_password(body: ResetPasswordBody):
    sb = get_supabase()
    result = (
        sb.table("wealthmate_users")
        .select("id, recovery_hash")
        .eq("username", body.username)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=400, detail="Invalid username or recovery code")
    user = result.data[0]
    if not user.get("recovery_hash"):
        raise HTTPException(status_code=400, detail="No recovery code set for this account")
    if not _verify_password(body.recovery_code, user["recovery_hash"]):
        raise HTTPException(status_code=400, detail="Invalid username or recovery code")

    # Update password and rotate recovery code
    new_password_hash = _hash_password(body.new_password)
    new_recovery_code = secrets.token_urlsafe(16)
    new_recovery_hash = _hash_password(new_recovery_code)
    sb.table("wealthmate_users").update({
        "password_hash": new_password_hash,
        "recovery_hash": new_recovery_hash,
    }).eq("id", user["id"]).execute()

    return {"message": "Password reset successful", "new_recovery_code": new_recovery_code}


@router.post("/auth/recovery-code")
async def generate_recovery_code(user: dict = Depends(get_current_user)):
    sb = get_supabase()
    recovery_code = secrets.token_urlsafe(16)
    recovery_hash = _hash_password(recovery_code)
    sb.table("wealthmate_users").update({
        "recovery_hash": recovery_hash,
    }).eq("id", user["user_id"]).execute()
    return {"recovery_code": recovery_code}


@router.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    sb = get_supabase()
    result = (
        sb.table("wealthmate_users")
        .select("id, username, display_name, email, created_at")
        .eq("id", user["user_id"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found")
    u = result.data[0]
    u["couple_id"] = user["couple_id"]
    return u


@router.put("/auth/email")
async def update_email(body: UpdateEmailBody, user: dict = Depends(get_current_user)):
    sb = get_supabase()
    sb.table("wealthmate_users").update({
        "email": body.email,
    }).eq("id", user["user_id"]).execute()
    return {"message": "Email updated", "email": body.email}


# ---------------------------------------------------------------------------
# Account Deletion
# ---------------------------------------------------------------------------

@router.delete("/auth/me")
async def delete_account(user: dict = Depends(get_current_user)):
    """Delete the current user and all associated data."""
    sb = get_supabase()
    user_id = user["user_id"]
    couple_id = user.get("couple_id")

    if couple_id:
        # Check if user is the only member of their household
        members = (
            sb.table("wealthmate_couple_members")
            .select("id, user_id")
            .eq("couple_id", couple_id)
            .execute()
        )
        member_ids = [m["user_id"] for m in (members.data or [])]
        is_solo = len(member_ids) <= 1

        if is_solo:
            # Solo household — delete everything
            # Get checkin IDs to delete values
            checkins = (
                sb.table("wealthmate_checkins")
                .select("id")
                .eq("couple_id", couple_id)
                .execute()
            )
            checkin_ids = [c["id"] for c in (checkins.data or [])]
            if checkin_ids:
                sb.table("wealthmate_checkin_values").delete().in_("checkin_id", checkin_ids).execute()

            # Get account IDs to delete loan details
            accts = (
                sb.table("wealthmate_accounts")
                .select("id")
                .eq("couple_id", couple_id)
                .execute()
            )
            acct_ids = [a["id"] for a in (accts.data or [])]
            if acct_ids:
                sb.table("wealthmate_account_loan_details").delete().in_("account_id", acct_ids).execute()

            # Delete expense items via groups
            groups = (
                sb.table("wealthmate_expense_groups")
                .select("id")
                .eq("couple_id", couple_id)
                .execute()
            )
            group_ids = [g["id"] for g in (groups.data or [])]
            if group_ids:
                sb.table("wealthmate_expense_items").delete().in_("group_id", group_ids).execute()

            # Delete top-level couple data
            sb.table("wealthmate_checkins").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_accounts").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_expense_groups").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_recurring_expenses").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_invitations").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_couple_members").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_couples").delete().eq("id", couple_id).execute()
        else:
            # Merged household — remove user from couple, reassign their personal accounts to partner
            sb.table("wealthmate_couple_members").delete().eq("user_id", user_id).execute()
            # Set personal accounts owned by this user to no owner (become joint)
            sb.table("wealthmate_accounts").update(
                {"owner_user_id": None}
            ).eq("couple_id", couple_id).eq("owner_user_id", user_id).execute()

    # Delete invitations sent by or to this user
    sb.table("wealthmate_invitations").delete().eq("from_user_id", user_id).execute()
    sb.table("wealthmate_invitations").delete().eq("to_username", user["username"]).execute()

    # Delete the user
    sb.table("wealthmate_users").delete().eq("id", user_id).execute()

    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Couple Management
# ---------------------------------------------------------------------------

@router.get("/couple")
async def get_couple(user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    couple = (
        sb.table("wealthmate_couples")
        .select("*")
        .eq("id", couple_id)
        .execute()
    )
    if not couple.data:
        raise HTTPException(status_code=404, detail="Couple not found")

    members = (
        sb.table("wealthmate_couple_members")
        .select("id, user_id, role, joined_at")
        .eq("couple_id", couple_id)
        .execute()
    )

    # Fetch user details for each member
    member_list = []
    for m in members.data or []:
        u = (
            sb.table("wealthmate_users")
            .select("id, username, display_name")
            .eq("id", m["user_id"])
            .execute()
        )
        member_info = {**m}
        if u.data:
            member_info["username"] = u.data[0]["username"]
            member_info["display_name"] = u.data[0]["display_name"]
        member_list.append(member_info)

    return {
        **couple.data[0],
        "members": member_list,
    }


@router.post("/couple")
async def create_couple(user: dict = Depends(get_current_user)):
    sb = get_supabase()
    # Every user gets a household on registration; return existing one
    existing = _get_couple_id_for_user(user["user_id"])
    if existing:
        return {"couple_id": existing, "role": "owner"}

    # Fallback: create one if somehow missing (e.g. legacy users)
    couple_result = sb.table("wealthmate_couples").insert({}).execute()
    if not couple_result.data:
        raise HTTPException(status_code=500, detail="Failed to create couple")
    couple_id = couple_result.data[0]["id"]

    sb.table("wealthmate_couple_members").insert({
        "couple_id": couple_id,
        "user_id": user["user_id"],
        "role": "owner",
    }).execute()

    return {"couple_id": couple_id, "role": "owner"}


@router.post("/couple/invite")
async def send_invite(body: InviteBody, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    # Cannot invite yourself
    if body.to_username == user["username"]:
        raise HTTPException(status_code=400, detail="You cannot invite yourself")

    # Check if invitee exists
    invitee = (
        sb.table("wealthmate_users")
        .select("id")
        .eq("username", body.to_username)
        .execute()
    )
    if not invitee.data:
        raise HTTPException(status_code=404, detail=f"User '{body.to_username}' not found")

    # Check if invitee is already merged with someone else
    invitee_id = invitee.data[0]["id"]
    invitee_couple = _get_couple_id_for_user(invitee_id)
    if invitee_couple:
        members = (
            sb.table("wealthmate_couple_members")
            .select("id")
            .eq("couple_id", invitee_couple)
            .execute()
        )
        if len(members.data or []) > 1:
            raise HTTPException(status_code=400, detail="That user is already merged with someone else")

    # Check for existing pending invite
    existing = (
        sb.table("wealthmate_invitations")
        .select("id")
        .eq("couple_id", couple_id)
        .eq("to_username", body.to_username)
        .eq("status", "pending")
        .execute()
    )
    if existing.data:
        raise HTTPException(status_code=400, detail="A pending invite already exists for this user")

    result = sb.table("wealthmate_invitations").insert({
        "from_user_id": user["user_id"],
        "to_username": body.to_username,
        "couple_id": couple_id,
        "status": "pending",
    }).execute()

    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create invitation")
    return result.data[0]


@router.post("/couple/invite/{invite_id}/respond")
async def respond_to_invite(invite_id: str, body: InviteRespondBody, user: dict = Depends(get_current_user)):
    if body.action not in ("accept", "decline"):
        raise HTTPException(status_code=400, detail="Action must be 'accept' or 'decline'")

    sb = get_supabase()
    # Fetch invite
    invite = (
        sb.table("wealthmate_invitations")
        .select("*")
        .eq("id", invite_id)
        .eq("status", "pending")
        .execute()
    )
    if not invite.data:
        raise HTTPException(status_code=404, detail="Invite not found or already responded")

    inv = invite.data[0]
    # Verify invite is for the current user
    if inv["to_username"] != user["username"]:
        raise HTTPException(status_code=403, detail="This invite is not for you")

    new_status = "accepted" if body.action == "accept" else "declined"
    sb.table("wealthmate_invitations").update({"status": new_status}).eq("id", invite_id).execute()

    if body.action == "accept":
        old_couple_id = _get_couple_id_for_user(user["user_id"])
        new_couple_id = inv["couple_id"]

        # Check user isn't already merged with someone else
        if old_couple_id and old_couple_id != new_couple_id:
            old_members = (
                sb.table("wealthmate_couple_members")
                .select("id")
                .eq("couple_id", old_couple_id)
                .execute()
            )
            if len(old_members.data or []) > 1:
                raise HTTPException(status_code=400, detail="You are already merged with someone else")

            # Merge: move all data from old solo household to new couple
            # Accounts
            sb.table("wealthmate_accounts").update(
                {"couple_id": new_couple_id}
            ).eq("couple_id", old_couple_id).execute()

            # Check-ins
            sb.table("wealthmate_checkins").update(
                {"couple_id": new_couple_id}
            ).eq("couple_id", old_couple_id).execute()

            # Expense groups
            sb.table("wealthmate_expense_groups").update(
                {"couple_id": new_couple_id}
            ).eq("couple_id", old_couple_id).execute()

            # Recurring expenses
            sb.table("wealthmate_recurring_expenses").update(
                {"couple_id": new_couple_id}
            ).eq("couple_id", old_couple_id).execute()

            # Remove old membership and delete old couple
            sb.table("wealthmate_couple_members").delete().eq(
                "couple_id", old_couple_id
            ).eq("user_id", user["user_id"]).execute()
            sb.table("wealthmate_couples").delete().eq("id", old_couple_id).execute()

        # Add user to the inviter's couple
        sb.table("wealthmate_couple_members").insert({
            "couple_id": new_couple_id,
            "user_id": user["user_id"],
            "role": "partner",
        }).execute()

    return {"status": new_status, "couple_id": inv["couple_id"] if body.action == "accept" else None}


@router.get("/couple/invites")
async def list_invites(user: dict = Depends(get_current_user)):
    sb = get_supabase()
    # Invites sent TO this user
    result = (
        sb.table("wealthmate_invitations")
        .select("*")
        .eq("to_username", user["username"])
        .eq("status", "pending")
        .order("created_at", desc=True)
        .execute()
    )
    invites = result.data or []

    # Enrich with sender info
    for inv in invites:
        sender = (
            sb.table("wealthmate_users")
            .select("username, display_name")
            .eq("id", inv["from_user_id"])
            .execute()
        )
        if sender.data:
            inv["from_username"] = sender.data[0]["username"]
            inv["from_display_name"] = sender.data[0]["display_name"]

    return invites


# ---------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------

@router.get("/accounts")
async def list_accounts(user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()
    result = (
        sb.table("wealthmate_accounts")
        .select("*")
        .eq("couple_id", couple_id)
        .eq("is_active", True)
        .order("sort_order")
        .execute()
    )
    accounts = result.data or []

    # Attach loan details where they exist
    account_ids = [a["id"] for a in accounts]
    if account_ids:
        loans = (
            sb.table("wealthmate_account_loan_details")
            .select("*")
            .in_("account_id", account_ids)
            .execute()
        )
        loan_map = {ld["account_id"]: ld for ld in (loans.data or [])}
        for a in accounts:
            a["loan_details"] = loan_map.get(a["id"])

    return accounts


@router.post("/accounts")
async def create_account(body: CreateAccountBody, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    account_data = {
        "couple_id": couple_id,
        "name": body.name,
        "account_type": body.account_type,
        "owner_user_id": body.owner_user_id,
        "url": body.url,
        "notes": body.notes,
        "sort_order": body.sort_order or 0,
        "is_active": True,
    }
    result = sb.table("wealthmate_accounts").insert(account_data).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create account")

    account = result.data[0]

    # Insert loan details if any provided
    has_loan_details = any([
        body.original_loan_amount, body.interest_rate,
        body.loan_term_months, body.origination_date, body.lender_name,
    ])
    if has_loan_details:
        loan_data = {
            "account_id": account["id"],
            "original_loan_amount": body.original_loan_amount,
            "interest_rate": body.interest_rate,
            "loan_term_months": body.loan_term_months,
            "origination_date": body.origination_date,
            "lender_name": body.lender_name,
        }
        sb.table("wealthmate_account_loan_details").insert(loan_data).execute()

    return account


@router.put("/accounts/{account_id}")
async def update_account(account_id: str, body: UpdateAccountBody, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    # Verify account belongs to couple
    existing = (
        sb.table("wealthmate_accounts")
        .select("id")
        .eq("id", account_id)
        .eq("couple_id", couple_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Account not found")

    # Build update dict from non-None fields (excluding loan fields)
    update_data = {}
    for field in ["name", "account_type", "owner_user_id", "url", "notes", "sort_order", "is_active"]:
        val = getattr(body, field)
        if val is not None:
            update_data[field] = val

    if update_data:
        result = sb.table("wealthmate_accounts").update(update_data).eq("id", account_id).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to update account")

    # Handle loan details (upsert)
    loan_fields = {
        "original_loan_amount": body.original_loan_amount,
        "interest_rate": body.interest_rate,
        "loan_term_months": body.loan_term_months,
        "origination_date": body.origination_date,
        "lender_name": body.lender_name,
    }
    has_loan_update = any(v is not None for v in loan_fields.values())
    if has_loan_update:
        loan_data = {k: v for k, v in loan_fields.items() if v is not None}
        loan_data["account_id"] = account_id
        sb.table("wealthmate_account_loan_details").upsert(loan_data).execute()

    # Return updated account
    updated = sb.table("wealthmate_accounts").select("*").eq("id", account_id).execute()
    return updated.data[0] if updated.data else {}


@router.delete("/accounts/{account_id}")
async def delete_account(account_id: str, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    existing = (
        sb.table("wealthmate_accounts")
        .select("id")
        .eq("id", account_id)
        .eq("couple_id", couple_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Account not found")

    sb.table("wealthmate_accounts").update({"is_active": False}).eq("id", account_id).execute()
    return {"status": "closed", "account_id": account_id}


@router.delete("/accounts/{account_id}/permanent")
async def permanently_delete_account(account_id: str, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    existing = (
        sb.table("wealthmate_accounts")
        .select("id")
        .eq("id", account_id)
        .eq("couple_id", couple_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Account not found")

    # Delete all checkin values for this account
    sb.table("wealthmate_checkin_values").delete().eq("account_id", account_id).execute()
    # Delete loan details if any
    sb.table("wealthmate_account_loan_details").delete().eq("account_id", account_id).execute()
    # Delete the account itself
    sb.table("wealthmate_accounts").delete().eq("id", account_id).execute()
    return {"status": "deleted", "account_id": account_id}


# ---------------------------------------------------------------------------
# Check-ins
# ---------------------------------------------------------------------------

@router.get("/checkins")
async def list_checkins(user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()
    result = (
        sb.table("wealthmate_checkins")
        .select("*")
        .eq("couple_id", couple_id)
        .eq("status", "submitted")
        .order("checkin_date", desc=True)
        .execute()
    )
    return result.data or []


# ---------------------------------------------------------------------------
# Check-in CSV export / import
# ---------------------------------------------------------------------------

def _clean_numeric(val: str) -> Optional[float]:
    """Strip $ and commas, return float or None for empty."""
    if val is None:
        return None
    val = val.strip().replace("$", "").replace(",", "")
    if val == "":
        return None
    return float(val)


@router.get("/checkins/export/template")
async def export_template():
    """Download an empty CSV template with example rows."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(CSV_HEADERS)
    writer.writerow(["2025-01-01", "My Checking", "Bank Account", "5000", ""])
    writer.writerow(["2025-01-01", "Home", "Property", "450000", "320000"])
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="wealthmate-template.csv"'},
    )


@router.get("/checkins/export")
async def export_checkins(user: dict = Depends(get_current_user)):
    """Download all submitted check-in history as CSV."""
    couple_id = _require_couple(user)
    sb = get_supabase()

    checkins = (
        sb.table("wealthmate_checkins")
        .select("id, checkin_date")
        .eq("couple_id", couple_id)
        .eq("status", "submitted")
        .order("checkin_date")
        .execute()
    )
    if not checkins.data:
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(CSV_HEADERS)
        buf.seek(0)
        return StreamingResponse(
            buf,
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="wealthmate-export.csv"'},
        )

    # Fetch all accounts (including inactive, for historical data)
    accts = (
        sb.table("wealthmate_accounts")
        .select("id, name, account_type")
        .eq("couple_id", couple_id)
        .order("sort_order")
        .execute()
    )
    acct_map = {a["id"]: a for a in (accts.data or [])}

    checkin_ids = [c["id"] for c in checkins.data]
    checkin_date_map = {c["id"]: c["checkin_date"] for c in checkins.data}

    all_values = (
        sb.table("wealthmate_checkin_values")
        .select("checkin_id, account_id, current_value, balance_owed")
        .in_("checkin_id", checkin_ids)
        .execute()
    )

    # Group by checkin_id
    rows_by_checkin = {}
    for v in (all_values.data or []):
        cid = v["checkin_id"]
        rows_by_checkin.setdefault(cid, []).append(v)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(CSV_HEADERS)

    for ci in checkins.data:
        ci_date = ci["checkin_date"]
        values = rows_by_checkin.get(ci["id"], [])
        # Sort by account name
        values.sort(key=lambda v: (acct_map.get(v["account_id"], {}).get("name", "")))
        for v in values:
            acct = acct_map.get(v["account_id"])
            if not acct:
                continue
            writer.writerow([
                ci_date,
                acct["name"],
                TYPE_LABEL.get(acct["account_type"], acct["account_type"]),
                v.get("current_value") if v.get("current_value") is not None else "",
                v.get("balance_owed") if v.get("balance_owed") is not None else "",
            ])

    today = date.today().isoformat()
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="wealthmate-export-{today}.csv"'},
    )


@router.post("/checkins/import")
async def import_checkins(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    """Import check-in history from a CSV file."""
    couple_id = _require_couple(user)
    sb = get_supabase()

    # Read and decode
    contents = await file.read()
    if len(contents) > 1_000_000:
        raise HTTPException(status_code=400, detail="File too large (max 1 MB)")
    text = contents.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))

    # Validate headers
    if reader.fieldnames is None or set(CSV_HEADERS) - set(reader.fieldnames):
        raise HTTPException(
            status_code=400,
            detail=f"CSV must have headers: {', '.join(CSV_HEADERS)}",
        )

    # Parse and validate rows
    rows = []
    errors = []
    for i, row in enumerate(reader, start=2):  # row 1 is header
        row_errors = []
        checkin_date = (row.get("Checkin Date") or "").strip()
        account_name = (row.get("Account Name") or "").strip()
        account_type_label = (row.get("Account Type") or "").strip()
        raw_value = (row.get("Current Value") or "").strip()
        raw_owed = (row.get("Balance Owed") or "").strip()

        # Validate date
        try:
            datetime.strptime(checkin_date, "%Y-%m-%d")
        except ValueError:
            row_errors.append(f'Row {i}: Invalid date "{checkin_date}". Use YYYY-MM-DD format.')

        # Validate account name
        if not account_name:
            row_errors.append(f"Row {i}: Account Name is required.")

        # Validate account type
        resolved_type = LABEL_TO_ACCOUNT_TYPE.get(account_type_label.lower())
        if not resolved_type:
            valid_types = ", ".join(sorted(set(TYPE_LABEL.values())))
            row_errors.append(f'Row {i}: Unknown Account Type "{account_type_label}". Valid: {valid_types}')

        # Validate numeric fields
        current_value = None
        balance_owed = None
        try:
            current_value = _clean_numeric(raw_value)
        except ValueError:
            row_errors.append(f'Row {i}: Current Value "{raw_value}" is not a valid number.')
        try:
            balance_owed = _clean_numeric(raw_owed)
        except ValueError:
            row_errors.append(f'Row {i}: Balance Owed "{raw_owed}" is not a valid number.')

        if row_errors:
            errors.extend(row_errors)
        else:
            rows.append({
                "checkin_date": checkin_date,
                "account_name": account_name,
                "account_type": resolved_type,
                "current_value": current_value,
                "balance_owed": balance_owed,
            })

    if not rows and not errors:
        raise HTTPException(status_code=400, detail="CSV file has no data rows.")

    if errors:
        raise HTTPException(status_code=400, detail={"errors": errors})

    # Group rows by date
    by_date = {}
    for r in rows:
        by_date.setdefault(r["checkin_date"], []).append(r)

    # Check which months already have submitted checkins
    skipped_dates = []
    existing_checkins = (
        sb.table("wealthmate_checkins")
        .select("checkin_date")
        .eq("couple_id", couple_id)
        .eq("status", "submitted")
        .execute()
    )
    existing_months = set()
    for ec in (existing_checkins.data or []):
        existing_months.add(ec["checkin_date"][:7])

    # Fetch existing accounts for name matching
    all_accounts = (
        sb.table("wealthmate_accounts")
        .select("id, name, account_type")
        .eq("couple_id", couple_id)
        .execute()
    )
    acct_by_name = {}
    for a in (all_accounts.data or []):
        acct_by_name[a["name"].lower()] = a

    checkins_created = 0
    values_created = 0
    accounts_created = []

    for checkin_date, date_rows in sorted(by_date.items()):
        month_key = checkin_date[:7]
        if month_key in existing_months:
            skipped_dates.append(checkin_date)
            continue

        # Create submitted checkin
        now_str = datetime.now(timezone.utc).isoformat()
        ci_result = sb.table("wealthmate_checkins").insert({
            "couple_id": couple_id,
            "initiated_by_user_id": user["user_id"],
            "checkin_date": checkin_date,
            "status": "submitted",
            "submitted_at": now_str,
        }).execute()
        if not ci_result.data:
            continue
        checkin_id = ci_result.data[0]["id"]
        checkins_created += 1

        for r in date_rows:
            # Find or create account
            acct = acct_by_name.get(r["account_name"].lower())
            if not acct:
                acct_result = sb.table("wealthmate_accounts").insert({
                    "couple_id": couple_id,
                    "name": r["account_name"],
                    "account_type": r["account_type"],
                    "is_active": True,
                    "sort_order": 0,
                }).execute()
                if acct_result.data:
                    acct = acct_result.data[0]
                    acct_by_name[r["account_name"].lower()] = acct
                    accounts_created.append(r["account_name"])
                else:
                    continue

            val_data = {
                "checkin_id": checkin_id,
                "account_id": acct["id"],
                "data_source": "imported",
            }
            if r["current_value"] is not None:
                val_data["current_value"] = r["current_value"]
            if r["balance_owed"] is not None:
                val_data["balance_owed"] = r["balance_owed"]

            sb.table("wealthmate_checkin_values").insert(val_data).execute()
            values_created += 1

    return {
        "checkins_created": checkins_created,
        "values_created": values_created,
        "accounts_created": accounts_created,
        "skipped_dates": skipped_dates,
    }


@router.get("/checkins/active")
async def get_active_checkin(user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()
    result = (
        sb.table("wealthmate_checkins")
        .select("*")
        .eq("couple_id", couple_id)
        .eq("initiated_by_user_id", user["user_id"])
        .eq("status", "in_progress")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    if not result.data:
        return None

    checkin = result.data[0]
    # Attach values
    values = (
        sb.table("wealthmate_checkin_values")
        .select("*")
        .eq("checkin_id", checkin["id"])
        .execute()
    )
    checkin["values"] = values.data or []
    return checkin


@router.post("/checkins")
async def start_checkin(body: StartCheckinBody, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    # Prevent duplicate checkins for the same month
    checkin_month = body.checkin_date[:7]  # "YYYY-MM"
    month_start = checkin_month + "-01"
    # Calculate last day of month
    y, m = int(checkin_month[:4]), int(checkin_month[5:7])
    if m == 12:
        month_end = f"{y + 1}-01-01"
    else:
        month_end = f"{y}-{m + 1:02d}-01"
    existing = (
        sb.table("wealthmate_checkins")
        .select("id")
        .eq("couple_id", couple_id)
        .eq("status", "submitted")
        .gte("checkin_date", month_start)
        .lt("checkin_date", month_end)
        .execute()
    )
    if existing.data:
        raise HTTPException(status_code=409, detail="A check-in already exists for this month")

    # Create the empty check-in
    checkin_data = {
        "couple_id": couple_id,
        "initiated_by_user_id": user["user_id"],
        "checkin_date": body.checkin_date,
        "status": "in_progress",
    }
    result = sb.table("wealthmate_checkins").insert(checkin_data).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create check-in")

    checkin = result.data[0]

    # Fetch previous submitted check-in values as hints
    previous_values = []
    prev_checkin = (
        sb.table("wealthmate_checkins")
        .select("id")
        .eq("couple_id", couple_id)
        .eq("status", "submitted")
        .order("checkin_date", desc=True)
        .limit(1)
        .execute()
    )
    if prev_checkin.data:
        prev_vals = (
            sb.table("wealthmate_checkin_values")
            .select("*")
            .eq("checkin_id", prev_checkin.data[0]["id"])
            .execute()
        )
        previous_values = prev_vals.data or []

    return {
        "checkin": checkin,
        "previous_values": previous_values,
    }


@router.get("/checkins/{checkin_id}")
async def get_checkin(checkin_id: str, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    result = (
        sb.table("wealthmate_checkins")
        .select("*")
        .eq("id", checkin_id)
        .eq("couple_id", couple_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Check-in not found")

    checkin = result.data[0]
    values = (
        sb.table("wealthmate_checkin_values")
        .select("*")
        .eq("checkin_id", checkin_id)
        .execute()
    )
    checkin["values"] = values.data or []
    return checkin


@router.put("/checkins/{checkin_id}/values/{account_id}")
async def save_checkin_value(
    checkin_id: str,
    account_id: str,
    body: SaveValueBody,
    user: dict = Depends(get_current_user),
):
    couple_id = _require_couple(user)
    sb = get_supabase()

    # Verify checkin belongs to couple and is in_progress
    checkin = (
        sb.table("wealthmate_checkins")
        .select("id, status")
        .eq("id", checkin_id)
        .eq("couple_id", couple_id)
        .execute()
    )
    if not checkin.data:
        raise HTTPException(status_code=404, detail="Check-in not found")
    if checkin.data[0]["status"] != "in_progress":
        raise HTTPException(status_code=400, detail="Check-in already submitted")

    # Verify account belongs to couple
    account = (
        sb.table("wealthmate_accounts")
        .select("id")
        .eq("id", account_id)
        .eq("couple_id", couple_id)
        .execute()
    )
    if not account.data:
        raise HTTPException(status_code=404, detail="Account not found")

    # Upsert value
    value_data = {
        "checkin_id": checkin_id,
        "account_id": account_id,
        "current_value": body.current_value,
        "balance_owed": body.balance_owed,
        "data_source": body.data_source or "manual",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    # Check if value already exists
    existing = (
        sb.table("wealthmate_checkin_values")
        .select("id")
        .eq("checkin_id", checkin_id)
        .eq("account_id", account_id)
        .execute()
    )
    if existing.data:
        result = (
            sb.table("wealthmate_checkin_values")
            .update(value_data)
            .eq("id", existing.data[0]["id"])
            .execute()
        )
    else:
        result = sb.table("wealthmate_checkin_values").insert(value_data).execute()

    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to save value")
    return result.data[0]


@router.post("/checkins/{checkin_id}/submit")
async def submit_checkin(checkin_id: str, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    checkin = (
        sb.table("wealthmate_checkins")
        .select("id, status")
        .eq("id", checkin_id)
        .eq("couple_id", couple_id)
        .execute()
    )
    if not checkin.data:
        raise HTTPException(status_code=404, detail="Check-in not found")
    if checkin.data[0]["status"] != "in_progress":
        raise HTTPException(status_code=400, detail="Check-in already submitted")

    result = (
        sb.table("wealthmate_checkins")
        .update({
            "status": "submitted",
            "submitted_at": datetime.now(timezone.utc).isoformat(),
        })
        .eq("id", checkin_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to submit check-in")
    return result.data[0]


# ---------------------------------------------------------------------------
# Wealth History
# ---------------------------------------------------------------------------

@router.get("/wealth/history")
async def wealth_history(user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    # Get all submitted check-ins ordered by date
    checkins = (
        sb.table("wealthmate_checkins")
        .select("id, checkin_date, submitted_at")
        .eq("couple_id", couple_id)
        .eq("status", "submitted")
        .order("checkin_date")
        .execute()
    )
    if not checkins.data:
        return []

    history = []
    for ci in checkins.data:
        values = (
            sb.table("wealthmate_checkin_values")
            .select("current_value, balance_owed")
            .eq("checkin_id", ci["id"])
            .execute()
        )
        gross_assets = 0.0
        total_liabilities = 0.0
        for v in (values.data or []):
            if v.get("current_value") is not None:
                gross_assets += float(v["current_value"])
            if v.get("balance_owed") is not None:
                total_liabilities += float(v["balance_owed"])

        history.append({
            "checkin_id": ci["id"],
            "checkin_date": ci["checkin_date"],
            "submitted_at": ci["submitted_at"],
            "gross_assets": gross_assets,
            "total_liabilities": total_liabilities,
            "net_worth": gross_assets - total_liabilities,
        })

    return history


@router.get("/wealth/accounts")
async def wealth_by_account(user: dict = Depends(get_current_user)):
    """Per-account values across all submitted check-ins, for account-level charts."""
    couple_id = _require_couple(user)
    sb = get_supabase()

    checkins = (
        sb.table("wealthmate_checkins")
        .select("id, checkin_date")
        .eq("couple_id", couple_id)
        .eq("status", "submitted")
        .order("checkin_date")
        .execute()
    )
    if not checkins.data:
        return {"dates": [], "accounts": []}

    accts = (
        sb.table("wealthmate_accounts")
        .select("id, name, account_type, owner_user_id")
        .eq("couple_id", couple_id)
        .eq("is_active", True)
        .order("sort_order")
        .execute()
    )
    account_list = accts.data or []

    # Gather all checkin IDs
    checkin_ids = [c["id"] for c in checkins.data]
    dates = [c["checkin_date"] for c in checkins.data]

    # Fetch all values in one query
    all_values = (
        sb.table("wealthmate_checkin_values")
        .select("checkin_id, account_id, current_value, balance_owed")
        .in_("checkin_id", checkin_ids)
        .execute()
    )
    # Index: (checkin_id, account_id) -> value row
    val_map = {}
    for v in (all_values.data or []):
        val_map[(v["checkin_id"], v["account_id"])] = v

    result_accounts = []
    for a in account_list:
        values = []
        for ci in checkins.data:
            v = val_map.get((ci["id"], a["id"]))
            if v:
                # For loans: net = (current_value or 0) - (balance_owed or 0)
                cv = float(v["current_value"]) if v.get("current_value") is not None else 0
                bo = float(v["balance_owed"]) if v.get("balance_owed") is not None else 0
                values.append({"value": cv, "owed": bo})
            else:
                values.append(None)
        result_accounts.append({
            "id": a["id"],
            "name": a["name"],
            "account_type": a["account_type"],
            "owner_user_id": a["owner_user_id"],
            "values": values,
        })

    return {"dates": dates, "accounts": result_accounts}


# ---------------------------------------------------------------------------
# Large Expenses
# ---------------------------------------------------------------------------

@router.get("/expenses")
async def list_expense_groups(user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    groups = (
        sb.table("wealthmate_expense_groups")
        .select("*")
        .eq("couple_id", couple_id)
        .order("created_at", desc=True)
        .execute()
    )
    group_list = groups.data or []

    # Attach item totals
    for g in group_list:
        items = (
            sb.table("wealthmate_expense_items")
            .select("amount")
            .eq("group_id", g["id"])
            .execute()
        )
        g["total"] = sum(float(i["amount"]) for i in (items.data or []))
        g["item_count"] = len(items.data or [])

    return group_list


@router.post("/expenses")
async def create_expense_group(body: CreateExpenseGroupBody, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    result = sb.table("wealthmate_expense_groups").insert({
        "couple_id": couple_id,
        "name": body.name,
        "description": body.description,
    }).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create expense group")
    return result.data[0]


@router.get("/expenses/{group_id}")
async def get_expense_group(group_id: str, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    group = (
        sb.table("wealthmate_expense_groups")
        .select("*")
        .eq("id", group_id)
        .eq("couple_id", couple_id)
        .execute()
    )
    if not group.data:
        raise HTTPException(status_code=404, detail="Expense group not found")

    items = (
        sb.table("wealthmate_expense_items")
        .select("*")
        .eq("group_id", group_id)
        .order("created_at")
        .execute()
    )

    result = group.data[0]
    result["items"] = items.data or []
    result["total"] = sum(float(i["amount"]) for i in result["items"])
    return result


@router.post("/expenses/{group_id}/items")
async def add_expense_item(group_id: str, body: AddExpenseItemBody, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    # Verify group belongs to couple
    group = (
        sb.table("wealthmate_expense_groups")
        .select("id")
        .eq("id", group_id)
        .eq("couple_id", couple_id)
        .execute()
    )
    if not group.data:
        raise HTTPException(status_code=404, detail="Expense group not found")

    result = sb.table("wealthmate_expense_items").insert({
        "group_id": group_id,
        "description": body.description,
        "amount": body.amount,
        "item_date": body.item_date,
    }).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to add expense item")
    return result.data[0]


@router.delete("/expenses/{group_id}/items/{item_id}")
async def delete_expense_item(group_id: str, item_id: str, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    # Verify group belongs to couple
    group = (
        sb.table("wealthmate_expense_groups")
        .select("id")
        .eq("id", group_id)
        .eq("couple_id", couple_id)
        .execute()
    )
    if not group.data:
        raise HTTPException(status_code=404, detail="Expense group not found")

    # Verify item belongs to group
    item = (
        sb.table("wealthmate_expense_items")
        .select("id")
        .eq("id", item_id)
        .eq("group_id", group_id)
        .execute()
    )
    if not item.data:
        raise HTTPException(status_code=404, detail="Expense item not found")

    sb.table("wealthmate_expense_items").delete().eq("id", item_id).execute()
    return {"status": "deleted", "item_id": item_id}


# ---------------------------------------------------------------------------
# Recurring Expenses (Monthly Bills)
# ---------------------------------------------------------------------------

FREQUENCY_MONTHLY_MULTIPLIER = {
    "weekly": 4.333,
    "monthly": 1.0,
    "quarterly": 1.0 / 3.0,
    "yearly": 1.0 / 12.0,
}

@router.get("/recurring-expenses")
async def list_recurring_expenses(user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()
    result = (
        sb.table("wealthmate_recurring_expenses")
        .select("*")
        .eq("couple_id", couple_id)
        .eq("is_active", True)
        .order("created_at", desc=True)
        .execute()
    )
    items = result.data or []

    # Calculate monthly equivalent for each item
    for item in items:
        freq = item.get("frequency", "monthly")
        mult = FREQUENCY_MONTHLY_MULTIPLIER.get(freq, 1.0)
        item["monthly_amount"] = round(float(item["amount"]) * mult, 2)

    # Summary
    monthly_total = sum(item["monthly_amount"] for item in items)
    yearly_total = monthly_total * 12

    return {
        "items": items,
        "monthly_total": round(monthly_total, 2),
        "yearly_total": round(yearly_total, 2),
    }


@router.post("/recurring-expenses")
async def create_recurring_expense(body: CreateRecurringExpenseBody, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    data = {
        "couple_id": couple_id,
        "name": body.name,
        "amount": body.amount,
        "frequency": body.frequency or "monthly",
        "category": body.category or "other",
        "start_date": body.start_date,
        "notes": body.notes,
        "is_active": True,
    }
    result = sb.table("wealthmate_recurring_expenses").insert(data).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create recurring expense")
    return result.data[0]


@router.put("/recurring-expenses/{expense_id}")
async def update_recurring_expense(expense_id: str, body: UpdateRecurringExpenseBody, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    existing = (
        sb.table("wealthmate_recurring_expenses")
        .select("id")
        .eq("id", expense_id)
        .eq("couple_id", couple_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Recurring expense not found")

    update_data = {}
    for field in ["name", "amount", "frequency", "category", "start_date", "notes", "is_active"]:
        val = getattr(body, field)
        if val is not None:
            update_data[field] = val

    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    result = sb.table("wealthmate_recurring_expenses").update(update_data).eq("id", expense_id).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to update recurring expense")
    return result.data[0]


@router.delete("/recurring-expenses/{expense_id}")
async def delete_recurring_expense(expense_id: str, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    existing = (
        sb.table("wealthmate_recurring_expenses")
        .select("id")
        .eq("id", expense_id)
        .eq("couple_id", couple_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Recurring expense not found")

    sb.table("wealthmate_recurring_expenses").update({"is_active": False}).eq("id", expense_id).execute()
    return {"status": "deleted", "expense_id": expense_id}
