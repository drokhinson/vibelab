"""AI drafting for reference-guide chapters.

The editor's "Generate with AI" button posts a game + chapter type and gets
back a title and a markdown body to drop into the form. Nothing is saved — the
user reviews and edits before hitting Save, so the model's job is to produce a
good starting draft, not a finished chapter.

Small structured task (~1k in / ~600 out tokens), well inside Gemini's free
tier. Uses the shared caller in shared-backend/gemini.py.
"""

import re
from typing import Optional

from gemini import GeminiError, generate_json

from ..dependencies import APP_NAME

CHAPTER_GEN_MAX_TOKENS = 2000
# Warmer than Trove's extraction (which runs at 0): a chapter is prose, and two
# users drafting the same Setup chapter shouldn't get a byte-identical result.
CHAPTER_GEN_TEMPERATURE = 0.4

# Longest slice of the BGG description we hand the model. Full descriptions run
# to several thousand characters of marketing copy; the first ~1500 carry the
# mechanics summary, which is all that helps here.
_DESCRIPTION_LIMIT = 1500

# Matches the DB/ChapterCreate title cap.
_TITLE_LIMIT = 200

# ── Markdown spec ────────────────────────────────────────────────────────────
# KEEP IN SYNC with CHAPTER_AUTHORING_GUIDE in
# projects/boardgame-buddy/web/views/reference-guide-add-view.js — the same
# text is shown in the in-app authoring-guide modal and offered as a .md
# download. Both must match what web/ui/markdown.js actually renders; anything
# not listed here shows up as literal text in the app.
_AUTHORING_GUIDE = """## Writing a BoardgameBuddy chapter

A **chapter** is one focused slice of a game's rules — Setup, Your Turn,
Scoring, a card reference, tips, or a variant. Players open it mid-game to
answer one question fast, so a chapter is a **quick-reference card, not the
rulebook**. Pick the matching chapter type, give it a short title, and write
the body using the markdown below.

## What to focus on

- **Simplicity** — one topic per chapter. If you are explaining two things, write two chapters.
- **Quick reference** — a player is mid-turn, so lead with the answer; use short headings, tight bullets, and tables for any lookup.
- **Brevity** — trim every sentence that isn't load-bearing.
- **Bold the keywords** so the eye can jump straight to them.

## Supported formatting

Only these components render — anything else shows up as plain text.

- **Headings** — start a line with `## `, `### `, or `#### `. There is no H1 (`# `); the chapter title field is the H1, so begin body sections at `## `.
- **Bullet lists** — start each line with `- ` (or `* `), one item per line.
- **Bold** — wrap text in double asterisks, like **this**.
- **Italic** — wrap text in single asterisks, like *this*.
- **Inline code** — wrap text in backticks, like `this`.
- **Links** — write `[label](https://example.com)`. Only http(s), `mailto:`, and root-relative (`/path`) links are allowed; anything else stays literal text. Links open in a new tab.
- **Coloured text** — `<span style="color:#C9922A">text</span>` (hex colours only). The colour button in the toolbar inserts one for you.
- **Tables** — a header row, a `---` separator row, then data rows, like:

| Symbol | Means  |
| ---    | ---    |
| sword  | Attack |
| shield | Defend |

## Not supported

Numbered lists, blockquotes, images, code fences, and raw HTML (other than the
colour span) are **not** rendered — they appear exactly as typed. Stick to the
components above.
"""

_SYSTEM = (
    "You write quick-reference cards for board game players. Given a game and "
    "one chapter type, you draft a single focused reference chapter that a "
    "player can read mid-game to answer one question fast. Respond with ONLY a "
    "JSON object — no prose, no code fences."
)


def _build_prompt(
    *,
    game_name: str,
    game_year: Optional[int],
    game_description: Optional[str],
    chapter_type_label: str,
) -> str:
    lines = [
        f"Game: {game_name}",
    ]
    if game_year:
        lines.append(f"Year published: {game_year}")
    if game_description:
        desc = " ".join(game_description.split())[:_DESCRIPTION_LIMIT]
        lines.append(f"Publisher description: {desc}")
    lines.append(f"Chapter type to write: {chapter_type_label}")
    lines.append("")
    lines.append(
        "Draft ONE chapter of this type for this game. Follow the authoring "
        "guide below exactly — it describes the only markdown that renders in "
        "the app."
    )
    lines.append("")
    lines.append(_AUTHORING_GUIDE)
    lines.append("")
    lines.append(
        "If you do not reliably know this specific game's rules, do NOT invent "
        "specific numbers, card names, or costs. Write a useful skeleton for "
        "this chapter type instead — the headings, prompts, and table columns "
        "the player should fill in from their rulebook."
    )
    lines.append("")
    lines.append(
        "Respond with exactly this JSON shape:\n"
        '{"title": "short chapter title, under 60 characters, no game name",\n'
        ' "content": "the chapter body as markdown, starting at a ## heading, '
        'no # H1"}'
    )
    return "\n".join(lines)


def _coerce(data: dict) -> tuple[str, str]:
    """Validate + normalize the model's reply into (title, content)."""
    title = data.get("title")
    content = data.get("content")
    if not isinstance(title, str) or not isinstance(content, str):
        raise GeminiError(f"unexpected chapter reply shape: {str(data)[:200]}")

    title = " ".join(title.split())[:_TITLE_LIMIT].strip()
    content = content.strip()

    # The title field IS the H1, so a leading "# Foo" line in the body is
    # redundant (and renders as literal text). Same normalization the .md
    # import does in the editor.
    content = re.sub(r"^#\s+\S[^\n]*\n+", "", content)
    content = content.strip()

    if not title or not content:
        raise GeminiError("Gemini returned an empty chapter")
    return title, content


async def generate_chapter(
    *,
    game_name: str,
    game_year: Optional[int],
    game_description: Optional[str],
    chapter_type_id: str,
    chapter_type_label: str,
) -> tuple[str, str]:
    """Draft one chapter. Returns (title, markdown content).

    Raises GeminiError on any failure — the route maps it to a 502.
    """
    data = await generate_json(
        app=APP_NAME,
        system=_SYSTEM,
        prompt=_build_prompt(
            game_name=game_name,
            game_year=game_year,
            game_description=game_description,
            chapter_type_label=chapter_type_label,
        ),
        max_tokens=CHAPTER_GEN_MAX_TOKENS,
        temperature=CHAPTER_GEN_TEMPERATURE,
        params={"game": game_name, "chapter_type": chapter_type_id},
    )
    return _coerce(data)
