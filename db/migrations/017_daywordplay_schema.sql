-- 017_daywordplay_schema.sql
-- Day Word Play: daily vocabulary challenge with groups

-- Users
CREATE TABLE IF NOT EXISTS daywordplay_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL,
    display_name TEXT,
    email TEXT,
    password_hash TEXT NOT NULL,
    recovery_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Groups (4-letter code for joining)
CREATE TABLE IF NOT EXISTS daywordplay_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    code CHAR(4) UNIQUE NOT NULL,
    created_by UUID REFERENCES daywordplay_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Group members
CREATE TABLE IF NOT EXISTS daywordplay_group_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES daywordplay_groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES daywordplay_users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(group_id, user_id)
);

-- Word bank
CREATE TABLE IF NOT EXISTS daywordplay_words (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    word TEXT NOT NULL,
    part_of_speech TEXT NOT NULL,
    definition TEXT NOT NULL,
    pronunciation TEXT,
    etymology TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Daily word assignment per group (lazy-assigned on first request)
CREATE TABLE IF NOT EXISTS daywordplay_daily_words (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES daywordplay_groups(id) ON DELETE CASCADE,
    word_id UUID NOT NULL REFERENCES daywordplay_words(id) ON DELETE CASCADE,
    assigned_date DATE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(group_id, assigned_date)
);

-- User sentences (one per user per group per day)
CREATE TABLE IF NOT EXISTS daywordplay_sentences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES daywordplay_groups(id) ON DELETE CASCADE,
    word_id UUID NOT NULL REFERENCES daywordplay_words(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES daywordplay_users(id) ON DELETE CASCADE,
    sentence TEXT NOT NULL,
    assigned_date DATE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(group_id, user_id, assigned_date)
);

-- Votes (one per voter per sentence; cannot vote for own sentence)
CREATE TABLE IF NOT EXISTS daywordplay_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sentence_id UUID NOT NULL REFERENCES daywordplay_sentences(id) ON DELETE CASCADE,
    voter_user_id UUID NOT NULL REFERENCES daywordplay_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(voter_user_id, sentence_id)
);

-- Bookmarked words (friend dictionary)
CREATE TABLE IF NOT EXISTS daywordplay_bookmarks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES daywordplay_users(id) ON DELETE CASCADE,
    word_id UUID NOT NULL REFERENCES daywordplay_words(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, word_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_daywordplay_groups_code ON daywordplay_groups(code);
CREATE INDEX IF NOT EXISTS idx_daywordplay_group_members_user ON daywordplay_group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_daywordplay_group_members_group ON daywordplay_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_daywordplay_daily_words_lookup ON daywordplay_daily_words(group_id, assigned_date);
CREATE INDEX IF NOT EXISTS idx_daywordplay_sentences_date ON daywordplay_sentences(group_id, assigned_date);
CREATE INDEX IF NOT EXISTS idx_daywordplay_votes_sentence ON daywordplay_votes(sentence_id);
CREATE INDEX IF NOT EXISTS idx_daywordplay_bookmarks_user ON daywordplay_bookmarks(user_id);
