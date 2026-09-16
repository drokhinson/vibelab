# BoardgameBuddy migration archive

The 73 files in this directory are the migration history of
`db/migrations/boardgamebuddy/` as it stood before the 2026-09-01 collapse.
They are kept **for reference only** and are never executed — not on
production, not on a fresh database. The three files one level up
(`001_baseline.sql`, `002_seed.sql`, `003_rpcs.sql`) reproduce the exact end
state of running all 73 of these in order, and are what a fresh database gets.

They are worth keeping because the collapsed files record *what* the schema is,
and these record *why*. Most carry a long comment explaining the problem the
migration solved, and roughly 43 code comments across
`shared-backend/routes/boardgame_buddy/` and `projects/boardgame-buddy/` still
cite them by number ("migration 045", "per 065") — those references resolve
here.

## Reading them

Numeric order is chronological order. A few landmarks:

- `001_baseline.sql` / `002_seed.sql` — themselves the product of an earlier
  collapse, on 2026-05-01, which folded a flat `001…064_boardgamebuddy_*.sql`
  layout into per-app directories.
- `018_chapters_rename.sql` — the guide "chunk" → "chapter" rename that gives
  three tables their current names, and deletes the seeded guide rows.
- `044_cleanup.sql`, `064_profile_bundle_buddy_blocks.sql` — the two big
  removals; several tables and columns stop existing here.
- `070_ghost_claims.sql` — the largest single migration, ten functions.

## Do not add to this directory

New migrations go in the parent directory as `004_<desc>.sql` onward, on the
per-app counter. This archive is closed.
