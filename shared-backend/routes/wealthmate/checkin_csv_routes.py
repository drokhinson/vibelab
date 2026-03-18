"""Check-in CSV export and import routes."""

import csv
import io
from datetime import datetime, date, timezone
from typing import Optional

from fastapi import Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse

from db import get_supabase
from . import router
from .dependencies import get_current_user, _require_couple
from .constants import TYPE_LABEL, LABEL_TO_ACCOUNT_TYPE, CSV_HEADERS


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
