"""Auth helpers and FastAPI dependencies for PlantPlanner (Supabase Auth)."""

from fastapi import Depends

from jwt_auth import SupabaseUser, get_current_supabase_user


async def get_current_user(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> dict:
    """FastAPI dependency — decode Supabase Auth JWT from Authorization header."""
    return {"user_id": su_user.sub, "email": su_user.email}
