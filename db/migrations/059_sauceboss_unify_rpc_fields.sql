-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 059 — SauceBoss: finish the carb/protein/salad unification.
--
-- Migration 054 normalized the *table* layer (one sauceboss_items table) but
-- kept per-category field aliases in the RPC layer ("estimatedTime" for
-- proteins, "desc" for proteins, "marinadeCount" / "dressingCount",
-- "compatibleCarbs" / "compatibleProteins" / "compatibleBases") so the legacy
-- frontend wouldn't break mid-cutover. This migration drops those aliases —
-- every category now emits the same field names. The ``create_sauceboss_sauce``
-- RPC also accepts a generic ``itemIds`` list (which pairs the sauce with
-- items of any category, gated by the existing sauce_type ↔ item.category
-- trigger from migration 051).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Per-category type-row listing (uniform shape) ───────────────────────────
CREATE OR REPLACE FUNCTION public.get_sauceboss_items_by_category(p_category TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."sortOrder", t.name), '[]'::json)
  FROM (
    SELECT
      i.id,
      i.category,
      i.name,
      i.emoji,
      i.description,
      i.instructions,
      i.water_ratio        AS "waterRatio",
      i.cook_time_minutes  AS "cookTimeMinutes",
      i.portion_per_person AS "portionPerPerson",
      i.portion_unit       AS "portionUnit",
      i.sort_order         AS "sortOrder",
      (SELECT COUNT(*)::int FROM public.sauceboss_sauce_items si WHERE si.item_id = i.id) AS "sauceCount"
    FROM public.sauceboss_items i
    WHERE i.category = p_category AND i.parent_id IS NULL
  ) t;
$$;


-- ── Initial load (home screen) ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_sauceboss_initial_load()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT json_build_object(
    'carbs',      public.get_sauceboss_items_by_category('carb'),
    'proteins',   public.get_sauceboss_items_by_category('protein'),
    'saladBases', public.get_sauceboss_items_by_category('salad')
  );
$$;


-- ── Sauces for an item (uniform compatibleItems) ────────────────────────────
CREATE OR REPLACE FUNCTION public.get_sauceboss_sauces_for_item(p_item_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',              s.id,
      'name',            s.name,
      'cuisine',         s.cuisine,
      'cuisineEmoji',    s.cuisine_emoji,
      'color',           s.color,
      'description',     s.description,
      'sauceType',       s.sauce_type,
      'compatibleItems', (
        SELECT COALESCE(json_agg(si2.item_id), '[]'::json)
        FROM public.sauceboss_sauce_items si2
        WHERE si2.sauce_id = s.id
      ),
      'ingredients', (
        SELECT COALESCE(json_agg(
          json_build_object('name', di.name, 'amount', di.amount, 'unit', di.unit)
          ORDER BY di.step_order, di.id
        ), '[]'::json)
        FROM (
          SELECT DISTINCT ON (si_inner.name)
                 si_inner.id, si_inner.name, si_inner.amount, si_inner.unit,
                 ss_inner.step_order
          FROM public.sauceboss_sauce_steps ss_inner
          JOIN public.sauceboss_step_ingredients si_inner ON si_inner.step_id = ss_inner.id
          WHERE ss_inner.sauce_id = s.id
          ORDER BY si_inner.name, ss_inner.step_order, si_inner.id
        ) di
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
              FROM public.sauceboss_step_ingredients si
              WHERE si.step_id = ss.id
            )
          )
          ORDER BY ss.step_order
        ), '[]'::json)
        FROM public.sauceboss_sauce_steps ss
        WHERE ss.sauce_id = s.id
      )
    ) AS sauce_obj
    FROM public.sauceboss_sauces s
    JOIN public.sauceboss_sauce_items link
      ON link.sauce_id = s.id AND link.item_id = p_item_id
  ) sub;
$$;


-- ── Sauce creation: accept itemIds, no longer carbIds ───────────────────────
-- The trigger from migration 051 still rejects any item whose category does
-- not match the sauce's sauce_type, so this RPC stays type-safe.
CREATE OR REPLACE FUNCTION public.create_sauceboss_sauce(p_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_id   TEXT;
  v_sauce_type TEXT;
  v_step       JSONB;
  v_step_id    BIGINT;
  v_ing        JSONB;
  v_item       TEXT;
BEGIN
  v_sauce_id   := p_data->>'id';
  v_sauce_type := COALESCE(p_data->>'sauceType', 'sauce');

  INSERT INTO public.sauceboss_sauces (id, name, cuisine, cuisine_emoji, color, description, sauce_type)
  VALUES (
    v_sauce_id,
    p_data->>'name',
    p_data->>'cuisine',
    p_data->>'cuisineEmoji',
    p_data->>'color',
    COALESCE(p_data->>'description', ''),
    v_sauce_type
  );

  FOR v_item IN SELECT jsonb_array_elements_text(p_data->'itemIds')
  LOOP
    INSERT INTO public.sauceboss_sauce_items (sauce_id, item_id) VALUES (v_sauce_id, v_item);
  END LOOP;

  FOR v_step IN SELECT * FROM jsonb_array_elements(p_data->'steps')
  LOOP
    INSERT INTO public.sauceboss_sauce_steps (sauce_id, step_order, title, input_from_step)
    VALUES (
      v_sauce_id,
      (v_step->>'stepOrder')::INT,
      v_step->>'title',
      CASE WHEN v_step->>'inputFromStep' IS NOT NULL
           THEN (v_step->>'inputFromStep')::INT
           ELSE NULL END
    )
    RETURNING id INTO v_step_id;

    FOR v_ing IN SELECT * FROM jsonb_array_elements(v_step->'ingredients')
    LOOP
      INSERT INTO public.sauceboss_step_ingredients (step_id, name, amount, unit)
      VALUES (v_step_id, v_ing->>'name', (v_ing->>'amount')::REAL, v_ing->>'unit');
    END LOOP;
  END LOOP;

  RETURN v_sauce_id;
END;
$$;


-- ── Admin sauce listing — uniform compatibleItems regardless of sauce_type ──
CREATE OR REPLACE FUNCTION public.get_sauceboss_all_sauces()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(
    json_build_object(
      'id',              s.id,
      'name',            s.name,
      'cuisine',         s.cuisine,
      'cuisineEmoji',    s.cuisine_emoji,
      'color',           s.color,
      'description',     s.description,
      'sauceType',       s.sauce_type,
      'compatibleItems', (
        SELECT COALESCE(json_agg(link.item_id ORDER BY link.item_id), '[]'::json)
        FROM public.sauceboss_sauce_items link
        WHERE link.sauce_id = s.id
      )
    )
    ORDER BY s.cuisine, s.name
  ), '[]'::json)
  FROM public.sauceboss_sauces s;
$$;


-- ── Public sauce listing — uniform compatibleItems + DISTINCT ingredients ──
CREATE OR REPLACE FUNCTION public.get_sauceboss_all_sauces_full()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'cuisine', sauce_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',              s.id,
      'name',            s.name,
      'cuisine',         s.cuisine,
      'cuisineEmoji',    s.cuisine_emoji,
      'color',           s.color,
      'description',     s.description,
      'sauceType',       s.sauce_type,
      'compatibleItems', (
        SELECT COALESCE(json_agg(link.item_id), '[]'::json)
        FROM public.sauceboss_sauce_items link
        WHERE link.sauce_id = s.id
      ),
      'ingredients', (
        SELECT COALESCE(json_agg(
          json_build_object('name', di.name, 'amount', di.amount, 'unit', di.unit)
          ORDER BY di.step_order, di.id
        ), '[]'::json)
        FROM (
          SELECT DISTINCT ON (si_inner.name)
                 si_inner.id, si_inner.name, si_inner.amount, si_inner.unit,
                 ss_inner.step_order
          FROM public.sauceboss_sauce_steps ss_inner
          JOIN public.sauceboss_step_ingredients si_inner ON si_inner.step_id = ss_inner.id
          WHERE ss_inner.sauce_id = s.id
          ORDER BY si_inner.name, ss_inner.step_order, si_inner.id
        ) di
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
              FROM public.sauceboss_step_ingredients si
              WHERE si.step_id = ss.id
            )
          )
          ORDER BY ss.step_order
        ), '[]'::json)
        FROM public.sauceboss_sauce_steps ss
        WHERE ss.sauce_id = s.id
      )
    ) AS sauce_obj
    FROM public.sauceboss_sauces s
  ) sub;
$$;
