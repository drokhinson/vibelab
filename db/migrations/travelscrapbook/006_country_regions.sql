-- ─────────────────────────────────────────────────────────────────────────────
-- travelscrapbook — "region" becomes a grouping of countries (UN M49 subregion)
--
-- The earlier admin-1 "region" (state/province, e.g. "Περιφέρεια Κρήτης") is
-- replaced by a macro-region ABOVE country — a set of countries a traveler
-- thinks about together (Southern Europe, Eastern Asia, …). Each country maps
-- to exactly one UN M49 subregion, kept as reference data here (not code).
--
--   places.country_code / trips.dest_country_code — ISO-3166 alpha-2 (lowercase,
--     from Nominatim address.country_code), the join key.
--   travelscrapbook_regions — country_code → region (macro-region) lookup.
--   places.region / trips.dest_region (added in 005) are REPURPOSED to hold the
--     macro-region, denormalized on write; only the meaning changes (no drop).
--
-- Backend-only (service role) — RLS on, no Data API grant. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.travelscrapbook_places
  ADD COLUMN IF NOT EXISTS country_code TEXT;
ALTER TABLE public.travelscrapbook_trips
  ADD COLUMN IF NOT EXISTS dest_country_code TEXT;

CREATE TABLE IF NOT EXISTS public.travelscrapbook_regions (
  country_code TEXT PRIMARY KEY,   -- ISO-3166 alpha-2, lowercase
  region       TEXT NOT NULL       -- UN M49 subregion (travel-friendly label)
);
ALTER TABLE public.travelscrapbook_regions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.travelscrapbook_regions TO travelscrapbook_role;

-- Seed: every ISO-3166 alpha-2 code → its UN M49 subregion. Re-runnable
-- (DO UPDATE) so label tweaks apply on re-run.
INSERT INTO public.travelscrapbook_regions (country_code, region) VALUES
  -- Northern Africa
  ('dz','Northern Africa'),('eg','Northern Africa'),('ly','Northern Africa'),
  ('ma','Northern Africa'),('sd','Northern Africa'),('tn','Northern Africa'),('eh','Northern Africa'),
  -- Eastern Africa
  ('bi','Eastern Africa'),('km','Eastern Africa'),('dj','Eastern Africa'),('er','Eastern Africa'),
  ('et','Eastern Africa'),('ke','Eastern Africa'),('mg','Eastern Africa'),('mw','Eastern Africa'),
  ('mu','Eastern Africa'),('yt','Eastern Africa'),('mz','Eastern Africa'),('re','Eastern Africa'),
  ('rw','Eastern Africa'),('sc','Eastern Africa'),('so','Eastern Africa'),('ss','Eastern Africa'),
  ('tz','Eastern Africa'),('ug','Eastern Africa'),('zm','Eastern Africa'),('zw','Eastern Africa'),
  -- Middle Africa
  ('ao','Middle Africa'),('cm','Middle Africa'),('cf','Middle Africa'),('td','Middle Africa'),
  ('cg','Middle Africa'),('cd','Middle Africa'),('gq','Middle Africa'),('ga','Middle Africa'),('st','Middle Africa'),
  -- Southern Africa
  ('bw','Southern Africa'),('sz','Southern Africa'),('ls','Southern Africa'),
  ('na','Southern Africa'),('za','Southern Africa'),
  -- Western Africa
  ('bj','Western Africa'),('bf','Western Africa'),('cv','Western Africa'),('ci','Western Africa'),
  ('gm','Western Africa'),('gh','Western Africa'),('gn','Western Africa'),('gw','Western Africa'),
  ('lr','Western Africa'),('ml','Western Africa'),('mr','Western Africa'),('ne','Western Africa'),
  ('ng','Western Africa'),('sh','Western Africa'),('sn','Western Africa'),('sl','Western Africa'),('tg','Western Africa'),
  -- Caribbean
  ('ai','Caribbean'),('ag','Caribbean'),('aw','Caribbean'),('bs','Caribbean'),('bb','Caribbean'),
  ('bq','Caribbean'),('vg','Caribbean'),('ky','Caribbean'),('cu','Caribbean'),('cw','Caribbean'),
  ('dm','Caribbean'),('do','Caribbean'),('gd','Caribbean'),('gp','Caribbean'),('ht','Caribbean'),
  ('jm','Caribbean'),('mq','Caribbean'),('ms','Caribbean'),('pr','Caribbean'),('bl','Caribbean'),
  ('kn','Caribbean'),('lc','Caribbean'),('mf','Caribbean'),('vc','Caribbean'),('sx','Caribbean'),
  ('tt','Caribbean'),('tc','Caribbean'),('vi','Caribbean'),
  -- Central America
  ('bz','Central America'),('cr','Central America'),('sv','Central America'),('gt','Central America'),
  ('hn','Central America'),('mx','Central America'),('ni','Central America'),('pa','Central America'),
  -- South America
  ('ar','South America'),('bo','South America'),('br','South America'),('cl','South America'),
  ('co','South America'),('ec','South America'),('fk','South America'),('gf','South America'),
  ('gy','South America'),('py','South America'),('pe','South America'),('sr','South America'),
  ('uy','South America'),('ve','South America'),
  -- Northern America
  ('bm','Northern America'),('ca','Northern America'),('gl','Northern America'),
  ('pm','Northern America'),('us','Northern America'),
  -- Central Asia
  ('kz','Central Asia'),('kg','Central Asia'),('tj','Central Asia'),('tm','Central Asia'),('uz','Central Asia'),
  -- Eastern Asia
  ('cn','Eastern Asia'),('hk','Eastern Asia'),('mo','Eastern Asia'),('jp','Eastern Asia'),
  ('kp','Eastern Asia'),('kr','Eastern Asia'),('mn','Eastern Asia'),('tw','Eastern Asia'),
  -- South-Eastern Asia
  ('bn','South-Eastern Asia'),('kh','South-Eastern Asia'),('id','South-Eastern Asia'),('la','South-Eastern Asia'),
  ('my','South-Eastern Asia'),('mm','South-Eastern Asia'),('ph','South-Eastern Asia'),('sg','South-Eastern Asia'),
  ('th','South-Eastern Asia'),('tl','South-Eastern Asia'),('vn','South-Eastern Asia'),
  -- Southern Asia
  ('af','Southern Asia'),('bd','Southern Asia'),('bt','Southern Asia'),('in','Southern Asia'),
  ('ir','Southern Asia'),('mv','Southern Asia'),('np','Southern Asia'),('pk','Southern Asia'),('lk','Southern Asia'),
  -- Western Asia
  ('am','Western Asia'),('az','Western Asia'),('bh','Western Asia'),('cy','Western Asia'),
  ('ge','Western Asia'),('iq','Western Asia'),('il','Western Asia'),('jo','Western Asia'),
  ('kw','Western Asia'),('lb','Western Asia'),('om','Western Asia'),('ps','Western Asia'),
  ('qa','Western Asia'),('sa','Western Asia'),('sy','Western Asia'),('tr','Western Asia'),
  ('ae','Western Asia'),('ye','Western Asia'),
  -- Eastern Europe
  ('by','Eastern Europe'),('bg','Eastern Europe'),('cz','Eastern Europe'),('hu','Eastern Europe'),
  ('md','Eastern Europe'),('pl','Eastern Europe'),('ro','Eastern Europe'),('ru','Eastern Europe'),
  ('sk','Eastern Europe'),('ua','Eastern Europe'),
  -- Northern Europe
  ('ax','Northern Europe'),('dk','Northern Europe'),('ee','Northern Europe'),('fo','Northern Europe'),
  ('fi','Northern Europe'),('gg','Northern Europe'),('is','Northern Europe'),('ie','Northern Europe'),
  ('im','Northern Europe'),('je','Northern Europe'),('lv','Northern Europe'),('lt','Northern Europe'),
  ('no','Northern Europe'),('sj','Northern Europe'),('se','Northern Europe'),('gb','Northern Europe'),
  -- Southern Europe
  ('al','Southern Europe'),('ad','Southern Europe'),('ba','Southern Europe'),('hr','Southern Europe'),
  ('gi','Southern Europe'),('gr','Southern Europe'),('va','Southern Europe'),('it','Southern Europe'),
  ('mt','Southern Europe'),('me','Southern Europe'),('mk','Southern Europe'),('pt','Southern Europe'),
  ('sm','Southern Europe'),('rs','Southern Europe'),('si','Southern Europe'),('es','Southern Europe'),('xk','Southern Europe'),
  -- Western Europe
  ('at','Western Europe'),('be','Western Europe'),('fr','Western Europe'),('de','Western Europe'),
  ('li','Western Europe'),('lu','Western Europe'),('mc','Western Europe'),('nl','Western Europe'),('ch','Western Europe'),
  -- Australia and New Zealand
  ('au','Australia and New Zealand'),('nz','Australia and New Zealand'),('nf','Australia and New Zealand'),
  ('cx','Australia and New Zealand'),('cc','Australia and New Zealand'),('hm','Australia and New Zealand'),
  -- Melanesia
  ('fj','Melanesia'),('nc','Melanesia'),('pg','Melanesia'),('sb','Melanesia'),('vu','Melanesia'),
  -- Micronesia
  ('fm','Micronesia'),('gu','Micronesia'),('ki','Micronesia'),('mh','Micronesia'),
  ('nr','Micronesia'),('mp','Micronesia'),('pw','Micronesia'),('um','Micronesia'),
  -- Polynesia
  ('as','Polynesia'),('ck','Polynesia'),('pf','Polynesia'),('nu','Polynesia'),('pn','Polynesia'),
  ('ws','Polynesia'),('tk','Polynesia'),('to','Polynesia'),('tv','Polynesia'),('wf','Polynesia'),
  -- Antarctica / far-flung territories
  ('aq','Antarctica'),('bv','Antarctica'),('gs','Antarctica'),('tf','Antarctica'),('io','Southern Asia')
ON CONFLICT (country_code) DO UPDATE SET region = EXCLUDED.region;
