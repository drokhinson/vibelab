-- ─────────────────────────────────────────────────────────────────────────────
-- SauceBoss — unified RPCs over sauceboss_items / sauceboss_sauce_items
-- Replaces the four parallel category-specific load RPCs (049) with two:
--   • get_sauceboss_initial_load()           — home screen (all 3 categories)
--   • get_sauceboss_item_load(p_item_id)     — selector for any item
--
-- Also rewrites the four "fully assembled sauces" / "ingredient list" helpers
-- into single-item versions, and updates create_sauceboss_sauce +
-- get_sauceboss_all_sauces / _full to write/read sauceboss_sauce_items.
--
-- The legacy RPCs (get_sauceboss_carb_load, _protein_load, _salad_base_load,
-- _sauces_for_carb, _marinades_for_protein, _dressings_for_base,
-- _ingredients_for_carb/_protein/_base, _carbs_with_count, _proteins,
-- _salad_bases_with_count, _carb_preparations, _addons) are dropped in
-- migration 056 once the cutover has shipped.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Per-category type-row listing ───────────────────────────────────────────
-- Returns Type rows (parent_id IS NULL) for one category, with sauce count.
-- Field names match the legacy per-category RPCs so initial-load consumers
-- don't need to change.
CREATE OR REPLACE FUNCTION public.get_sauceboss_items_by_category(p_category TEXT)
RETURNS JSON LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_category = 'carb' THEN
    RETURN (
      SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.name), '[]'::json)
      FROM (
        SELECT
          i.id,
          i.name,
          i.emoji,
          i.description,
          i.portion_per_person AS "portionPerPerson",
          i.portion_unit       AS "portionUnit",
          i.cook_time_minutes  AS "cookTimeMinutes",
          (SELECT COUNT(*)::int FROM public.sauceboss_sauce_items si WHERE si.item_id = i.id) AS "sauceCount"
        FROM public.sauceboss_items i
        WHERE i.category = 'carb' AND i.parent_id IS NULL
      ) t
    );
  ELSIF p_category = 'protein' THEN
    RETURN (
      SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."sortOrder", t.name), '[]'::json)
      FROM (
        SELECT
          i.id,
          i.name,
          i.emoji,
          i.description       AS "desc",
          i.instructions,
          i.cook_time_minutes AS "estimatedTime",
          i.portion_per_person AS "portionPerPerson",
          i.portion_unit       AS "portionUnit",
          i.sort_order         AS "sortOrder",
          (SELECT COUNT(*)::int FROM public.sauceboss_sauce_items si WHERE si.item_id = i.id) AS "marinadeCount"
        FROM public.sauceboss_items i
        WHERE i.category = 'protein' AND i.parent_id IS NULL
      ) t
    );
  ELSIF p_category = 'salad' THEN
    RETURN (
      SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.name), '[]'::json)
      FROM (
        SELECT
          i.id,
          i.name,
          i.emoji,
          i.description,
          i.portion_per_person AS "portionPerPerson",
          i.portion_unit       AS "portionUnit",
          (SELECT COUNT(*)::int FROM public.sauceboss_sauce_items si WHERE si.item_id = i.id) AS "dressingCount"
        FROM public.sauceboss_items i
        WHERE i.category = 'salad' AND i.parent_id IS NULL
      ) t
    );
  ELSE
    RAISE EXCEPTION 'unknown category: %', p_category;
  END IF;
END;
$$;


-- ── Initial load (home screen) ──────────────────────────────────────────────
-- Replaces the 049 version. Returns the same { carbs, proteins, saladBases }
-- shape so the frontend doesn't need to change.
CREATE OR REPLACE FUNCTION public.get_sauceboss_initial_load()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT json_build_object(
    'carbs',      public.get_sauceboss_items_by_category('carb'),
    'proteins',   public.get_sauceboss_items_by_category('protein'),
    'saladBases', public.get_sauceboss_items_by_category('salad')
  );
$$;


-- ── Sauces for an item ──────────────────────────────────────────────────────
-- Returns fully assembled sauce objects linked to a given Type item. The shape
-- matches the legacy per-category RPCs: emits compatibleCarbs / Proteins /
-- Bases based on the item's category so the frontend can keep its three
-- screen-specific labels (sauces.js getSauceScreenContext).
CREATE OR REPLACE FUNCTION public.get_sauceboss_sauces_for_item(p_item_id TEXT)
RETURNS JSON LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_category TEXT;
BEGIN
  SELECT category INTO v_category
  FROM public.sauceboss_items
  WHERE id = p_item_id AND parent_id IS NULL;

  IF v_category IS NULL THEN
    RETURN '[]'::json;
  END IF;

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
        -- Emit all three keys; only the one matching v_category will be populated.
        -- Frontend reads s.compatibleCarbs / Proteins / Bases per screen.
        'compatibleCarbs', CASE WHEN v_category = 'carb' THEN (
            SELECT COALESCE(json_agg(si2.item_id), '[]'::json)
            FROM public.sauceboss_sauce_items si2
            WHERE si2.sauce_id = s.id
          ) ELSE NULL END,
        'compatibleProteins', CASE WHEN v_category = 'protein' THEN (
            SELECT COALESCE(json_agg(si2.item_id), '[]'::json)
            FROM public.sauceboss_sauce_items si2
            WHERE si2.sauce_id = s.id
          ) ELSE NULL END,
        'compatibleBases', CASE WHEN v_category = 'salad' THEN (
            SELECT COALESCE(json_agg(si2.item_id), '[]'::json)
            FROM public.sauceboss_sauce_items si2
            WHERE si2.sauce_id = s.id
          ) ELSE NULL END,
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
    ) sub
  );
END;
$$;


-- ── Ingredient names for an item ────────────────────────────────────────────
-- Returns sorted unique ingredient names across all sauces linked to the item.
CREATE OR REPLACE FUNCTION public.get_sauceboss_ingredients_for_item(p_item_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(name ORDER BY name), '[]'::json)
  FROM (
    SELECT DISTINCT si.name
    FROM public.sauceboss_sauce_items link
    JOIN public.sauceboss_sauce_steps ss      ON ss.sauce_id = link.sauce_id
    JOIN public.sauceboss_step_ingredients si ON si.step_id = ss.id
    WHERE link.item_id = p_item_id
  ) sub;
$$;


-- ── Variants for an item ────────────────────────────────────────────────────
-- Returns child rows (parent_id = p_item_id) ordered by sort_order.
-- Empty array when the item has no variants (e.g. proteins, salad bases today).
CREATE OR REPLACE FUNCTION public.get_sauceboss_variants_for_item(p_item_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."sortOrder", t.name), '[]'::json)
  FROM (
    SELECT
      i.id,
      i.name,
      i.emoji,
      i.description,
      i.cook_time_minutes  AS "cookTimeMinutes",
      i.water_ratio        AS "waterRatio",
      i.instructions,
      i.sort_order         AS "sortOrder"
    FROM public.sauceboss_items i
    WHERE i.parent_id = p_item_id
  ) t;
$$;


-- ── Combined per-item load ──────────────────────────────────────────────────
-- One round-trip per user selection. Replaces:
--   get_sauceboss_carb_load        (sauces + ingredients + preparations)
--   get_sauceboss_protein_load     (marinades + ingredients)
--   get_sauceboss_salad_base_load  (dressings + ingredients)
CREATE OR REPLACE FUNCTION public.get_sauceboss_item_load(p_item_id TEXT)
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT json_build_object(
    'item', (
      SELECT json_build_object(
        'id',                i.id,
        'category',          i.category,
        'name',              i.name,
        'emoji',             i.emoji,
        'description',       i.description,
        'cookTimeMinutes',   i.cook_time_minutes,
        'instructions',      i.instructions,
        'waterRatio',        i.water_ratio,
        'portionPerPerson',  i.portion_per_person,
        'portionUnit',       i.portion_unit
      )
      FROM public.sauceboss_items i
      WHERE i.id = p_item_id AND i.parent_id IS NULL
    ),
    'variants',    public.get_sauceboss_variants_for_item(p_item_id),
    'sauces',      public.get_sauceboss_sauces_for_item(p_item_id),
    'ingredients', public.get_sauceboss_ingredients_for_item(p_item_id)
  );
$$;


-- ── Update create_sauceboss_sauce to write to sauce_items ───────────────────
-- Keeps the JSON parameter key 'carbIds' for frontend backward-compat: the
-- builder UI only creates sauces (sauce_type='sauce'), which link to carbs.
-- The trigger on sauceboss_sauce_items will reject any mismatch.
CREATE OR REPLACE FUNCTION public.create_sauceboss_sauce(p_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_id TEXT;
  v_step JSONB;
  v_step_id BIGINT;
  v_ing JSONB;
  v_carb TEXT;
BEGIN
  v_sauce_id := p_data->>'id';

  INSERT INTO public.sauceboss_sauces (id, name, cuisine, cuisine_emoji, color, description)
  VALUES (
    v_sauce_id,
    p_data->>'name',
    p_data->>'cuisine',
    p_data->>'cuisineEmoji',
    p_data->>'color',
    COALESCE(p_data->>'description', '')
  );

  FOR v_carb IN SELECT jsonb_array_elements_text(p_data->'carbIds')
  LOOP
    INSERT INTO public.sauceboss_sauce_items (sauce_id, item_id)
    VALUES (v_sauce_id, v_carb);
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
      VALUES (
        v_step_id,
        v_ing->>'name',
        (v_ing->>'amount')::REAL,
        v_ing->>'unit'
      );
    END LOOP;
  END LOOP;

  RETURN v_sauce_id;
END;
$$;


-- ── Update get_sauceboss_all_sauces (admin list) to use sauce_items ─────────
-- Keeps "compatible_carbs" key name for backward compat with the existing
-- admin UI; frontend reads s.compatibleCarbs || s.compatible_carbs (settings.js).
-- Only sauces with sauce_type='sauce' link to carbs, so this is identical to
-- before for that screen.
CREATE OR REPLACE FUNCTION public.get_sauceboss_all_sauces()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(
    json_build_object(
      'id',               s.id,
      'name',             s.name,
      'cuisine',          s.cuisine,
      'color',            s.color,
      'description',      s.description,
      'compatible_carbs', (
        SELECT COALESCE(json_agg(link.item_id ORDER BY link.item_id), '[]'::json)
        FROM public.sauceboss_sauce_items link
        JOIN public.sauceboss_items i ON i.id = link.item_id
        WHERE link.sauce_id = s.id AND i.category = 'carb'
      )
    )
    ORDER BY s.cuisine, s.name
  ), '[]'::json)
  FROM public.sauceboss_sauces s;
$$;


-- ── Update get_sauceboss_all_sauces_full to use sauce_items ─────────────────
CREATE OR REPLACE FUNCTION public.get_sauceboss_all_sauces_full()
RETURNS JSON LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(json_agg(sauce_obj ORDER BY sauce_obj->>'cuisine', sauce_obj->>'name'), '[]'::json)
  FROM (
    SELECT json_build_object(
      'id',           s.id,
      'name',         s.name,
      'cuisine',      s.cuisine,
      'cuisineEmoji', s.cuisine_emoji,
      'color',        s.color,
      'description',  s.description,
      'sauceType',    s.sauce_type,
      'compatibleCarbs', (
        SELECT COALESCE(json_agg(link.item_id), '[]'::json)
        FROM public.sauceboss_sauce_items link
        JOIN public.sauceboss_items i ON i.id = link.item_id
        WHERE link.sauce_id = s.id AND i.category = 'carb'
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
