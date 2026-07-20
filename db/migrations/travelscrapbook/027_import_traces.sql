-- 027_import_traces.sql
-- Per-import parse trace: the audit record behind Settings → "Import audit".
--
-- process_source (services/enrichment.py) builds one ImportTrace as it runs and
-- writes it here at the end of every import (success or failure). It captures
-- the full path a link took — capture → URL expansion → caption recovery →
-- page fetch → AI prompt/response → result splits → geocode → materialize →
-- final — so the user can download an HTML flowchart and see exactly where an
-- import went wrong (e.g. the "always Rome" hallucination).
--
-- Retention is application-side: enrichment keeps only the newest 5 rows per
-- user after each insert, so this table stays tiny. Backend-only (service role);
-- no Data API grant.

CREATE TABLE IF NOT EXISTS public.travelscrapbook_import_traces (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    UUID        NOT NULL REFERENCES public.travelscrapbook_sources(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES public.travelscrapbook_profiles(id) ON DELETE CASCADE,
  url          TEXT        NOT NULL,
  final_status TEXT,                   -- processing | ready | failed (at write time)
  error_kind   TEXT,                   -- network | blocked | llm | no_place | internal
  trace        JSONB       NOT NULL,   -- {url, steps: [{kind, title, data}, ...]}
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Newest-first per user drives both the "last 5" list and the retention prune.
CREATE INDEX IF NOT EXISTS idx_ts_import_traces_user_created
  ON public.travelscrapbook_import_traces (user_id, created_at DESC);

ALTER TABLE public.travelscrapbook_import_traces ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.travelscrapbook_import_traces TO travelscrapbook_role;
