-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy 002 — reference data
--
-- Collapsed from the 73-file history now in archive/. Reference data only:
-- rows a fresh database needs in order to work at all. Every one-time backfill
-- from the archive is deliberately absent — on an empty database they are all
-- no-ops, and carrying them forward would imply they still do something.
--
-- FRESH-DB ONLY. Production is already at this state. Do not run on existing DB.
--
-- Run after 001_baseline.sql, before 003_rpcs.sql.
--
-- Five tables plus the two storage buckets. Values are the FINAL text after
-- every later edit in the archive — notably archive/067 rewrote all 19
-- achievement taglines into plain second-person prose, and those rewritten
-- taglines are what appear below, not the originals from archive/062.
--
-- Deliberately NOT seeded: the Evo and Seven Wonders guide chapters that
-- archive/002_seed.sql inserted. archive/018_chapters_rename.sql line 19
-- (`DELETE FROM ... WHERE created_by IS NULL`) removed every seeded chapter
-- when the chunk→chapter rename landed, so the end state of the chain has
-- boardgamebuddy_guide_chapters empty. Chapters are user-authored now.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Chapter types ────────────────────────────────────────────────────────────
-- The fixed vocabulary of guide-chapter kinds. `icon` is a slug resolved to a
-- vendored icon in the web/native client, never an emoji (.claude/rules/assets.md).
INSERT INTO public.boardgamebuddy_chapter_types (id, label, icon, display_order) VALUES
  ('setup',           'Setup',           'box',         10),
  ('player_turn',     'Player Turn',     'gamepad-2',   20),
  ('scoring',         'Scoring',         'trophy',      30),
  ('card_reference',  'Card Reference',  'layers',      40),
  ('tips',            'Tips & Tricks',   'lightbulb',   50),
  ('variant',         'Variants',        'shuffle',     60)
ON CONFLICT (id) DO NOTHING;


-- ── Game catalog ─────────────────────────────────────────────────────────────
-- A starter catalog so a brand-new database isn't an empty search box. Real
-- catalog growth happens at runtime through the BGG import path, which fills in
-- description/image_url/thumbnail_url/play_mode/expansion linkage; every row
-- here leaves those at their column defaults (all 22 are base games, all
-- play_mode='competitive'). id and created_at are omitted so the table's own
-- defaults apply.
INSERT INTO public.boardgamebuddy_games
  (bgg_id, name, year_published, min_players, max_players, playing_time,
   categories, mechanics, theme_color) VALUES
  (13, 'Catan',                           1995, 3, 4, 90,
   ARRAY['Negotiation','Territory Building','Family'],
   ARRAY['Dice Rolling','Hand Management','Trading'],
   '#e67e22'),
  (50, 'Lost Cities',                     1999, 2, 2, 30,
   ARRAY['Card Game','Exploration'],
   ARRAY['Hand Management','Set Collection'],
   '#2980b9'),
  (822, 'Carcassonne',                     2000, 2, 5, 45,
   ARRAY['Medieval','Territory Building','Family'],
   ARRAY['Area Control','Tile Placement'],
   '#9b59b6'),
  (1159, 'Evo',                             2001, 3, 5, 90,
   ARRAY['Animals','Prehistoric','Territory Building'],
   ARRAY['Auction/Bidding','Area Control','Dice Rolling','Hand Management'],
   '#2e7d32'),
  (2651, 'Power Grid',                      2004, 2, 6, 120,
   ARRAY['Economic','Industry','City Building'],
   ARRAY['Auction','Network Building','Route Building'],
   '#e67e22'),
  (3076, 'Puerto Rico',                     2002, 3, 5, 90,
   ARRAY['Economic','City Building'],
   ARRAY['Role Selection','Variable Player Powers','Worker Placement'],
   '#f39c12'),
  (9209, 'Ticket to Ride',                  2004, 2, 5, 75,
   ARRAY['Trains','Route Building','Family'],
   ARRAY['Card Drafting','Hand Management','Route Building'],
   '#e74c3c'),
  (12333, 'Twilight Struggle',               2005, 2, 2, 180,
   ARRAY['Political','Wargame','Card Game'],
   ARRAY['Area Control','Card Driven','Hand Management'],
   '#2980b9'),
  (30549, 'Pandemic',                        2008, 2, 4, 45,
   ARRAY['Medical','Cooperative','Family'],
   ARRAY['Hand Management','Role Selection','Variable Player Powers'],
   '#27ae60'),
  (31260, 'Agricola',                        2007, 1, 5, 90,
   ARRAY['Economic','Farming'],
   ARRAY['Hand Management','Worker Placement'],
   '#795548'),
  (36218, 'Dominion',                        2008, 2, 4, 30,
   ARRAY['Card Game','Medieval'],
   ARRAY['Deck Building','Hand Management'],
   '#2c3e50'),
  (37111, 'Race for the Galaxy',             2007, 2, 4, 45,
   ARRAY['Card Game','Science Fiction','Space'],
   ARRAY['Card Drafting','Hand Management','Simultaneous Action'],
   '#2980b9'),
  (68448, '7 Wonders',                       2010, 2, 7, 30,
   ARRAY['Ancient','Card Game','Civilization'],
   ARRAY['Card Drafting','Hand Management','Set Collection'],
   '#f1c40f'),
  (84876, 'The Castles of Burgundy',         2011, 2, 4, 90,
   ARRAY['Medieval','Dice'],
   ARRAY['Dice Rolling','Set Collection','Tile Placement'],
   '#d35400'),
  (120677, 'Terra Mystica',                   2012, 2, 5, 150,
   ARRAY['Fantasy','Territory Building'],
   ARRAY['Area Control','Income','Variable Player Powers'],
   '#7f8c8d'),
  (161936, 'Pandemic Legacy: Season 1',       2015, 2, 4, 60,
   ARRAY['Medical','Cooperative'],
   ARRAY['Campaign','Hand Management','Variable Player Powers'],
   '#27ae60'),
  (162886, 'Spirit Island',                   2017, 1, 4, 120,
   ARRAY['Fantasy','Territory Building','Cooperative'],
   ARRAY['Area Control','Hand Management','Variable Player Powers'],
   '#16a085'),
  (174430, 'Gloomhaven',                      2017, 1, 4, 120,
   ARRAY['Adventure','Fantasy','Fighting'],
   ARRAY['Campaign','Hand Management','Modular Board'],
   '#2c3e50'),
  (182028, 'Through the Ages: A New Story',   2015, 2, 4, 120,
   ARRAY['Civilization','Card Game'],
   ARRAY['Card Drafting','Hand Management','Worker Placement'],
   '#8e44ad'),
  (183394, 'Viticulture: Essential Edition',  2015, 2, 6, 90,
   ARRAY['Economic','Farming'],
   ARRAY['Hand Management','Worker Placement'],
   '#8e44ad'),
  (224517, 'Brass: Birmingham',               2018, 2, 4, 60,
   ARRAY['Economic','Industry','Transportation'],
   ARRAY['Hand Management','Network Building','Route Building'],
   '#c0392b'),
  (266192, 'Wingspan',                        2019, 1, 5, 70,
   ARRAY['Animals','Card Game','Nature'],
   ARRAY['Card Drafting','Hand Management','Set Collection'],
   '#1abc9c')
ON CONFLICT (bgg_id) DO NOTHING;


-- ── Achievement groups ───────────────────────────────────────────────────────
-- The five sections the achievements screen renders, in display order.
INSERT INTO public.boardgamebuddy_achievement_groups (id, label, blurb, display_order) VALUES
  ('table', 'At the table',
   'Plays logged, and the size of the crowd around them.', 10),
  ('travel', 'On the road',
   'Not just what you played — where.', 15),
  ('victories', 'Victories',
   'What the scorepad says when the dust settles.', 20),
  ('guide', 'The reference guide',
   'Chapters you keep, and chapters you write.', 30),
  ('setup', 'Making it yours',
   'The small acts that turn the app into your app.', 40)
ON CONFLICT (id) DO NOTHING;


-- ── Achievement catalog ──────────────────────────────────────────────────────
-- What bgb_sync_achievements(uuid) evaluates against. `metric` names the
-- counter the RPC computes and `threshold` the value that unlocks the row, so
-- adding an achievement for an existing metric is a data change, not a code
-- change. Taglines are archive/067's plain second-person text.
INSERT INTO public.boardgamebuddy_achievements
  (id, group_id, name, tagline, requirement, metric, threshold, icon, display_order) VALUES
  ('plays_10', 'table', 'Table Regular',
   'You''ve logged 10 plays.',
   'Log 10 plays',
   'plays_logged', 10, 'table-regular', 10),
  ('plays_100', 'table', 'Century Club',
   'You''ve logged 100 plays.',
   'Log 100 plays',
   'plays_logged', 100, 'century-club', 20),
  ('plays_300', 'table', 'Table Titan',
   'You''ve logged 300 plays.',
   'Log 300 plays',
   'plays_logged', 300, 'table-titan', 30),
  ('duelist', 'table', 'Duelist',
   'Played a game made specifically for 2 players.',
   'Play a game made specifically for 2 players',
   'two_player_games', 1, 'duelist', 40),
  ('full_table', 'table', 'Full Table',
   'Logged a play with 5 or more players at the table.',
   'Log a play with 5 or more players',
   'biggest_table', 5, 'full-table', 50),
  ('countries_2', 'travel', 'Border Hopper',
   'Logged plays in 2 different countries.',
   'Log plays in 2 different countries',
   'countries', 2, 'border-hopper', 52),
  ('continents_2', 'travel', 'Globe Trotter',
   'Logged plays on 2 different continents.',
   'Log plays on 2 different continents',
   'continents', 2, 'globe-trotter', 54),
  ('countries_5', 'travel', 'Country Counter',
   'Logged plays in 5 different countries.',
   'Log plays in 5 different countries',
   'countries', 5, 'country-counter', 56),
  ('wins_10', 'victories', 'Crowned',
   'Logged 10 game wins.',
   'Log 10 game wins',
   'wins', 10, 'crowned', 60),
  ('wins_100', 'victories', 'King of the Hill',
   'Logged 100 game wins.',
   'Log 100 game wins',
   'wins', 100, 'king-of-the-hill', 70),
  ('wins_300', 'victories', 'Dynasty',
   'Logged 300 game wins.',
   'Log 300 game wins',
   'wins', 300, 'dynasty', 80),
  ('chapters_1', 'guide', 'First Page',
   'Authored 1 reference guide chapter.',
   'Author 1 reference guide chapter',
   'guide_chapters', 1, 'first-page', 90),
  ('chapters_10', 'guide', 'Rules Lawyer',
   'Authored 10 reference guide chapters.',
   'Author 10 reference guide chapters',
   'guide_chapters', 10, 'rules-lawyer', 100),
  ('chapters_50', 'guide', 'Loremaster',
   'Authored 50 reference guide chapters.',
   'Author 50 reference guide chapters',
   'guide_chapters', 50, 'loremaster', 110),
  ('chapter_borrowed', 'guide', 'Cited Source',
   'Another player cited your chapter in their reference guide.',
   'Have another player cite your chapter in their reference guide',
   'chapters_borrowed', 1, 'cited-source', 120),
  ('buddy_1', 'setup', 'Buddy System',
   'Added your first buddy.',
   'Add your first buddy',
   'buddies', 1, 'buddy-system', 130),
  ('play_notes_1', 'setup', 'Table Chronicler',
   'Added a description to a play you logged.',
   'Add a description to a play you logged',
   'plays_with_notes', 1, 'table-chronicler', 140),
  ('bgg_linked', 'setup', 'Geek Certified',
   'Linked your BoardGameGeek account.',
   'Link your BoardGameGeek account',
   'bgg_linked', 1, 'geek-certified', 150),
  ('app_installed', 'setup', 'Pocket Buddy',
   'Installed the web app on your phone.',
   'Install the web app on your phone',
   'app_installed', 1, 'pocket-buddy', 160)
ON CONFLICT (id) DO NOTHING;


-- ── Country → continent lookup ───────────────────────────────────────────────
-- ISO 3166-1 alpha-2 → continent, backing the location achievements introduced
-- in archive/068. plays.country_code (archive/065) joins here so "played on N
-- continents" is one join rather than a hard-coded map in Python.
INSERT INTO public.boardgamebuddy_countries (code, continent) VALUES
  ('AO','AF'), ('BF','AF'), ('BI','AF'), ('BJ','AF'), ('BW','AF'), ('CD','AF'),
  ('CF','AF'), ('CG','AF'), ('CI','AF'), ('CM','AF'), ('CV','AF'), ('DJ','AF'),
  ('DZ','AF'), ('EG','AF'), ('EH','AF'), ('ER','AF'), ('ET','AF'), ('GA','AF'),
  ('GH','AF'), ('GM','AF'), ('GN','AF'), ('GQ','AF'), ('GW','AF'), ('KE','AF'),
  ('KM','AF'), ('LR','AF'), ('LS','AF'), ('LY','AF'), ('MA','AF'), ('MG','AF'),
  ('ML','AF'), ('MR','AF'), ('MU','AF'), ('MW','AF'), ('MZ','AF'), ('NA','AF'),
  ('NE','AF'), ('NG','AF'), ('RE','AF'), ('RW','AF'), ('SC','AF'), ('SD','AF'),
  ('SH','AF'), ('SL','AF'), ('SN','AF'), ('SO','AF'), ('SS','AF'), ('ST','AF'),
  ('SZ','AF'), ('TD','AF'), ('TG','AF'), ('TN','AF'), ('TZ','AF'), ('UG','AF'),
  ('YT','AF'), ('ZA','AF'), ('ZM','AF'), ('ZW','AF'), ('AQ','AN'), ('GS','AN'),
  ('TF','AN'), ('AE','AS'), ('AF','AS'), ('AM','AS'), ('AZ','AS'), ('BD','AS'),
  ('BH','AS'), ('BN','AS'), ('BT','AS'), ('CC','AS'), ('CN','AS'), ('CX','AS'),
  ('CY','AS'), ('GE','AS'), ('HK','AS'), ('ID','AS'), ('IL','AS'), ('IN','AS'),
  ('IO','AS'), ('IQ','AS'), ('IR','AS'), ('JO','AS'), ('JP','AS'), ('KG','AS'),
  ('KH','AS'), ('KP','AS'), ('KR','AS'), ('KW','AS'), ('KZ','AS'), ('LA','AS'),
  ('LB','AS'), ('LK','AS'), ('MM','AS'), ('MN','AS'), ('MO','AS'), ('MV','AS'),
  ('MY','AS'), ('NP','AS'), ('OM','AS'), ('PH','AS'), ('PK','AS'), ('PS','AS'),
  ('QA','AS'), ('SA','AS'), ('SG','AS'), ('SY','AS'), ('TH','AS'), ('TJ','AS'),
  ('TL','AS'), ('TM','AS'), ('TR','AS'), ('TW','AS'), ('UZ','AS'), ('VN','AS'),
  ('YE','AS'), ('AD','EU'), ('AL','EU'), ('AT','EU'), ('AX','EU'), ('BA','EU'),
  ('BE','EU'), ('BG','EU'), ('BY','EU'), ('CH','EU'), ('CZ','EU'), ('DE','EU'),
  ('DK','EU'), ('EE','EU'), ('ES','EU'), ('FI','EU'), ('FO','EU'), ('FR','EU'),
  ('GB','EU'), ('GG','EU'), ('GI','EU'), ('GR','EU'), ('HR','EU'), ('HU','EU'),
  ('IE','EU'), ('IM','EU'), ('IS','EU'), ('IT','EU'), ('JE','EU'), ('LI','EU'),
  ('LT','EU'), ('LU','EU'), ('LV','EU'), ('MC','EU'), ('MD','EU'), ('ME','EU'),
  ('MK','EU'), ('MT','EU'), ('NL','EU'), ('NO','EU'), ('PL','EU'), ('PT','EU'),
  ('RO','EU'), ('RS','EU'), ('RU','EU'), ('SE','EU'), ('SI','EU'), ('SJ','EU'),
  ('SK','EU'), ('SM','EU'), ('UA','EU'), ('VA','EU'), ('AG','NA'), ('AI','NA'),
  ('AW','NA'), ('BB','NA'), ('BL','NA'), ('BM','NA'), ('BQ','NA'), ('BS','NA'),
  ('BZ','NA'), ('CA','NA'), ('CR','NA'), ('CU','NA'), ('CW','NA'), ('DM','NA'),
  ('DO','NA'), ('GD','NA'), ('GL','NA'), ('GP','NA'), ('GT','NA'), ('HN','NA'),
  ('HT','NA'), ('JM','NA'), ('KN','NA'), ('KY','NA'), ('LC','NA'), ('MF','NA'),
  ('MQ','NA'), ('MS','NA'), ('MX','NA'), ('NI','NA'), ('PA','NA'), ('PM','NA'),
  ('PR','NA'), ('SV','NA'), ('SX','NA'), ('TC','NA'), ('TT','NA'), ('US','NA'),
  ('VC','NA'), ('VG','NA'), ('VI','NA'), ('AS','OC'), ('AU','OC'), ('CK','OC'),
  ('FJ','OC'), ('FM','OC'), ('GU','OC'), ('KI','OC'), ('MH','OC'), ('MP','OC'),
  ('NC','OC'), ('NF','OC'), ('NR','OC'), ('NU','OC'), ('NZ','OC'), ('PF','OC'),
  ('PG','OC'), ('PN','OC'), ('PW','OC'), ('SB','OC'), ('TK','OC'), ('TO','OC'),
  ('TV','OC'), ('UM','OC'), ('VU','OC'), ('WF','OC'), ('WS','OC'), ('AR','SA'),
  ('BO','SA'), ('BR','SA'), ('CL','SA'), ('CO','SA'), ('EC','SA'), ('FK','SA'),
  ('GF','SA'), ('GY','SA'), ('PE','SA'), ('PY','SA'), ('SR','SA'), ('UY','SA'),
  ('VE','SA')
ON CONFLICT (code) DO NOTHING;


-- ── Storage buckets ──────────────────────────────────────────────────────────
-- Supabase Storage. Both are public read: BGG cover art is re-hosted at import
-- time so the app doesn't depend on the BGG CDN at runtime, and play photos are
-- uploaded by users. On a non-Supabase database this block has no storage
-- schema to write to and can be skipped.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('boardgamebuddy-games', 'boardgamebuddy-games', true, 5242880,
   ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  ('boardgamebuddy-plays', 'boardgamebuddy-plays', true, 5242880,
   ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
ON CONFLICT (id) DO NOTHING;
