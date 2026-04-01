-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — seed data
-- Migration 033
-- Populates boardgamebuddy_games with ~20 top-ranked BGG titles so the
-- Browse view is usable out of the box without importing games manually.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.boardgamebuddy_games
  (bgg_id, name, year_published, min_players, max_players, playing_time,
   bgg_rank, bgg_rating, categories, mechanics, theme_color)
VALUES
  (174430, 'Gloomhaven',                    2017, 1, 4, 120,  1, 8.70,
   ARRAY['Adventure','Fantasy','Fighting'],
   ARRAY['Campaign','Hand Management','Modular Board'],
   '#2c3e50'),

  (224517, 'Brass: Birmingham',             2018, 2, 4,  60,  2, 8.60,
   ARRAY['Economic','Industry','Transportation'],
   ARRAY['Hand Management','Network Building','Route Building'],
   '#c0392b'),

  (161936, 'Pandemic Legacy: Season 1',     2015, 2, 4,  60,  3, 8.60,
   ARRAY['Medical','Cooperative'],
   ARRAY['Campaign','Hand Management','Variable Player Powers'],
   '#27ae60'),

  (162886, 'Spirit Island',                 2017, 1, 4, 120,  4, 8.40,
   ARRAY['Fantasy','Territory Building','Cooperative'],
   ARRAY['Area Control','Hand Management','Variable Player Powers'],
   '#16a085'),

  (182028, 'Through the Ages: A New Story', 2015, 2, 4, 120,  5, 8.30,
   ARRAY['Civilization','Card Game'],
   ARRAY['Card Drafting','Hand Management','Worker Placement'],
   '#8e44ad'),

  (12333,  'Twilight Struggle',             2005, 2, 2, 180,  7, 8.20,
   ARRAY['Political','Wargame','Card Game'],
   ARRAY['Area Control','Card Driven','Hand Management'],
   '#2980b9'),

  (84876,  'The Castles of Burgundy',       2011, 2, 4,  90,  9, 8.10,
   ARRAY['Medieval','Dice'],
   ARRAY['Dice Rolling','Set Collection','Tile Placement'],
   '#d35400'),

  (120677, 'Terra Mystica',                 2012, 2, 5, 150, 11, 8.10,
   ARRAY['Fantasy','Territory Building'],
   ARRAY['Area Control','Income','Variable Player Powers'],
   '#7f8c8d'),

  (31260,  'Agricola',                      2007, 1, 5,  90, 14, 7.90,
   ARRAY['Economic','Farming'],
   ARRAY['Hand Management','Worker Placement'],
   '#795548'),

  (266192, 'Wingspan',                      2019, 1, 5,  70, 21, 8.00,
   ARRAY['Animals','Card Game','Nature'],
   ARRAY['Card Drafting','Hand Management','Set Collection'],
   '#1abc9c'),

  (3076,   'Puerto Rico',                   2002, 3, 5,  90, 23, 7.90,
   ARRAY['Economic','City Building'],
   ARRAY['Role Selection','Variable Player Powers','Worker Placement'],
   '#f39c12'),

  (2651,   'Power Grid',                    2004, 2, 6, 120, 27, 7.80,
   ARRAY['Economic','Industry','City Building'],
   ARRAY['Auction','Network Building','Route Building'],
   '#e67e22'),

  (183394, 'Viticulture: Essential Edition',2015, 2, 6,  90, 29, 8.00,
   ARRAY['Economic','Farming'],
   ARRAY['Hand Management','Worker Placement'],
   '#8e44ad'),

  (37111,  'Race for the Galaxy',           2007, 2, 4,  45, 44, 7.80,
   ARRAY['Card Game','Science Fiction','Space'],
   ARRAY['Card Drafting','Hand Management','Simultaneous Action'],
   '#2980b9'),

  (68448,  '7 Wonders',                     2010, 2, 7,  30, 42, 7.70,
   ARRAY['Ancient','Card Game','Civilization'],
   ARRAY['Card Drafting','Hand Management','Set Collection'],
   '#f1c40f'),

  (36218,  'Dominion',                      2008, 2, 4,  30, 52, 7.60,
   ARRAY['Card Game','Medieval'],
   ARRAY['Deck Building','Hand Management'],
   '#2c3e50'),

  (9209,   'Ticket to Ride',                2004, 2, 5,  75,128, 7.40,
   ARRAY['Trains','Route Building','Family'],
   ARRAY['Card Drafting','Hand Management','Route Building'],
   '#e74c3c'),

  (822,    'Carcassonne',                   2000, 2, 5,  45,124, 7.40,
   ARRAY['Medieval','Territory Building','Family'],
   ARRAY['Area Control','Tile Placement'],
   '#9b59b6'),

  (30549,  'Pandemic',                      2008, 2, 4,  45, 89, 7.60,
   ARRAY['Medical','Cooperative','Family'],
   ARRAY['Hand Management','Role Selection','Variable Player Powers'],
   '#27ae60'),

  (13,     'Catan',                         1995, 3, 4,  90,201, 7.10,
   ARRAY['Negotiation','Territory Building','Family'],
   ARRAY['Dice Rolling','Hand Management','Trading'],
   '#e67e22'),

  (50,     'Lost Cities',                   1999, 2, 2,  30,252, 7.30,
   ARRAY['Card Game','Exploration'],
   ARRAY['Hand Management','Set Collection'],
   '#2980b9')

ON CONFLICT (bgg_id) DO NOTHING;
