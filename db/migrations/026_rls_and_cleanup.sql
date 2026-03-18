-- ─────────────────────────────────────────────────────────────────────────────
-- 026_rls_and_cleanup.sql
-- 1. Enable RLS on all 43 public tables
-- 2. Drop two unused columns: plantplanner_plants.render_params,
--    daywordplay_users.recovery_hash
--
-- WHY RLS: All access goes through the FastAPI backend using SUPABASE_SERVICE_ROLE_KEY,
-- which bypasses RLS. Enabling RLS with no policies locks out the anon key from
-- hitting tables directly via Supabase's REST API, without affecting the backend.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Drop unused columns ───────────────────────────────────────────────────────

-- plantplanner_plants.render_params: JSONB added for future Three.js 3D rendering,
-- never referenced in any backend route or RPC.
ALTER TABLE public.plantplanner_plants DROP COLUMN IF EXISTS render_params;

-- daywordplay_users.recovery_hash: password recovery was never implemented
-- for daywordplay (unlike wealthmate/spotme which both use it).
ALTER TABLE public.daywordplay_users DROP COLUMN IF EXISTS recovery_hash;


-- ── Enable RLS: SauceBoss (12 tables) ────────────────────────────────────────

ALTER TABLE public.sauceboss_carbs                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sauceboss_sauces                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sauceboss_sauce_carbs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sauceboss_sauce_steps            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sauceboss_step_ingredients       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sauceboss_ingredient_categories  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sauceboss_ingredient_substitutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sauceboss_carb_preparations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sauceboss_addons                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sauceboss_salad_bases            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sauceboss_sauce_salad_bases      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sauceboss_sauce_proteins         ENABLE ROW LEVEL SECURITY;


-- ── Enable RLS: WealthMate (11 tables) ───────────────────────────────────────

ALTER TABLE public.wealthmate_users                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wealthmate_couples               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wealthmate_couple_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wealthmate_invitations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wealthmate_accounts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wealthmate_account_loan_details  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wealthmate_checkins              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wealthmate_checkin_values        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wealthmate_expense_groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wealthmate_expense_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wealthmate_recurring_expenses    ENABLE ROW LEVEL SECURITY;


-- ── Enable RLS: SpotMe (5 tables) ────────────────────────────────────────────

ALTER TABLE public.spotme_users                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spotme_hobby_categories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spotme_hobbies                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spotme_user_hobbies              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spotme_hobby_levels              ENABLE ROW LEVEL SECURITY;


-- ── Enable RLS: Day Word Play (8 tables) ─────────────────────────────────────

ALTER TABLE public.daywordplay_users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daywordplay_groups               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daywordplay_group_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daywordplay_words                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daywordplay_daily_words          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daywordplay_sentences            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daywordplay_votes                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daywordplay_bookmarks            ENABLE ROW LEVEL SECURITY;


-- ── Enable RLS: PlantPlanner (4 tables) ──────────────────────────────────────

ALTER TABLE public.plantplanner_users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plantplanner_plants              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plantplanner_gardens             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plantplanner_garden_plants       ENABLE ROW LEVEL SECURITY;


-- ── Enable RLS: Analytics (1 table) ──────────────────────────────────────────

ALTER TABLE public.analytics_events                 ENABLE ROW LEVEL SECURITY;
