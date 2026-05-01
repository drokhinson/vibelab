-- ─────────────────────────────────────────────────────────────────────────────
-- sauceboss — user accounts, favorites, and sauce ownership
--
-- Adds:
--   * sauceboss_profiles  — Supabase-Auth-backed user profiles (mirror of
--                           boardgamebuddy_profiles).
--   * sauceboss_favorites — per-user sauce favorites (composite PK).
--   * sauceboss_sauces.created_by — author of each user-submitted sauce
--                                   (FK auth.users; never displayed in UI).
--
-- Modifies:
--   * create_sauceboss_sauce — now writes p_data->>'createdBy' into the
--                              sauces.created_by column.
--   * get_sauceboss_sauces_for_item / get_sauceboss_all_sauces_full /
--     get_sauceboss_all_sauces — now emit `createdBy` in their JSON output
--     so the frontend can render owner-only edit affordances.
--
-- Adds:
--   * update_sauceboss_sauce — atomic full-replace of a sauce's scalar fields,
--                              item links, steps, and step ingredients.
--                              Authorization (owner or admin) is enforced by
--                              the backend before this RPC is called.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1) Profiles ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sauceboss_profiles (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_url   TEXT,
  is_admin     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.sauceboss_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_profiles TO sauceboss_role;


-- ── 2) Favorites ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sauceboss_favorites (
  user_id    UUID NOT NULL REFERENCES public.sauceboss_profiles(id) ON DELETE CASCADE,
  sauce_id   TEXT NOT NULL REFERENCES public.sauceboss_sauces(id)   ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sauce_id)
);
CREATE INDEX IF NOT EXISTS idx_sauceboss_favorites_user
  ON public.sauceboss_favorites(user_id);
ALTER TABLE public.sauceboss_favorites ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.sauceboss_favorites TO sauceboss_role;


-- ── 3) Sauce ownership column ──────────────────────────────────────────────
ALTER TABLE public.sauceboss_sauces
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sauceboss_sauces_created_by
  ON public.sauceboss_sauces(created_by);


-- ─────────────────────────────────────────────────────────────────────────────
-- 4) create_sauceboss_sauce — accept p_data->>'createdBy'
-- (Body is identical to the 001 baseline plus the new column.)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_sauceboss_sauce(p_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_id   TEXT;
  v_sauce_type TEXT;
  v_created_by UUID;
  v_step       JSONB;
  v_step_id    BIGINT;
  v_ing        JSONB;
  v_item       TEXT;
  v_food_name  TEXT;
  v_food_norm  TEXT;
  v_food_id    TEXT;
BEGIN
  v_sauce_id   := p_data->>'id';
  v_sauce_type := COALESCE(p_data->>'sauceType', 'sauce');
  v_created_by := NULLIF(p_data->>'createdBy', '')::UUID;

  INSERT INTO public.sauceboss_sauces
    (id, name, cuisine, cuisine_emoji, color, description, sauce_type, source_url, created_by)
  VALUES (
    v_sauce_id,
    p_data->>'name',
    p_data->>'cuisine',
    p_data->>'cuisineEmoji',
    p_data->>'color',
    COALESCE(p_data->>'description', ''),
    v_sauce_type,
    NULLIF(p_data->>'sourceUrl', ''),
    v_created_by
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
      v_food_name := TRIM(v_ing->>'name');
      v_food_norm := LOWER(v_food_name);
      v_food_id   := NULL;

      IF v_food_name <> '' THEN
        INSERT INTO public.sauceboss_foods (id, name, name_normalized)
        VALUES (
          LEFT(REGEXP_REPLACE(v_food_norm, '[^a-z0-9]+', '-', 'g'), 60)
            || '-' || SUBSTR(MD5(v_food_norm), 1, 6),
          v_food_name,
          v_food_norm
        )
        ON CONFLICT (name_normalized) DO NOTHING;

        SELECT id INTO v_food_id FROM public.sauceboss_foods WHERE name_normalized = v_food_norm;
      END IF;

      INSERT INTO public.sauceboss_step_ingredients
        (step_id, food_id, unit_id, original_text, quantity, quantity_canonical_ml, quantity_canonical_g)
      VALUES (
        v_step_id,
        v_food_id,
        NULLIF(v_ing->>'unitId', ''),
        v_ing->>'originalText',
        (v_ing->>'amount')::numeric,
        NULLIF(v_ing->>'canonicalMl', '')::double precision,
        NULLIF(v_ing->>'canonicalG',  '')::double precision
      );
    END LOOP;
  END LOOP;

  RETURN v_sauce_id;
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5) update_sauceboss_sauce — atomic full replace of a sauce's content.
-- Updates scalar fields, then deletes & re-inserts item links, steps, and
-- step ingredients (cascades clean up the children). Does NOT touch
-- created_by — ownership is immutable. Authorization is enforced upstream.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_sauceboss_sauce(p_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_sauce_id   TEXT;
  v_sauce_type TEXT;
  v_step       JSONB;
  v_step_id    BIGINT;
  v_ing        JSONB;
  v_item       TEXT;
  v_food_name  TEXT;
  v_food_norm  TEXT;
  v_food_id    TEXT;
BEGIN
  v_sauce_id   := p_data->>'id';
  v_sauce_type := COALESCE(p_data->>'sauceType', 'sauce');

  IF NOT EXISTS (SELECT 1 FROM public.sauceboss_sauces WHERE id = v_sauce_id) THEN
    RAISE EXCEPTION 'update_sauceboss_sauce: sauce % not found', v_sauce_id;
  END IF;

  UPDATE public.sauceboss_sauces SET
    name          = p_data->>'name',
    cuisine       = p_data->>'cuisine',
    cuisine_emoji = p_data->>'cuisineEmoji',
    color         = p_data->>'color',
    description   = COALESCE(p_data->>'description', ''),
    sauce_type    = v_sauce_type,
    source_url    = NULLIF(p_data->>'sourceUrl', '')
  WHERE id = v_sauce_id;

  -- Replace item links
  DELETE FROM public.sauceboss_sauce_items WHERE sauce_id = v_sauce_id;
  FOR v_item IN SELECT jsonb_array_elements_text(p_data->'itemIds')
  LOOP
    INSERT INTO public.sauceboss_sauce_items (sauce_id, item_id) VALUES (v_sauce_id, v_item);
  END LOOP;

  -- Replace steps (cascades clean up step ingredients)
  DELETE FROM public.sauceboss_sauce_steps WHERE sauce_id = v_sauce_id;
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
      v_food_name := TRIM(v_ing->>'name');
      v_food_norm := LOWER(v_food_name);
      v_food_id   := NULL;

      IF v_food_name <> '' THEN
        INSERT INTO public.sauceboss_foods (id, name, name_normalized)
        VALUES (
          LEFT(REGEXP_REPLACE(v_food_norm, '[^a-z0-9]+', '-', 'g'), 60)
            || '-' || SUBSTR(MD5(v_food_norm), 1, 6),
          v_food_name,
          v_food_norm
        )
        ON CONFLICT (name_normalized) DO NOTHING;

        SELECT id INTO v_food_id FROM public.sauceboss_foods WHERE name_normalized = v_food_norm;
      END IF;

      INSERT INTO public.sauceboss_step_ingredients
        (step_id, food_id, unit_id, original_text, quantity, quantity_canonical_ml, quantity_canonical_g)
      VALUES (
        v_step_id,
        v_food_id,
        NULLIF(v_ing->>'unitId', ''),
        v_ing->>'originalText',
        (v_ing->>'amount')::numeric,
        NULLIF(v_ing->>'canonicalMl', '')::double precision,
        NULLIF(v_ing->>'canonicalG',  '')::double precision
      );
    END LOOP;
  END LOOP;

  RETURN v_sauce_id;
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6) Read RPCs — emit createdBy alongside existing fields.
-- Bodies otherwise identical to the latest definitions in 001_baseline.sql.
-- ─────────────────────────────────────────────────────────────────────────────

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
      'sourceUrl',       s.source_url,
      'sauceType',       s.sauce_type,
      'createdBy',       s.created_by,
      'compatibleItems', (
        SELECT COALESCE(json_agg(si2.item_id), '[]'::json)
        FROM public.sauceboss_sauce_items si2
        WHERE si2.sauce_id = s.id
      ),
      'ingredients', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'name',         di.food_name,
            'amount',       di.quantity,
            'unit',         di.unit_abbr,
            'unitId',       di.unit_id,
            'foodId',       di.food_id,
            'originalText', di.original_text,
            'canonicalMl',  di.canonical_ml,
            'canonicalG',   di.canonical_g
          )
          ORDER BY di.step_order, di.id
        ), '[]'::json)
        FROM (
          SELECT DISTINCT ON (di_inner.food_name)
            di_inner.id, di_inner.food_name, di_inner.quantity, di_inner.unit_abbr,
            di_inner.unit_id, di_inner.food_id, di_inner.original_text,
            di_inner.canonical_ml, di_inner.canonical_g, di_inner.step_order
          FROM (
            SELECT
              si_inner.id,
              COALESCE(f.name, si_inner.original_text) AS food_name,
              si_inner.quantity::double precision AS quantity,
              COALESCE(u.abbreviation, '') AS unit_abbr,
              si_inner.unit_id,
              si_inner.food_id,
              si_inner.original_text,
              si_inner.quantity_canonical_ml AS canonical_ml,
              si_inner.quantity_canonical_g  AS canonical_g,
              ss_inner.step_order
            FROM public.sauceboss_sauce_steps ss_inner
            JOIN public.sauceboss_step_ingredients si_inner ON si_inner.step_id = ss_inner.id
            LEFT JOIN public.sauceboss_foods f ON f.id = si_inner.food_id
            LEFT JOIN public.sauceboss_units u ON u.id = si_inner.unit_id
            WHERE ss_inner.sauce_id = s.id
          ) di_inner
          ORDER BY di_inner.food_name, di_inner.step_order, di_inner.id
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
                json_build_object(
                  'name',         COALESCE(f.name, si.original_text),
                  'amount',       si.quantity::double precision,
                  'unit',         COALESCE(u.abbreviation, ''),
                  'unitId',       si.unit_id,
                  'foodId',       si.food_id,
                  'originalText', si.original_text,
                  'canonicalMl',  si.quantity_canonical_ml,
                  'canonicalG',   si.quantity_canonical_g
                )
                ORDER BY si.id
              ), '[]'::json)
              FROM public.sauceboss_step_ingredients si
              LEFT JOIN public.sauceboss_foods f ON f.id = si.food_id
              LEFT JOIN public.sauceboss_units u ON u.id = si.unit_id
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
      'sourceUrl',       s.source_url,
      'sauceType',       s.sauce_type,
      'createdBy',       s.created_by,
      'compatibleItems', (
        SELECT COALESCE(json_agg(link.item_id), '[]'::json)
        FROM public.sauceboss_sauce_items link
        WHERE link.sauce_id = s.id
      ),
      'ingredients', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'name',         di.food_name,
            'amount',       di.quantity,
            'unit',         di.unit_abbr,
            'unitId',       di.unit_id,
            'foodId',       di.food_id,
            'originalText', di.original_text,
            'canonicalMl',  di.canonical_ml,
            'canonicalG',   di.canonical_g
          )
          ORDER BY di.step_order, di.id
        ), '[]'::json)
        FROM (
          SELECT DISTINCT ON (di_inner.food_name)
            di_inner.id, di_inner.food_name, di_inner.quantity, di_inner.unit_abbr,
            di_inner.unit_id, di_inner.food_id, di_inner.original_text,
            di_inner.canonical_ml, di_inner.canonical_g, di_inner.step_order
          FROM (
            SELECT
              si_inner.id,
              COALESCE(f.name, si_inner.original_text) AS food_name,
              si_inner.quantity::double precision AS quantity,
              COALESCE(u.abbreviation, '') AS unit_abbr,
              si_inner.unit_id,
              si_inner.food_id,
              si_inner.original_text,
              si_inner.quantity_canonical_ml AS canonical_ml,
              si_inner.quantity_canonical_g  AS canonical_g,
              ss_inner.step_order
            FROM public.sauceboss_sauce_steps ss_inner
            JOIN public.sauceboss_step_ingredients si_inner ON si_inner.step_id = ss_inner.id
            LEFT JOIN public.sauceboss_foods f ON f.id = si_inner.food_id
            LEFT JOIN public.sauceboss_units u ON u.id = si_inner.unit_id
            WHERE ss_inner.sauce_id = s.id
          ) di_inner
          ORDER BY di_inner.food_name, di_inner.step_order, di_inner.id
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
                json_build_object(
                  'name',         COALESCE(f.name, si.original_text),
                  'amount',       si.quantity::double precision,
                  'unit',         COALESCE(u.abbreviation, ''),
                  'unitId',       si.unit_id,
                  'foodId',       si.food_id,
                  'originalText', si.original_text,
                  'canonicalMl',  si.quantity_canonical_ml,
                  'canonicalG',   si.quantity_canonical_g
                )
                ORDER BY si.id
              ), '[]'::json)
              FROM public.sauceboss_step_ingredients si
              LEFT JOIN public.sauceboss_foods f ON f.id = si.food_id
              LEFT JOIN public.sauceboss_units u ON u.id = si.unit_id
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
      'createdBy',       s.created_by,
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
