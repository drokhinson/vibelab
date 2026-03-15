"""Account CRUD routes."""

from fastapi import Depends, HTTPException

from db import get_supabase
from . import router
from .dependencies import get_current_user, _require_couple
from .models import CreateAccountBody, UpdateAccountBody


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
