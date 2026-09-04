"""CSV and ZIP primitives for the data export.

Deliberately free of Supabase and FastAPI imports: everything here is a pure
function over rows the caller has already read, which is what makes the export's
formatting decisions — the BOM, the formula guard, how a JSONB column becomes a
cell — testable without a database (see tests/test_export_csv.py).

services/export_service.py owns the reads and the dataset definitions.
"""

from __future__ import annotations

import csv
import io
import json
import zipfile
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Sequence


# A leading one of these makes Excel and Google Sheets treat a cell as a
# formula rather than text, so a display name or a chapter body written by
# somebody else could execute on open. The guard prefixes a tab, which both
# apps strip on import while leaving the visible text intact.
#
# `-` is NOT in the set, on purpose: it is the far more common start of an
# ordinary value (a negative score, a note that opens with a dash), and
# mangling all of those to harden against a payload that also needs a `+` or
# `=` to do anything is the wrong trade.
_FORMULA_LEADERS = ("=", "+", "@")
# Sheets also re-reads a cell starting with a control character, and a raw
# CR/LF/tab at the head of a cell is meaningless data either way.
_CONTROL_LEADERS = ("\t", "\r", "\n")


def _cell(value: Any) -> str:
    """Render one database value as a CSV cell.

    Everything comes back from PostgREST already JSON-decoded, so this is the
    one place that decides what a NULL, a bool, an array column and a JSONB
    blob look like to a spreadsheet.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        # Not "yes"/"no": these files are as likely to be read by a script as
        # by a person, and `true`/`false` is what every CSV reader expects.
        return "true" if value else "false"
    if isinstance(value, (list, dict)):
        # Array and JSONB columns (game categories, a play's round_scores).
        # JSON rather than a joined string so the structure survives the trip.
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    text = str(value)
    if text[:1] in _FORMULA_LEADERS or text[:1] in _CONTROL_LEADERS:
        return "\t" + text
    return text


@dataclass(frozen=True)
class CsvFile:
    """One file inside the archive: its name, its header, and its rows."""

    name: str
    header: Sequence[str]
    rows: Sequence[Sequence[Any]]


def render_csv(f: CsvFile) -> bytes:
    """One CsvFile as the bytes that go into the zip.

    `utf-8-sig` rather than plain UTF-8 because the single most likely thing to
    happen to this file is a double-click into Excel, which still reads a
    BOM-less file as the system codepage and turns every accented game name
    into mojibake. Every other reader skips the BOM.

    `\r\n` is what RFC 4180 specifies and what Excel expects; `csv.writer`
    would otherwise emit the platform default.
    """
    buf = io.StringIO(newline="")
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerow([_cell(h) for h in f.header])
    for row in f.rows:
        writer.writerow([_cell(v) for v in row])
    return buf.getvalue().encode("utf-8-sig")


def build_zip(files: Sequence[CsvFile], readme: str, generated_at: datetime) -> bytes:
    """Pack the rendered CSVs plus a README into one in-memory archive.

    In memory rather than streamed to a temp file: the whole export is rows
    this process has already loaded, so the zip is bounded by what was read,
    and a heavy account's plays are a few megabytes of text that deflate hard.

    Every entry is stamped with the export's own generation time rather than
    `zipfile`'s default of "whenever this line ran", so all seven files date
    from the same moment in a file browser and two exports are told apart by
    their stamp rather than by a spread of microseconds.
    """
    stamp = (
        generated_at.year, generated_at.month, generated_at.day,
        generated_at.hour, generated_at.minute, generated_at.second,
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for name, payload in [
            ("README.txt", readme.encode("utf-8")),
            *((f.name, render_csv(f)) for f in files),
        ]:
            entry = zipfile.ZipInfo(name, date_time=stamp)
            entry.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(entry, payload)
    return buf.getvalue()
