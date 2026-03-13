-- ─────────────────────────────────────────────────────────────────────────────
-- 001_sauceboss_schema.sql
-- SauceBoss tables in the shared vibelab Supabase project.
-- All tables are prefixed sauceboss_ to avoid collisions with other apps.
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sauceboss_carbs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sauceboss_sauces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  cuisine       TEXT NOT NULL,
  cuisine_emoji TEXT NOT NULL,
  color         TEXT NOT NULL,
  description   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sauceboss_sauce_carbs (
  sauce_id TEXT NOT NULL REFERENCES sauceboss_sauces(id) ON DELETE CASCADE,
  carb_id  TEXT NOT NULL REFERENCES sauceboss_carbs(id)  ON DELETE CASCADE,
  PRIMARY KEY (sauce_id, carb_id)
);

CREATE TABLE IF NOT EXISTS sauceboss_sauce_steps (
  id         BIGSERIAL PRIMARY KEY,
  sauce_id   TEXT    NOT NULL REFERENCES sauceboss_sauces(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  title      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sauceboss_step_ingredients (
  id      BIGSERIAL PRIMARY KEY,
  step_id BIGINT NOT NULL REFERENCES sauceboss_sauce_steps(id) ON DELETE CASCADE,
  name    TEXT   NOT NULL,
  amount  REAL   NOT NULL,
  unit    TEXT   NOT NULL
);

-- Indexes for common access patterns
CREATE INDEX IF NOT EXISTS idx_sauceboss_sauce_carbs_carb_id  ON sauceboss_sauce_carbs(carb_id);
CREATE INDEX IF NOT EXISTS idx_sauceboss_sauce_steps_sauce_id ON sauceboss_sauce_steps(sauce_id);
CREATE INDEX IF NOT EXISTS idx_sauceboss_step_ing_step_id     ON sauceboss_step_ingredients(step_id);
