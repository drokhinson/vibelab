-- Migration 022: SauceBoss — RPCs for salad bases and marinades
-- Run AFTER 021_sauceboss_salad_marinade_schema.sql
-- Run in Supabase dashboard → SQL Editor → New Query → Run

-- ── get_sauceboss_salad_bases_with_count ─────────────────────────────────────
-- Returns all salad bases with count of paired dressings.
CREATE OR REPLACE FUNCTION get_sauceboss_salad_bases_with_count()
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.name), '[]'::json)
    FROM (
      SELECT b.id, b.name, b.emoji, b.description,
             COUNT(ssb.sauce_id)::int AS "dressingCount"
      FROM sauceboss_salad_bases b
      LEFT JOIN sauceboss_sauce_salad_bases ssb ON ssb.base_id = b.id
      GROUP BY b.id, b.name, b.emoji, b.description
    ) t
  );
END;
$$;

-- ── get_sauceboss_dressings_for_base ─────────────────────────────────────────
-- Returns fully assembled dressings for a given salad base.
-- Same JSON shape as get_sauceboss_sauces_for_carb for frontend reuse.
CREATE OR REPLACE FUNCTION get_sauceboss_dressings_for_base(p_base_id TEXT)
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'name'), '[]'::json)
    FROM (
      SELECT json_build_object(
        'id',           s.id,
        'name',         s.name,
        'cuisine',      s.cuisine,
        'cuisineEmoji', s.cuisine_emoji,
        'color',        s.color,
        'description',  s.description,
        'sauceType',    s.sauce_type,
        'compatibleBases', (
          SELECT COALESCE(json_agg(ssb2.base_id), '[]'::json)
          FROM sauceboss_sauce_salad_bases ssb2
          WHERE ssb2.sauce_id = s.id
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
              'title',         ss.title,
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
      JOIN sauceboss_sauce_salad_bases ssb ON ssb.sauce_id = s.id AND ssb.base_id = p_base_id
      WHERE s.sauce_type = 'dressing'
    ) sub
  );
END;
$$;

-- ── get_sauceboss_ingredients_for_base ───────────────────────────────────────
-- Returns sorted unique ingredient names across all dressings for a salad base.
-- Used to populate the ingredient filter panel.
CREATE OR REPLACE FUNCTION get_sauceboss_ingredients_for_base(p_base_id TEXT)
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(ingredient_name ORDER BY ingredient_name), '[]'::json)
    FROM (
      SELECT DISTINCT si.name AS ingredient_name
      FROM sauceboss_sauces s
      JOIN sauceboss_sauce_salad_bases ssb ON ssb.sauce_id = s.id AND ssb.base_id = p_base_id
      JOIN sauceboss_sauce_steps ss ON ss.sauce_id = s.id
      JOIN sauceboss_step_ingredients si ON si.step_id = ss.id
      WHERE s.sauce_type = 'dressing'
    ) sub
  );
END;
$$;

-- ── get_sauceboss_marinades_for_protein ──────────────────────────────────────
-- Returns fully assembled marinades for a given protein (addon id).
-- Same JSON shape as get_sauceboss_sauces_for_carb for frontend reuse.
CREATE OR REPLACE FUNCTION get_sauceboss_marinades_for_protein(p_addon_id TEXT)
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'name'), '[]'::json)
    FROM (
      SELECT json_build_object(
        'id',           s.id,
        'name',         s.name,
        'cuisine',      s.cuisine,
        'cuisineEmoji', s.cuisine_emoji,
        'color',        s.color,
        'description',  s.description,
        'sauceType',    s.sauce_type,
        'compatibleProteins', (
          SELECT COALESCE(json_agg(sp2.addon_id), '[]'::json)
          FROM sauceboss_sauce_proteins sp2
          WHERE sp2.sauce_id = s.id
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
              'title',         ss.title,
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
      JOIN sauceboss_sauce_proteins sp ON sp.sauce_id = s.id AND sp.addon_id = p_addon_id
      WHERE s.sauce_type = 'marinade'
    ) sub
  );
END;
$$;

-- ── get_sauceboss_ingredients_for_protein ────────────────────────────────────
-- Returns sorted unique ingredient names across all marinades for a protein.
CREATE OR REPLACE FUNCTION get_sauceboss_ingredients_for_protein(p_addon_id TEXT)
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(ingredient_name ORDER BY ingredient_name), '[]'::json)
    FROM (
      SELECT DISTINCT si.name AS ingredient_name
      FROM sauceboss_sauces s
      JOIN sauceboss_sauce_proteins sp ON sp.sauce_id = s.id AND sp.addon_id = p_addon_id
      JOIN sauceboss_sauce_steps ss ON ss.sauce_id = s.id
      JOIN sauceboss_step_ingredients si ON si.step_id = ss.id
      WHERE s.sauce_type = 'marinade'
    ) sub
  );
END;
$$;

-- ── get_sauceboss_proteins ───────────────────────────────────────────────────
-- Returns all protein addons (type='protein') for the marinades tab.
CREATE OR REPLACE FUNCTION get_sauceboss_proteins()
RETURNS JSON LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(
      json_build_object(
        'id',            id,
        'name',          name,
        'emoji',         emoji,
        'desc',          description,
        'instructions',  instructions,
        'estimatedTime', estimated_time,
        'marinadeCount', (
          SELECT COUNT(*)::int
          FROM sauceboss_sauce_proteins sp
          WHERE sp.addon_id = a.id
        )
      )
      ORDER BY sort_order
    ), '[]'::json)
    FROM sauceboss_addons a
    WHERE type = 'protein'
  );
END;
$$;
