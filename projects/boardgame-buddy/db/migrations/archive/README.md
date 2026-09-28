# BoardgameBuddy migration archive

Superseded migration history, kept **for reference only** and never executed —
not on production, not on a fresh database. Each subdirectory is one
generation: the files that were live until a squash folded them into the
baseline. `../001_baseline.sql` and `../002_seed.sql` reproduce the end state of
every generation here, and are all a fresh database gets.

| Directory | Files | Squashed into | Squashed on |
|---|---|---|---|
| `2026-09-01/` | `001`–`073` | the three files that open `2026-09-28/` | 2026-09-01 |
| `2026-09-28/` | `001`–`058` | `../001_baseline.sql`, `../002_seed.sql` | 2026-09-28 |

The files are kept because the baseline records *what* the schema is, and
these record *why*: most carry a long comment on the problem the migration
solved. The baseline names, for every table and function, the files in the
newest generation that shaped it.

## Resolving a migration number

Hundreds of code comments cite migrations by number, so numbers never repeat
outside the baseline:

- **`archive/NNN`** (the form written between the two squashes, in code and
  inside `2026-09-28/`'s own files) → `2026-09-01/NNN`.
- **A bare number** — "migration 045", "per 048", `db/tests/057_*.sql` —
  usually → `2026-09-28/NNN` (whose `001`–`003` are themselves the 2026-09-01
  squash). A comment older than 2026-09-01 can mean `2026-09-01/NNN` instead;
  the subject matter settles which, and the two generations rarely share one.
- **`059` onward** → the live directory, `../`. The counter continues past the
  newest archived number rather than restarting, which is what keeps every
  bare number above unambiguous.

## Do not add to this directory

New migrations go in the parent directory on the running counter. The next
squash (see `.claude/skills/squash-migrations/SKILL.md`) moves them here as a
new dated generation.
