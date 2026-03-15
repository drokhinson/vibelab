"""Expense group/item routes and recurring expense (monthly bills) routes."""

from fastapi import Depends, HTTPException

from db import get_supabase
from . import router
from .dependencies import get_current_user, _require_couple
from .models import (
    CreateExpenseGroupBody, AddExpenseItemBody,
    CreateRecurringExpenseBody, UpdateRecurringExpenseBody,
)
from .constants import FREQUENCY_MONTHLY_MULTIPLIER


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
