-- 011_spotme_schema.sql — SpotMe core tables
-- Run in Supabase SQL Editor

-- ── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE spotme_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL,
  display_name text NOT NULL,
  email text,
  password_hash text NOT NULL,
  recovery_hash text,
  bio text,
  avatar_url text,
  is_discoverable boolean DEFAULT false,
  home_lat numeric(10,7),
  home_lng numeric(10,7),
  home_label text,
  traveling_to_lat numeric(10,7),
  traveling_to_lng numeric(10,7),
  traveling_to_label text,
  traveling_from timestamptz,
  traveling_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_spotme_users_discoverable ON spotme_users(home_lat, home_lng) WHERE is_discoverable = true;

-- ── Hobby Categories ─────────────────────────────────────────────────────────
CREATE TABLE spotme_hobby_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  icon text,
  sort_order int DEFAULT 0
);

-- ── Hobbies (shared dictionary) ──────────────────────────────────────────────
CREATE TABLE spotme_hobbies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES spotme_hobby_categories(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_spotme_hobbies_category ON spotme_hobbies(category_id);

-- ── User Hobbies (junction) ──────────────────────────────────────────────────
CREATE TABLE spotme_user_hobbies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES spotme_users(id) ON DELETE CASCADE,
  hobby_id uuid NOT NULL REFERENCES spotme_hobbies(id) ON DELETE CASCADE,
  proficiency text NOT NULL CHECK (proficiency IN ('want_to_learn', 'beginner', 'intermediate', 'advanced', 'expert')),
  notes text,
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, hobby_id)
);

CREATE INDEX idx_spotme_user_hobbies_user ON spotme_user_hobbies(user_id);
CREATE INDEX idx_spotme_user_hobbies_hobby ON spotme_user_hobbies(hobby_id);
