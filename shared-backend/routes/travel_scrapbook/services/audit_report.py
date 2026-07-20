"""Render a stored import trace as a self-contained HTML flowchart.

The user downloads this from Settings → "Import audit" to see exactly what
happened to a link: capture → URL expansion → caption recovery → page fetch →
AI prompt/response → result splits → geocode → materialize → final. Everything
(CSS included) is inlined so the file opens in any browser with no network.
"""

import html
import json
from typing import Any, Optional

# Accent colour + human label per step kind. Unknown kinds fall back to grey.
_KIND_STYLE: dict[str, tuple[str, str]] = {
    "capture": ("#7c9cff", "CAPTURE"),
    "url_expansion": ("#38bdf8", "URL EXPANSION"),
    "caption_recovery": ("#f59e0b", "CAPTION RECOVERY"),
    "page_fetch": ("#22c55e", "PAGE FETCH"),
    "llm_request": ("#a855f7", "AI REQUEST"),
    "llm_response": ("#a855f7", "AI RESPONSE"),
    "result_split": ("#ec4899", "RESULT SPLIT"),
    "geocode": ("#14b8a6", "GEOCODE"),
    "materialize": ("#10b981", "SAVED"),
    "note": ("#ef4444", "NOTE"),
    "final": ("#64748b", "FINAL"),
}

# Keys whose values are long free text → render in a monospace <pre> block.
_PRE_KEYS = {"prompt", "system", "raw", "text_excerpt", "caption", "og_description"}


def _esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def _render_value(key: str, value: Any) -> str:
    """Render one data value: <pre> for long text, nested lists/dicts, else plain."""
    if value is None:
        return '<span class="muted">null</span>'
    if isinstance(value, bool):
        return f'<span class="bool">{"true" if value else "false"}</span>'
    if isinstance(value, (list, tuple)):
        if not value:
            return '<span class="muted">[]</span>'
        items = "".join(f"<li>{_render_value('', v)}</li>" for v in value)
        return f"<ul>{items}</ul>"
    if isinstance(value, dict):
        return _render_dict(value)
    text = str(value)
    if key in _PRE_KEYS or "\n" in text or len(text) > 120:
        return f"<pre>{_esc(text)}</pre>"
    return _esc(text)


def _render_dict(data: dict[str, Any]) -> str:
    if not data:
        return '<span class="muted">—</span>'
    rows = "".join(
        f'<div class="kv"><span class="k">{_esc(k)}</span>'
        f'<span class="v">{_render_value(k, v)}</span></div>'
        for k, v in data.items()
    )
    return f'<div class="dict">{rows}</div>'


def _render_step(index: int, step: dict[str, Any]) -> str:
    kind = str(step.get("kind", ""))
    color, label = _KIND_STYLE.get(kind, ("#94a3b8", kind.upper() or "STEP"))
    title = _esc(step.get("title", kind))
    data = step.get("data") or {}
    body = _render_dict(data) if data else ""
    return f"""
    <div class="node" style="--accent:{color}">
      <div class="node-head">
        <span class="badge">{_esc(label)}</span>
        <span class="node-title">{title}</span>
        <span class="node-num">#{index}</span>
      </div>
      {f'<div class="node-body">{body}</div>' if body else ''}
    </div>"""


def render_trace_html(
    url: str,
    final_status: Optional[str],
    error_kind: Optional[str],
    created_at: Optional[str],
    trace: dict[str, Any],
) -> str:
    """Build the full standalone HTML document for one import trace."""
    steps = trace.get("steps") or []
    status = final_status or "unknown"
    status_class = "ok" if status == "ready" else ("fail" if status == "failed" else "warn")
    err = f' · {_esc(error_kind)}' if error_kind else ""
    nodes = "\n<div class=\"arrow\">↓</div>\n".join(
        _render_step(i + 1, s) for i, s in enumerate(steps)
    )
    raw_json = _esc(json.dumps(trace, indent=2, ensure_ascii=False))

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Import audit — {_esc(url)}</title>
<style>
  :root {{ color-scheme: light dark; }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; padding: 2rem 1rem 4rem;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f7f7fb; color: #1e2233;
  }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #14161f; color: #e6e8f0; }}
    .node, header, details {{ background: #1c1f2b !important; border-color: #2b2f3d !important; }}
    pre {{ background: #0f1119 !important; }}
    .kv .k {{ color: #9aa3b8 !important; }}
  }}
  .wrap {{ max-width: 820px; margin: 0 auto; }}
  header {{
    background: #fff; border: 1px solid #e3e5ee; border-radius: 14px;
    padding: 1.1rem 1.3rem; margin-bottom: 1.6rem;
  }}
  header h1 {{ font-size: 1.15rem; margin: 0 0 .5rem; }}
  header .url {{ word-break: break-all; font-family: ui-monospace, Menlo, monospace; font-size: .82rem; opacity: .8; }}
  .status {{ display: inline-block; margin-top: .6rem; padding: .2rem .6rem; border-radius: 999px; font-size: .78rem; font-weight: 700; }}
  .status.ok {{ background: #dcfce7; color: #166534; }}
  .status.fail {{ background: #fee2e2; color: #991b1b; }}
  .status.warn {{ background: #fef9c3; color: #854d0e; }}
  .meta {{ font-size: .78rem; opacity: .65; margin-top: .5rem; }}
  .node {{
    background: #fff; border: 1px solid #e3e5ee; border-left: 5px solid var(--accent);
    border-radius: 12px; padding: .85rem 1rem; box-shadow: 0 1px 2px rgba(0,0,0,.04);
  }}
  .node-head {{ display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }}
  .badge {{
    background: var(--accent); color: #fff; font-size: .64rem; font-weight: 800;
    letter-spacing: .05em; padding: .2rem .5rem; border-radius: 6px; white-space: nowrap;
  }}
  .node-title {{ font-weight: 650; }}
  .node-num {{ margin-left: auto; font-size: .75rem; opacity: .5; font-variant-numeric: tabular-nums; }}
  .node-body {{ margin-top: .7rem; }}
  .arrow {{ text-align: center; color: #9aa3b8; font-size: 1.2rem; line-height: 1; margin: .35rem 0; }}
  .dict {{ display: flex; flex-direction: column; gap: .35rem; }}
  .kv {{ display: grid; grid-template-columns: minmax(90px, 160px) 1fr; gap: .6rem; align-items: start; }}
  .kv .k {{ color: #6b7280; font-size: .8rem; font-weight: 600; word-break: break-word; }}
  .kv .v {{ min-width: 0; word-break: break-word; }}
  ul {{ margin: .2rem 0; padding-left: 1.1rem; }}
  pre {{
    background: #f1f2f7; border-radius: 8px; padding: .6rem .7rem; margin: .2rem 0;
    overflow-x: auto; font-family: ui-monospace, Menlo, monospace; font-size: .78rem; white-space: pre-wrap; word-break: break-word;
  }}
  .muted {{ opacity: .5; }}
  .bool {{ font-weight: 700; }}
  details {{ margin-top: 1.8rem; background: #fff; border: 1px solid #e3e5ee; border-radius: 12px; padding: .8rem 1rem; }}
  summary {{ cursor: pointer; font-weight: 650; }}
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>Import audit</h1>
      <div class="url">{_esc(url)}</div>
      <span class="status {status_class}">{_esc(status)}{err}</span>
      <div class="meta">Imported {_esc(created_at or "—")} · {len(steps)} step(s)</div>
    </header>
    {nodes}
    <details>
      <summary>Raw trace (JSON)</summary>
      <pre>{raw_json}</pre>
    </details>
  </div>
</body>
</html>"""
