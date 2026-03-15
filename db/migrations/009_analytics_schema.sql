-- 009_analytics_schema.sql — Cross-app analytics event tracking
-- Run in Supabase dashboard → SQL Editor → New Query → Run

CREATE TABLE analytics_events (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    app        text NOT NULL,
    event      text NOT NULL DEFAULT 'app_open',
    metadata   jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_analytics_app_created ON analytics_events(app, created_at);
CREATE INDEX idx_analytics_created ON analytics_events(created_at);
