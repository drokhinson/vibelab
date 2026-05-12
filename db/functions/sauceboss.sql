-- ─────────────────────────────────────────────────────────────────────────────
-- SauceBoss — RPC function inventory
-- Last updated: 2026-05-12
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Trigger functions ───────────────────────────────────────────────────────

-- sauceboss_sauce_items_check()
--   Signature : () → TRIGGER
--   Language  : plpgsql
--   Defined in: sauceboss/001_baseline.sql
--   Purpose   : Enforces dish-level shape invariants on sauceboss_dish.


-- ── Read functions (public RPC) ─────────────────────────────────────────────

-- get_sauceboss_items_by_category(p_category TEXT)
--   Signature : (p_category TEXT) → JSON
--   Language  : SQL STABLE
--   Defined in: sauceboss/001_baseline.sql
--   Called by : (legacy — superseded by initial_load / item_load)
--   Purpose   : Per-category dish-row listing.

-- get_sauceboss_initial_load()
--   Signature : () → JSON
--   Language  : SQL STABLE
--   Defined in: sauceboss/001_baseline.sql
--   Called by : shared-backend/routes/sauceboss/public_routes.py (via generic loader)
--   Purpose   : Home-screen load: carbs + proteins + salad bases in one call.

-- get_sauceboss_variants_for_item(p_item_id TEXT)
--   Signature : (p_item_id TEXT) → JSON
--   Language  : SQL STABLE
--   Defined in: sauceboss/001_baseline.sql
--   Purpose   : Child rows (subtypes) for a dish item, ordered by sort_order.

-- get_sauceboss_sauces_for_item(p_item_id TEXT)
--   Signature : (p_item_id TEXT) → JSON
--   Language  : SQL STABLE
--   Defined in: sauceboss/001_baseline.sql
--   Purpose   : Fully assembled sauce objects + normalized ingredients for an item.

-- get_sauceboss_ingredients_for_item(p_item_id TEXT)
--   Signature : (p_item_id TEXT) → JSON
--   Language  : SQL STABLE
--   Defined in: sauceboss/001_baseline.sql
--   Purpose   : Distinct ingredient names across all sauces linked to an item.

-- get_sauceboss_item_load(p_item_id TEXT)
--   Signature : (p_item_id TEXT) → JSON
--   Language  : SQL STABLE
--   Defined in: sauceboss/001_baseline.sql
--   Purpose   : Combined load: item + variants + sauces + ingredients (one round-trip).

-- get_sauceboss_all_sauces()
--   Signature : () → JSON
--   Language  : SQL STABLE
--   Defined in: sauceboss/001_baseline.sql
--   Called by : shared-backend/routes/sauceboss/admin_routes.py
--   Purpose   : Admin sauce listing with compatible dish items.

-- get_sauceboss_all_sauces_full()
--   Signature : () → JSON
--   Language  : SQL STABLE
--   Defined in: sauceboss/001_baseline.sql
--   Called by : shared-backend/routes/sauceboss/public_routes.py
--              shared-backend/routes/sauceboss/import_export_routes.py
--   Purpose   : Full sauces grid with normalized ingredients, steps, and dish links.

-- get_sauceboss_ingredient_categories()
--   Signature : () → JSON
--   Language  : SQL STABLE
--   Defined in: sauceboss/001_baseline.sql
--   Purpose   : Lookup table: ingredient name → category (Produce, Dairy, etc.).

-- get_sauceboss_substitutions()
--   Signature : () → JSON
--   Language  : SQL STABLE
--   Defined in: sauceboss/001_baseline.sql
--   Purpose   : Ingredient substitution mappings.

-- get_sauceboss_distinct_cuisines()
--   Signature : () → JSON
--   Language  : SQL STABLE
--   Defined in: sauceboss/016_browse_filters.sql
--   Called by : shared-backend/routes/sauceboss/public_routes.py
--   Purpose   : All cuisines appearing on ≥1 sauce with emoji from sauceboss_cuisine_info.

-- get_sauceboss_filter_dishes()
--   Signature : () → JSON
--   Language  : SQL STABLE
--   Defined in: sauceboss/016_browse_filters.sql
--   Called by : shared-backend/routes/sauceboss/public_routes.py
--   Purpose   : Dish-level items (category + name) targeted by ≥1 sauce.

-- get_sauceboss_pantry_for_user(p_user_id UUID)
--   Signature : (p_user_id UUID) → JSON
--   Language  : plpgsql
--   Defined in: sauceboss/015_pantry_category.sql  (latest; first in 013)
--   Called by : shared-backend/routes/sauceboss/pantry_routes.py
--   Purpose   : Retrieve pantry for user with ingredient names, categories, and missing flags.

-- get_sauceboss_browse(...)
--   Signature : (p_user_id UUID, p_q TEXT, p_cuisines TEXT[], p_types TEXT[],
--                p_dishes TEXT[], p_author UUID, p_limit INT, p_offset INT) → JSON
--   Language  : plpgsql STABLE
--   Defined in: sauceboss/016_browse_filters.sql
--   Called by : shared-backend/routes/sauceboss/saucebook_routes.py
--   Purpose   : Paginated, filterable browse of all sauces (family roots only).

-- get_sauceboss_browse_authors(p_q TEXT)
--   Signature : (p_q TEXT) → JSON
--   Language  : SQL STABLE
--   Defined in: sauceboss/013_table_rename_consolidation.sql
--   Called by : shared-backend/routes/sauceboss/saucebook_routes.py
--   Purpose   : Autocomplete for browse author filter; profiles that authored ≥1 sauce.

-- get_sauceboss_saucebook(p_user_id UUID)
--   Signature : (p_user_id UUID) → JSON
--   Language  : plpgsql STABLE
--   Defined in: sauceboss/019_default_servings.sql
--   Called by : shared-backend/routes/sauceboss/saucebook_routes.py
--   Purpose   : User's saved sauces with addedAt, variantCount, attachments, ingredientNames.

-- list_sauceboss_ingredients_with_usage()
--   Signature : () → JSON
--   Language  : SQL STABLE
--   Defined in: sauceboss/013_table_rename_consolidation.sql
--   Called by : (via legacy alias list_sauceboss_foods_with_usage)
--   Purpose   : Ingredients + recipe usage counts (ingredient admin panel).


-- ── Write functions (public RPC) ────────────────────────────────────────────

-- upsert_sauceboss_ingredient_category(p_ingredient_name TEXT, p_category TEXT)
--   Signature : (p_ingredient_name TEXT, p_category TEXT) → VOID
--   Language  : plpgsql
--   Defined in: sauceboss/001_baseline.sql
--   Called by : shared-backend/routes/sauceboss/public_routes.py
--   Purpose   : Insert/update ingredient classification (used at sauce-creation time).

-- create_sauceboss_sauce(p_data JSONB)
--   Signature : (p_data JSONB) → TEXT
--   Language  : plpgsql
--   Defined in: sauceboss/019_default_servings.sql  (latest; first in 001)
--   Called by : shared-backend/routes/sauceboss/public_routes.py
--   Purpose   : Atomic sauce creation; auto-upserts ingredients; returns sauce_id.

-- update_sauceboss_sauce(p_data JSONB)
--   Signature : (p_data JSONB) → TEXT
--   Language  : plpgsql
--   Defined in: sauceboss/019_default_servings.sql
--   Called by : shared-backend/routes/sauceboss/public_routes.py
--   Purpose   : Atomic full-replace of sauce scalars, items, steps, ingredients.

-- fork_sauceboss_sauce(p_source_id TEXT, p_user UUID, p_data JSONB)
--   Signature : (p_source_id TEXT, p_user UUID, p_data JSONB) → TEXT
--   Language  : plpgsql
--   Defined in: sauceboss/019_default_servings.sql
--   Called by : shared-backend/routes/sauceboss/public_routes.py
--   Purpose   : Create new sauce variant under family root; copy/override attachments.

-- set_sauceboss_pantry_missing(p_user_id UUID, p_ingredient_ids TEXT[])
--   Signature : (p_user_id UUID, p_ingredient_ids TEXT[]) → JSON
--   Language  : plpgsql
--   Defined in: sauceboss/013_table_rename_consolidation.sql
--   Called by : shared-backend/routes/sauceboss/pantry_routes.py
--   Purpose   : Replace user's missing ingredient set in one call.

-- merge_sauceboss_ingredients(p_keep TEXT, p_merge TEXT[])
--   Signature : (p_keep TEXT, p_merge TEXT[]) → INT
--   Language  : plpgsql
--   Defined in: sauceboss/013_table_rename_consolidation.sql
--   Called by : shared-backend/routes/sauceboss/admin_routes.py
--   Purpose   : Atomic merge: repoint ingredient references, delete merged rows.

-- delete_sauceboss_ingredient_safe(p_id TEXT)
--   Signature : (p_id TEXT) → INT
--   Language  : plpgsql
--   Defined in: sauceboss/013_table_rename_consolidation.sql
--   Called by : shared-backend/routes/sauceboss/admin_routes.py
--   Purpose   : Refuse delete if ingredient is still in use; returns usage count.


-- ── Legacy aliases (delegate to renamed versions) ───────────────────────────
-- Kept callable for one release window so unmigrated code keeps working.
-- Defined in: sauceboss/013_table_rename_consolidation.sql

-- list_sauceboss_foods_with_usage()  →  list_sauceboss_ingredients_with_usage()
-- merge_sauceboss_foods(p_keep_id TEXT, p_merge_ids TEXT[])  →  merge_sauceboss_ingredients()
-- delete_sauceboss_food_safe(p_id TEXT)  →  delete_sauceboss_ingredient_safe()
