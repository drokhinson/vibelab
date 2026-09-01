"""AI extraction for the Settings play importer.

Someone arrives with years of play history already written down — an Apple
Note of tally marks, an iCloud Notes table, a photo they typed up. This turns
that block of text into structured plays for the import wizard to review.

Nothing here writes anything. The reply is a draft the user walks through
across three resolution steps (players, games, dates) before a single row is
inserted, so the model's job is to read what is written, not to be right.

Two note shapes drove the contract, and both are in the prompt as examples:

  • A tally note — a game heading, then `Sean - ||||-||||-…` per player, then a
    handful of named games with real scores ("Biggest Win", "Closest Game")
    and a line saying one game was a tie. Over a hundred plays, nearly all of
    them winner-only repeats, and a second game further down the same note.
  • A two-column table — "Who won?" / "Who played?", with `Marco x4` meaning
    four repeats, no dates, no scores, and the same person written both
    `Jasmine` and `Jas`.

`count` exists for the first shape: a 106-play run written out play by play is
a reply the model loses count of halfway through, so it writes the run once and
says how long it is. The client expands it.

Larger job than chapter drafting (~5k in / ~4k out on a long note) but the same
free-tier path — the shared caller in shared-backend/gemini.py.
"""

import logging
from datetime import date
from typing import Any, Optional

from gemini import GeminiError, generate_json

from ..constants import (
    MAX_IMPORT_NAME_CHARS,
    MAX_IMPORT_PLAYERS_PER_PLAY,
    MAX_IMPORT_PLAYS,
    MAX_REPEAT_COUNT,
)
from ..dependencies import APP_NAME
from ..models import ParsedPlay, ParsedPlayer

logger = logging.getLogger(__name__)

# A long note with a hundred distinct entries is the worst case; 8000 covers it
# with room over, and `count` is what keeps the common case far below it.
IMPORT_PARSE_MAX_TOKENS = 8000
# Zero. This is extraction, not drafting: the same note pasted twice must
# produce the same plays, or the user cannot trust the review list.
IMPORT_PARSE_TEMPERATURE = 0.0

# Longest note excerpt echoed into a log line on a malformed reply.
_LOG_EXCERPT = 200

_SYSTEM = (
    "You extract board game play records from a person's private notes. The "
    "notes are informal — tally marks, tables, shorthand names, half-finished "
    "sentences. You read what is actually written and never invent a score, a "
    "date, or a player that is not there. Respond with ONLY a JSON object — no "
    "prose, no code fences."
)

_OUTPUT_CONTRACT = """Respond with exactly this JSON shape:

{
  "plays": [
    {
      "game": "the game's name exactly as written in the note",
      "played_at": "YYYY-MM-DD or null if the note does not say",
      "count": 1,
      "notes": "any short detail the note gives about this play, else null",
      "players": [
        {"name": "player as written", "is_winner": true, "score": 429}
      ]
    }
  ],
  "warnings": ["anything you could not read, or had to guess at"]
}"""

_RULES = """Rules:

- ONE entry per play. If the note records several IDENTICAL plays — a run of
  tally marks, "Marco x4", "we played 12 times and Sean won them all" — write
  ONE entry with "count" set to how many. Never write the same play out
  repeatedly, and never use "count" for plays that differ from each other.
- A play with its own detail (a score, a date, a note like "closest game")
  gets its own entry with "count": 1, even when it is part of a longer run.
  Subtract those from the run's count so the total still adds up.
- "score" is a number or null. Only fill it in when a number is written down
  next to that player for that specific play. A running total, a lifetime
  tally, or a count of wins is NOT a score — leave it null.
- "is_winner" is true for the winner. A tie means MORE THAN ONE player has
  is_winner true. A play where the note does not say who won has is_winner
  false for everyone.
- "played_at" is only ever a date the note actually gives for that play. A
  note's own creation or edit timestamp is not a play date. Never guess a
  date, and never use today's date — write null.
- "game" is whatever the note calls it — a heading, a title, a column. One
  note often holds several games; give each play the game it sits under.
- Player names stay exactly as written, including shorthand. Do NOT normalise
  "Jas" to "Jasmine" or merge two spellings; the person importing decides that
  afterwards, and merging them here would hide the choice from them.
- If a line is not a play at all — a heading, a total, a stray thought — skip
  it. Say so in "warnings" if you are unsure.
- Do not invent plays to reach a number the note mentions. If the note says
  106 games and you can only account for 90, write the 90 and say so in
  "warnings"."""

_EXAMPLES = """Two examples of the kinds of notes this gets.

A tally note:

    Carcassonne
    Sean - ||||-||||-||||-||||
    Mick - ||||-||||-||||-|||
    Biggest Win: Mick: 644  Sean: 429
    Closest Game: Sean: 330  Mick: 328
    In the 38th game, we tied

reads as four entries — a run of Sean wins and a run of Mick wins with their
counts reduced by the games described individually, then the biggest win (Mick
644, Sean 429), the closest game (Sean 330, Mick 328), and the tie (both
players is_winner true, no scores). No dates anywhere.

A table:

    Ark nova
    Who won?   | Who played?
    Marco x4   | Marco, Jasmine
    Jasmine    | Jasmine, Lachie
    Lachie     | Jasmine, Lachie, Marco

reads as three entries: Marco beating Jasmine with count 4, Jasmine beating
Lachie, and Lachie beating Jasmine and Marco. No scores, no dates. "Jas" stays
"Jas" if that is what a row says."""


def _build_prompt(*, text: str, hint: Optional[str]) -> str:
    lines: list[str] = []
    if hint and hint.strip():
        # The user's own description of their shorthand. It goes ABOVE the
        # note so the model reads the key before the thing it unlocks.
        lines.append("Notes from the user about how this is organised:")
        lines.append(" ".join(hint.split()))
        lines.append("")
    lines.append("The note to read:")
    lines.append("---")
    lines.append(text)
    lines.append("---")
    lines.append("")
    lines.append(_RULES)
    lines.append("")
    lines.append(_EXAMPLES)
    lines.append("")
    lines.append(_OUTPUT_CONTRACT)
    return "\n".join(lines)


def _clean_name(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    name = " ".join(value.split())[:MAX_IMPORT_NAME_CHARS].strip()
    return name or None


def _coerce_score(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _coerce_date(value: Any) -> Optional[date]:
    """A date the note gave, or None. A future date is a hallucination."""
    if not isinstance(value, str):
        return None
    try:
        parsed = date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None
    return None if parsed > date.today() else parsed


def _coerce_players(raw: Any) -> list[ParsedPlayer]:
    if not isinstance(raw, list):
        return []
    players: list[ParsedPlayer] = []
    for item in raw[:MAX_IMPORT_PLAYERS_PER_PLAY]:
        if not isinstance(item, dict):
            continue
        name = _clean_name(item.get("name"))
        if not name:
            continue
        players.append(ParsedPlayer(
            name=name,
            is_winner=bool(item.get("is_winner")),
            score=_coerce_score(item.get("score")),
        ))
    return players


def _coerce(data: dict) -> tuple[list[ParsedPlay], list[str]]:
    """Validate the model's reply into plays the wizard can show.

    This is the trust boundary: everything past it is treated as data the user
    is about to review, so anything unusable is dropped here rather than
    surfacing as a broken row three steps later.
    """
    raw_plays = data.get("plays")
    if not isinstance(raw_plays, list):
        raise GeminiError(f"unexpected import reply shape: {str(data)[:_LOG_EXCERPT]}")

    warnings: list[str] = [
        " ".join(w.split())[:300]
        for w in (data.get("warnings") or [])
        if isinstance(w, str) and w.strip()
    ]

    plays: list[ParsedPlay] = []
    expanded = 0
    for item in raw_plays:
        if not isinstance(item, dict):
            continue
        game = _clean_name(item.get("game"))
        players = _coerce_players(item.get("players"))
        # A play with no game or nobody at the table is not reviewable — the
        # wizard would show an empty row the user can only delete.
        if not game or not players:
            continue

        count = _coerce_score(item.get("count")) or 1
        count = max(1, min(count, MAX_REPEAT_COUNT))
        if expanded + count > MAX_IMPORT_PLAYS:
            remaining = MAX_IMPORT_PLAYS - expanded
            if remaining <= 0:
                warnings.append(
                    f"Stopped at {MAX_IMPORT_PLAYS} plays — the rest of the note "
                    "wasn't imported. Split it and run the importer again."
                )
                break
            count = remaining

        notes = item.get("notes")
        plays.append(ParsedPlay(
            game=game,
            played_at=_coerce_date(item.get("played_at")),
            count=count,
            notes=" ".join(notes.split())[:500] if isinstance(notes, str) and notes.strip() else None,
            players=players,
        ))
        expanded += count

    if not plays:
        raise GeminiError("no readable plays in the note")
    return plays, warnings


async def parse_plays(*, text: str, hint: Optional[str]) -> tuple[list[ParsedPlay], list[str]]:
    """Read a pasted note into draft plays. Returns (plays, warnings).

    Raises GeminiError on every failure mode — the route maps it to a 502.
    """
    data = await generate_json(
        app=APP_NAME,
        system=_SYSTEM,
        prompt=_build_prompt(text=text, hint=hint),
        max_tokens=IMPORT_PARSE_MAX_TOKENS,
        temperature=IMPORT_PARSE_TEMPERATURE,
        params={"chars": len(text), "hinted": bool(hint and hint.strip())},
    )
    return _coerce(data)
