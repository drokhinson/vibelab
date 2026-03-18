"""Check-in lifecycle routes: list, create, get, save values, submit."""

from datetime import datetime, timezone

from fastapi import Depends, HTTPException

from db import get_supabase
from . import router
from .dependencies import get_current_user, _require_couple
from .models import StartCheckinBody, SaveValueBody
from .constants import CheckinStatus


@router.get("/checkins")
async def list_checkins(user: dict = Depends(get_current_user)):
    """List all submitted check-ins for the current household."""
    couple_id = _require_couple(user)
    sb = get_supabase()
    result = (
        sb.table("wealthmate_checkins")
        .select("*")
        .eq("couple_id", couple_id)
        .eq("status", CheckinStatus.SUBMITTED)
        .order("checkin_date", desc=True)
        .execute()
    )
    return result.data or []


@router.get("/checkins/active")
async def get_active_checkin(user: dict = Depends(get_current_user)):
    """Get the current in-progress check-in, if any."""
    couple_id = _require_couple(user)
    sb = get_supabase()
    result = (
        sb.table("wealthmate_checkins")
        .select("*")
        .eq("couple_id", couple_id)
        .eq("initiated_by_user_id", user["user_id"])
        .eq("status", CheckinStatus.IN_PROGRESS)
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
    """Start a new check-in for the current month."""
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
        .eq("status", CheckinStatus.SUBMITTED)
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
        "status": CheckinStatus.IN_PROGRESS,
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
        .eq("status", CheckinStatus.SUBMITTED)
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
    """Get a specific check-in with its values."""
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
    """Save or update a single account value within a check-in."""
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
    if checkin.data[0]["status"] != CheckinStatus.IN_PROGRESS:
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
    """Mark a check-in as submitted."""
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
    if checkin.data[0]["status"] != CheckinStatus.IN_PROGRESS:
        raise HTTPException(status_code=400, detail="Check-in already submitted")

    result = (
        sb.table("wealthmate_checkins")
        .update({
            "status": CheckinStatus.SUBMITTED,
            "submitted_at": datetime.now(timezone.utc).isoformat(),
        })
        .eq("id", checkin_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to submit check-in")
    return result.data[0]
