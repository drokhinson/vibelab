-- ─────────────────────────────────────────────────────────────────────────────
-- 005_sauceboss_rpcs_v2.sql
-- Updated RPCs: carbs now include portion data.
-- New RPCs: ingredient categories, substitutions.
-- Run AFTER 004_sauceboss_features.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Updated: get_sauceboss_carbs_with_count ─────────────────────────────────
-- Now includes portion_per_person and portion_unit
CREATE OR REPLACE FUNCTION get_sauceboss_carbs_with_count()
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT json_agg(row_to_json(t) ORDER BY t.rownum)
    FROM (
      SELECT c.id, c.name, c.emoji, c.description,
             c.portion_per_person AS "portionPerPerson",
             c.portion_unit AS "portionUnit",
             COUNT(sc.sauce_id)::int AS "sauceCount",
             ROW_NUMBER() OVER () AS rownum
      FROM sauceboss_carbs c
      LEFT JOIN sauceboss_sauce_carbs sc ON sc.carb_id = c.id
      GROUP BY c.id, c.name, c.emoji, c.description,
               c.portion_per_person, c.portion_unit
    ) t
  );
END;
$$;

-- ── New: get_sauceboss_ingredient_categories ────────────────────────────────
CREATE OR REPLACE FUNCTION get_sauceboss_ingredient_categories()
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(
      json_build_object(
        'ingredientName', ingredient_name,
        'category', category
      )
    ), '[]'::json)
    FROM sauceboss_ingredient_categories
  );
END;
$$;

-- ── New: get_sauceboss_substitutions ────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_sauceboss_substitutions()
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(
      json_build_object(
        'ingredientName', ingredient_name,
        'substituteName', substitute_name,
        'notes', notes
      )
    ), '[]'::json)
    FROM sauceboss_ingredient_substitutions
  );
END;
$$;
