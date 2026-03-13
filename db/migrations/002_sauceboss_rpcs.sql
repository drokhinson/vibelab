-- ─────────────────────────────────────────────────────────────────────────────
-- 002_sauceboss_rpcs.sql
-- Supabase RPC functions for SauceBoss.
-- These replace the complex multi-table JS queries in the original database.js.
-- Run AFTER 001_sauceboss_schema.sql and 003_sauceboss_seed.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ── get_sauceboss_carbs_with_count ────────────────────────────────────────────
-- Returns all carbs with the count of compatible sauces.
-- Mirrors getCarbs() in database.js
CREATE OR REPLACE FUNCTION get_sauceboss_carbs_with_count()
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT json_agg(row_to_json(t) ORDER BY t.rownum)
    FROM (
      SELECT c.id, c.name, c.emoji, c.description,
             COUNT(sc.sauce_id)::int AS "sauceCount",
             ROW_NUMBER() OVER () AS rownum
      FROM sauceboss_carbs c
      LEFT JOIN sauceboss_sauce_carbs sc ON sc.carb_id = c.id
      GROUP BY c.id, c.name, c.emoji, c.description
    ) t
  );
END;
$$;

-- ── get_sauceboss_sauces_for_carb ─────────────────────────────────────────────
-- Returns fully assembled sauce objects for a given carb.
-- Mirrors getSaucesForCarb() in database.js — produces identical JSON shape.
-- Uses correlated subqueries (no LATERAL join needed).
CREATE OR REPLACE FUNCTION get_sauceboss_sauces_for_carb(p_carb_id TEXT)
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(
      json_build_object(
        'id',            s.id,
        'name',          s.name,
        'cuisine',       s.cuisine,
        'cuisineEmoji',  s.cuisine_emoji,
        'color',         s.color,
        'description',   s.description,
        'compatibleCarbs', (
          SELECT json_agg(sc2.carb_id)
          FROM sauceboss_sauce_carbs sc2
          WHERE sc2.sauce_id = s.id
        ),
        'ingredients', (
          -- Flat deduplicated ingredient list (one entry per unique name)
          SELECT json_agg(json_build_object('name', di.name, 'amount', di.amount, 'unit', di.unit))
          FROM (
            SELECT DISTINCT ON (si2.name) si2.name, si2.amount, si2.unit
            FROM sauceboss_step_ingredients si2
            JOIN sauceboss_sauce_steps ss2 ON ss2.id = si2.step_id
            WHERE ss2.sauce_id = s.id
            ORDER BY si2.name, si2.id
          ) di
        ),
        'steps', (
          SELECT json_agg(
            json_build_object(
              'title', ss.title,
              'ingredients', (
                SELECT json_agg(
                  json_build_object('name', si.name, 'amount', si.amount, 'unit', si.unit)
                  ORDER BY si.id
                )
                FROM sauceboss_step_ingredients si
                WHERE si.step_id = ss.id
              )
            )
            ORDER BY ss.step_order
          )
          FROM sauceboss_sauce_steps ss
          WHERE ss.sauce_id = s.id
        )
      )
      ORDER BY s.cuisine, s.name
    ), '[]'::json)
    FROM sauceboss_sauces s
    JOIN sauceboss_sauce_carbs sc_filter ON sc_filter.sauce_id = s.id
    WHERE sc_filter.carb_id = p_carb_id
  );
END;
$$;

-- ── get_sauceboss_ingredients_for_carb ────────────────────────────────────────
-- Returns sorted unique ingredient names for all sauces compatible with carb.
-- Mirrors getIngredientsForCarb() in database.js
CREATE OR REPLACE FUNCTION get_sauceboss_ingredients_for_carb(p_carb_id TEXT)
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT json_agg(name ORDER BY name)
    FROM (
      SELECT DISTINCT si.name
      FROM sauceboss_step_ingredients si
      JOIN sauceboss_sauce_steps ss ON ss.id = si.step_id
      JOIN sauceboss_sauce_carbs sc ON sc.sauce_id = ss.sauce_id
      WHERE sc.carb_id = p_carb_id
    ) t
  );
END;
$$;
