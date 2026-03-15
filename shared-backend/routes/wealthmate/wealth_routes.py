"""Wealth history routes."""

from fastapi import Depends

from db import get_supabase
from . import router
from .dependencies import get_current_user, _require_couple


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
