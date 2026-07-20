"""Structured parse trace for one import — the audit record the user downloads.

`process_source` builds one `ImportTrace` as it runs, appending a step per
pipeline stage (capture → URL expansion → caption recovery → page fetch → AI
request/response → result splits → geocode → materialize → final). The trace is
persisted to `travelscrapbook_import_traces` (newest 5 per user kept) and
rendered to an HTML flowchart on download so the user can audit exactly what
happened to a link.

Purely observational: appending steps never changes the import outcome, and
every long text field is clipped so a giant page or prompt can't bloat the row.
"""

from typing import Any, Optional

# Cap long text fields (prompt, AI response, page excerpt) so one import can't
# bloat the JSONB row; the flowchart shows a "…(truncated)" marker instead.
MAX_TEXT_CHARS = 4000


def clip(value: Optional[str], limit: int = MAX_TEXT_CHARS) -> Optional[str]:
    """Truncate a long string for storage, annotating how much was dropped."""
    if value is None:
        return None
    text = str(value)
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…(truncated, {len(text) - limit} more chars)"


class ImportTrace:
    """An append-only list of pipeline steps for one source import.

    Each step is ``{"kind", "title", "data"}``. ``kind`` drives the node's
    colour/shape in the rendered flowchart; known kinds are: capture,
    url_expansion, caption_recovery, page_fetch, llm_request, llm_response,
    result_split, geocode, materialize, note, final.
    """

    def __init__(self, url: str) -> None:
        self.url = url
        self.steps: list[dict[str, Any]] = []

    def add(self, kind: str, title: str, data: Optional[dict[str, Any]] = None) -> None:
        """Append one flowchart node."""
        self.steps.append({"kind": kind, "title": title, "data": data or {}})

    def to_json(self) -> dict[str, Any]:
        """The stored/rendered shape."""
        return {"url": self.url, "steps": self.steps}
