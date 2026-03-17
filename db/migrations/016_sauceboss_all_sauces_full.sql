-- ─────────────────────────────────────────────────────────────────────────────
-- 016_sauceboss_all_sauces_full.sql
-- Adds RPC for the guest sauce manager: all sauces with full steps & ingredients.
-- Run in Supabase dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_sauceboss_all_sauces_full()
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'cuisine', sauce_obj->>'name'), '[]'::json)
    FROM (
      SELECT json_build_object(
        'id', s.id,
        'name', s.name,
        'cuisine', s.cuisine,
        'cuisineEmoji', s.cuisine_emoji,
        'color', s.color,
        'description', s.description,
        'compatibleCarbs', (
          SELECT COALESCE(json_agg(sc2.carb_id), '[]'::json)
          FROM sauceboss_sauce_carbs sc2
          WHERE sc2.sauce_id = s.id
        ),
        'ingredients', (
          SELECT COALESCE(json_agg(
            json_build_object('name', si.name, 'amount', si.amount, 'unit', si.unit)
            ORDER BY ss_flat.step_order, si.id
          ), '[]'::json)
          FROM (
            SELECT DISTINCT ON (si_inner.name) si_inner.*, ss_inner.step_order
            FROM sauceboss_sauce_steps ss_inner
            JOIN sauceboss_step_ingredients si_inner ON si_inner.step_id = ss_inner.id
            WHERE ss_inner.sauce_id = s.id
            ORDER BY si_inner.name, ss_inner.step_order, si_inner.id
          ) si
          JOIN sauceboss_sauce_steps ss_flat ON ss_flat.id = si.step_id
        ),
        'steps', (
          SELECT COALESCE(json_agg(
            json_build_object(
              'title', ss.title,
              'estimatedTime', ss.estimated_time,
              'inputFromStep', ss.input_from_step,
              'ingredients', (
                SELECT COALESCE(json_agg(
                  json_build_object('name', si.name, 'amount', si.amount, 'unit', si.unit)
                  ORDER BY si.id
                ), '[]'::json)
                FROM sauceboss_step_ingredients si
                WHERE si.step_id = ss.id
              )
            )
            ORDER BY ss.step_order
          ), '[]'::json)
          FROM sauceboss_sauce_steps ss
          WHERE ss.sauce_id = s.id
        )
      ) AS sauce_obj
      FROM sauceboss_sauces s
    ) sub
  );
END;
$$;
