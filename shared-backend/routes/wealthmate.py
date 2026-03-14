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
"""

import os
from datetime import datetime, date, timezone
from typing import Optional

import bcrypt
import jwt
from fastapi import APIRouter, HTTPException, Depends, Header
from pydantic import BaseModel

from db import get_supabase

router = APIRouter(prefix="/api/v1/wealthmate", tags=["wealthmate"])

JWT_SECRET = os.environ.get("WEALTHMATE_JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class RegisterBody(BaseModel):
    username: str
    password: str
    display_name: Optional[str] = None

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

# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------

def _hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def _verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))


def _create_token(user_id: str, username: str, couple_id: Optional[str] = None) -> str:
    payload = {
        "user_id": user_id,
        "username": username,
        "couple_id": couple_id,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


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
    payload["couple_id"] = _get_couple_id_for_user(payload["user_id"])
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
    user_data = {
        "username": body.username,
        "display_name": body.display_name or body.username,
        "password_hash": password_hash,
    }
    result = sb.table("wealthmate_users").insert(user_data).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create user")

    user = result.data[0]
    token = _create_token(user["id"], user["username"])
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"],
        },
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


@router.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    sb = get_supabase()
    result = (
        sb.table("wealthmate_users")
        .select("id, username, display_name, created_at")
        .eq("id", user["user_id"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found")
    u = result.data[0]
    u["couple_id"] = user["couple_id"]
    return u


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
    # Check user not already in a couple
    existing = _get_couple_id_for_user(user["user_id"])
    if existing:
        raise HTTPException(status_code=400, detail="You are already part of a couple")

    # Create couple
    couple_result = sb.table("wealthmate_couples").insert({}).execute()
    if not couple_result.data:
        raise HTTPException(status_code=500, detail="Failed to create couple")
    couple_id = couple_result.data[0]["id"]

    # Add caller as owner
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

    # Check if invitee is already in a couple
    invitee_couple = _get_couple_id_for_user(invitee.data[0]["id"])
    if invitee_couple:
        raise HTTPException(status_code=400, detail="That user is already part of a couple")

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
        # Check user not already in a couple
        existing = _get_couple_id_for_user(user["user_id"])
        if existing:
            raise HTTPException(status_code=400, detail="You are already part of a couple")
        # Add user to the couple
        sb.table("wealthmate_couple_members").insert({
            "couple_id": inv["couple_id"],
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
