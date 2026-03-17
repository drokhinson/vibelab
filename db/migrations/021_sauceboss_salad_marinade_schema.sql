-- Migration 021: SauceBoss — Add salad bases and marinades schema
-- Run in Supabase dashboard → SQL Editor → New Query → Run

-- 1. Add sauce_type to sauces table
--    Values: 'sauce' | 'dressing' | 'marinade'
ALTER TABLE sauceboss_sauces
  ADD COLUMN IF NOT EXISTS sauce_type text NOT NULL DEFAULT 'sauce'
  CHECK (sauce_type IN ('sauce', 'dressing', 'marinade'));

-- 2. Salad bases table (mirrors sauceboss_carbs structure)
CREATE TABLE IF NOT EXISTS sauceboss_salad_bases (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  emoji       text NOT NULL,
  description text
);

-- 3. Junction: dressings ↔ salad bases
CREATE TABLE IF NOT EXISTS sauceboss_sauce_salad_bases (
  sauce_id text REFERENCES sauceboss_sauces(id)       ON DELETE CASCADE,
  base_id  text REFERENCES sauceboss_salad_bases(id)  ON DELETE CASCADE,
  PRIMARY KEY (sauce_id, base_id)
);

-- 4. Junction: marinades ↔ proteins (links to sauceboss_addons where type='protein')
--    sauceboss_addons.id is TEXT
CREATE TABLE IF NOT EXISTS sauceboss_sauce_proteins (
  sauce_id text REFERENCES sauceboss_sauces(id)  ON DELETE CASCADE,
  addon_id text REFERENCES sauceboss_addons(id)  ON DELETE CASCADE,
  PRIMARY KEY (sauce_id, addon_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sauceboss_sauce_salad_bases_base ON sauceboss_sauce_salad_bases(base_id);
CREATE INDEX IF NOT EXISTS idx_sauceboss_sauce_proteins_addon   ON sauceboss_sauce_proteins(addon_id);
CREATE INDEX IF NOT EXISTS idx_sauceboss_sauces_sauce_type      ON sauceboss_sauces(sauce_type);
