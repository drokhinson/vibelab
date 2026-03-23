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
- Password/JWT helpers: import from `auth.py`, not local wrappers in `dependencies.py`.
- Bearer token parsing: use `extract_bearer_token()` from `auth.py` inside `get_current_user()` implementations.

## Shared Modules (`shared-backend/`)
- **`auth.py`** — Generic bcrypt + JWT helpers: `hash_password`, `verify_password`, `create_token`, `decode_token`, `extract_bearer_token`, `require_admin`.
- **`shared_models.py`** — Common Pydantic response models: `HealthResponse`, `StatusResponse`, `ErrorDetail`. Use these across all projects.
- **`db.py`** — Supabase client singleton via `get_supabase()`.
- When a new app needs login/user management, import from `auth.py` instead of reimplementing.
- Each app's `dependencies.py` should define `create_app_token()` and `decode_app_token()` (with app-specific JWT secret/payload) and `get_current_user()` (using `extract_bearer_token()`).
- Each app keeps its own `{app}_users` table following the same schema pattern as `wealthmate_users`.

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
