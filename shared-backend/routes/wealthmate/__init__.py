"""
routes/wealthmate/ — WealthMate API routes package
All routes at /api/v1/wealthmate/...
Auth: Supabase Auth (email/password) — see supabase_auth.py

Supabase tables (all prefixed wealthmate_):
  wealthmate_profiles           — id (→ auth.users), username, display_name, email
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

from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/wealthmate", tags=["wealthmate"])

# Import sub-modules to register their routes on this router
from . import auth_routes      # noqa: F401, E402
from . import couple_routes    # noqa: F401, E402
from . import account_routes   # noqa: F401, E402
from . import checkin_csv_routes  # noqa: F401, E402  (before checkin_routes for path priority)
from . import checkin_routes   # noqa: F401, E402
from . import wealth_routes    # noqa: F401, E402
from . import expense_routes   # noqa: F401, E402
