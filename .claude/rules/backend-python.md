---
paths:
  - "shared-backend/**"
---

# Backend & Python Conventions

## FastAPI Routes (`shared-backend/`)
- All routes namespaced: `/api/v1/[project]/[resource]`
- `async def` for all route handlers.
- Register every new router in `shared-backend/main.py` via `from routes import [project]`.
- `db.py` exports `get_supabase()`. Never import `supabase` directly in route files.
- Do not add auth unless STRUCTURE.md says it is required.
- Always include `GET /api/v1/[project]/health` that returns `{"project": "[name]", "status": "ok"}`.

## Python Code Quality

**Type annotations (required on all functions):**
- All route handlers: annotate every parameter and return type.
- All private helpers (`_foo()`): annotate params and return type.
- FastAPI dependencies (`get_current_user`): return a typed Pydantic model, not `dict`.
- Type the Supabase client parameter as `Client` from `supabase`.

**Pydantic models (not dicts):**
- Every request body must use a Pydantic `BaseModel`.
- Every route must declare `response_model=` in its decorator with a Pydantic model.
- Common response shapes (health, auth token, message confirmations) get shared models in the project's `models.py`.
- Name response models with a `Response` suffix: `HealthResponse`, `TokenResponse`, `MessageResponse`.

**Enums instead of string literals:**
- Any fixed set of string values (account types, statuses, seasons, frequencies) must be a `class MyEnum(StrEnum)` (from `enum`) in the project's `constants.py`.
- Use these enums in Pydantic model fields — this provides automatic validation and Swagger dropdowns.
- Database string values map 1:1 to enum member values. `StrEnum` is backwards-compatible (`str(MyEnum.FOO)` returns the raw string).

**Swagger / OpenAPI readability:**
- Every route decorator must include: `response_model`, `status_code`, `summary`.
- Every route handler must have a one-line docstring (shows as description in Swagger).
- Path params use `Path(..., description="...")`. Query params use `Query(..., description="...")`.
- `main.py` defines `openapi_tags` metadata for all project routers.

**No duplicate utilities:**
- Admin auth checking: use `require_admin()` from `auth.py`, not per-file private helpers.
- User auth: use `get_supabase_user()` from `supabase_auth.py` — never reimplement JWT decoding per app.
- Admin user deletion: use `delete_auth_user()` from `db.py`, which calls the Supabase Auth admin API and relies on `ON DELETE CASCADE` from `auth.users` → `{app}_profiles` to clean up app data.

## Shared Modules (`shared-backend/`)
- **`supabase_auth.py`** — `get_supabase_user()` FastAPI dependency that decodes Supabase-issued JWTs using `SUPABASE_JWT_SECRET`. Returns `{"user_id": ..., "email": ..., "user_metadata": ...}`.
- **`auth.py`** — `require_admin()` for admin-key-protected routes. No bcrypt/JWT helpers anymore — all user auth goes through Supabase Auth.
- **`shared_models.py`** — Common Pydantic response models: `HealthResponse`, `StatusResponse`, `ErrorDetail`. Use these across all projects.
- **`db.py`** — Supabase client singleton via `get_supabase()`, plus `delete_auth_user(user_id)` for admin deletes.

## Auth Pattern (all apps)
Every app uses Supabase Auth for user accounts:
- Frontend calls `sb.auth.signUp()` / `sb.auth.signInWithPassword()` via the Supabase JS client.
- After sign-up, the frontend POSTs to `/api/v1/{app}/auth/profile` (Bearer Supabase JWT) to create a row in `{app}_profiles`.
- Every `{app}_profiles` table has `id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE`, so deleting the auth user cascades through all app data.
- Each app's `dependencies.py` defines `get_current_user()` that wraps `get_supabase_user()` and enriches it with app-specific context (e.g. WealthMate looks up `couple_id` from `wealthmate_couple_members`).
- There is **no** per-app JWT secret or bcrypt hash. `SUPABASE_JWT_SECRET` is set once in Railway and used by `supabase_auth.py`.

## Modular Backend File Structure

Convert `routes/[project].py` into a `routes/[project]/` package. `main.py` still does `from routes import [project]` — Python resolves through `__init__.py`.

| File | Purpose |
|------|---------|
| `__init__.py` | Creates `router = APIRouter(prefix=...)`, imports all sub-modules |
| `models.py` | Pydantic request/response models |
| `constants.py` | Lookup tables, config values, enums |
| `dependencies.py` | `get_current_user()`, auth helpers, shared FastAPI dependencies |
| `[domain]_routes.py` | One file per route group (e.g. `auth_routes.py`, `account_routes.py`) |

Each sub-module imports `router` from `__init__.py` via `from . import router` and decorates routes onto it.

**When to split:** Start with a single file during initial prototyping. Split once any file exceeds ~300 lines or has 3+ distinct feature areas.

## Add an API endpoint to an existing project
1. Edit the relevant file in `shared-backend/routes/[project]/` (e.g. `account_routes.py`)
2. Update STRUCTURE.md → API Endpoints section
3. Test locally using the venv workflow
4. Push — Railway auto-deploys
