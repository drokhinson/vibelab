# BoardgameBuddy migration archive

Superseded migration history, kept **for reference only** and never executed —
not on production, not on a fresh database. Each subdirectory is one
generation: the files that were live until a squash folded them into the
baseline. The generated baseline one level up (`001_baseline_tables.sql`
through `004_seed.sql`) reproduces the end state of every generation here.

| Directory | Files | Squashed into | Squashed on |
|---|---|---|---|
| `2026-09-01/` | `001`–`073` | the three files that open `2026-09-28/` | 2026-09-01 |
| `2026-09-28/` | `001`–`058` | `../001_baseline_tables.sql` … `../004_seed.sql` | 2026-09-28 |

These files record how the schema got where it is. Nothing outside this
directory cites them: code comments and the baseline describe the tables and
functions as they stand, and the history belongs here, in commit messages and
in `STRUCTURE.md`'s changelog. Inside a generation, a file's own comments may
cite its neighbours by number or as `archive/NNN`; those references are to the
same generation, except that `2026-09-28/`'s files use `archive/NNN` for
`2026-09-01/NNN`.

## Do not add to this directory

New migrations go in the parent directory on the running counter, which
continues past the newest archived number so an archived file and a live one
never share a number. The next squash
(`.claude/skills/squash-migrations/SKILL.md`) moves them here as a new dated
generation.
