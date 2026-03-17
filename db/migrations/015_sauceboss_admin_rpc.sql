-- ─────────────────────────────────────────────────────────────────────────────
-- 015_sauceboss_admin_rpc.sql
-- Adds RPC for the admin sauce management screen.
-- Returns all sauces with compatible carbs for the admin list view.
-- Run in Supabase dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_sauceboss_all_sauces()
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(
      json_build_object(
        'id',              s.id,
        'name',            s.name,
        'cuisine',         s.cuisine,
        'color',           s.color,
        'description',     s.description,
        'compatible_carbs', (
          SELECT json_agg(sc.carb_id ORDER BY sc.carb_id)
          FROM sauceboss_sauce_carbs sc
          WHERE sc.sauce_id = s.id
        )
      )
      ORDER BY s.cuisine, s.name
    ), '[]'::json)
    FROM sauceboss_sauces s
  );
END;
$$;
