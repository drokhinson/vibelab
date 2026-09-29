#!/usr/bin/env python3
"""Squash one app's migration history into a generated baseline + seed.

Replays the migrations into a throwaway Postgres cluster that stubs the parts
of Supabase they touch (supabase_stubs.sql), reads the end state back out of
the catalog, and writes it as:

  001_baseline_tables.sql            roles, extensions, tables, RLS policies
  00N_baseline_functions_<group>.sql one per --function-group
  00M_seed.sql                       reference rows

With --verify it then builds a second database from those files and diffs it
against the replay; any difference is printed and the exit status is 1.

The script never touches the migrations directory: it writes to --out and
leaves archiving to the caller (see SKILL.md). SKILL.md also keeps the exact
invocation for each app that has been squashed.
"""

import argparse
import datetime
import difflib
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time

HERE = os.path.dirname(os.path.abspath(__file__))
STUBS = os.path.join(HERE, "supabase_stubs.sql")

# Supabase's ALTER DEFAULT PRIVILEGES hand every new table and function in
# `public` to these three roles, and Postgres gives functions EXECUTE to PUBLIC.
# Generated grants are written as the difference from this starting point, so
# a table the migrations never touched the grants of gets no GRANT lines.
DEFAULT_ROLES = ["anon", "authenticated", "service_role"]
TABLE_PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]
STUB_ROLES = set(DEFAULT_ROLES) | {"postgres"}

RULE = "-- " + "─" * 77


# ── Throwaway cluster ────────────────────────────────────────────────────────

def pg_bin(name):
    for d in sorted(glob.glob("/usr/lib/postgresql/*/bin"), reverse=True):
        if os.path.exists(os.path.join(d, name)):
            return os.path.join(d, name)
    found = shutil.which(name)
    if not found:
        sys.exit(f"{name} not found — install PostgreSQL server binaries")
    return found


class Cluster:
    """initdb + pg_ctl in a temp dir, on a unix socket only. Runs as the
    postgres OS user when invoked as root, since initdb refuses root."""

    def __init__(self, port):
        self.port = str(port)
        self.dir = tempfile.mkdtemp(prefix="squash-pg-")
        self.data = os.path.join(self.dir, "data")
        self.as_postgres = os.geteuid() == 0
        if self.as_postgres:
            shutil.chown(self.dir, "postgres")
            os.chmod(self.dir, 0o755)

    def _run(self, cmd):
        if self.as_postgres:
            cmd = ["su", "postgres", "-c", " ".join(cmd)]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)

    def start(self):
        self._run([pg_bin("initdb"), "-D", self.data, "-A", "trust", "-U", "postgres"])
        self._run([pg_bin("pg_ctl"), "-D", self.data, "-l", os.path.join(self.dir, "log"),
                   "-o", f"'-p {self.port} -k {self.dir} -c listen_addresses='''",
                   "-w", "start"])

    def stop(self):
        try:
            self._run([pg_bin("pg_ctl"), "-D", self.data, "-m", "fast", "stop"])
        finally:
            shutil.rmtree(self.dir, ignore_errors=True)

    def base_args(self, db):
        return ["-h", self.dir, "-p", self.port, "-U", "postgres", "-d", db]

    def psql_file(self, db, path):
        r = subprocess.run(["psql", *self.base_args(db), "-q", "-v", "ON_ERROR_STOP=1", "-f", path],
                           capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"FAILED replaying {path} into {db}:\n{r.stderr}")

    def query(self, db, sql):
        r = subprocess.run(["psql", *self.base_args(db), "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql],
                           capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"query failed:\n{sql}\n{r.stderr}")
        return r.stdout.rstrip("\n")

    def json(self, db, sql):
        out = self.query(db, f"SELECT coalesce(json_agg(q), '[]') FROM ({sql}) q")
        return json.loads(out)

    def dump(self, db, *args):
        r = subprocess.run([pg_bin("pg_dump"), *self.base_args(db), *args],
                           capture_output=True, text=True, check=True)
        return r.stdout


# ── Catalog reads ────────────────────────────────────────────────────────────

def like_any(col, patterns):
    return f"{col} LIKE ANY (ARRAY[{', '.join(sql_lit(p) for p in patterns)}])"


def sql_lit(s):
    return "'" + s.replace("'", "''") + "'"


def read_tables(c, db, patterns):
    tables = c.json(db, f"""
        SELECT c.oid, c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
               obj_description(c.oid, 'pg_class') AS comment
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND {like_any('c.relname', patterns)}
         ORDER BY c.relname""")
    for t in tables:
        oid = t["oid"]
        t["columns"] = c.json(db, f"""
            SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
                   a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def,
                   a.attidentity AS identity, a.attgenerated AS generated,
                   col_description(a.attrelid, a.attnum) AS comment
              FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE a.attrelid = {oid} AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum""")
        t["constraints"] = c.json(db, f"""
            SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS def,
                   obj_description(oid, 'pg_constraint') AS comment,
                   CASE WHEN contype = 'f' THEN confrelid::regclass::text END AS ref
              FROM pg_constraint WHERE conrelid = {oid} AND contype IN ('p', 'u', 'x', 'c', 'f')
             ORDER BY array_position(ARRAY['p','u','x','c','f']::"char"[], contype), conname""")
        t["indexes"] = c.json(db, f"""
            SELECT pg_get_indexdef(i.indexrelid) AS def,
                   (SELECT format('public.%I', relname) FROM pg_class WHERE oid = i.indexrelid) AS name,
                   obj_description(i.indexrelid, 'pg_class') AS comment
              FROM pg_index i
             WHERE i.indrelid = {oid}
               AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid
                                                               AND k.contype IN ('p', 'u', 'x'))
             ORDER BY i.indexrelid::regclass::text""")
        t["policies"] = c.json(db, f"""
            SELECT p.polname AS name, p.polcmd AS cmd, p.polpermissive AS permissive,
                   ARRAY(SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE quote_ident(r::regrole::text) END
                           FROM unnest(p.polroles) r) AS roles,
                   pg_get_expr(p.polqual, p.polrelid) AS using,
                   pg_get_expr(p.polwithcheck, p.polrelid) AS check
              FROM pg_policy p WHERE p.polrelid = {oid} ORDER BY p.polname""")
        t["acl"] = read_acl(c, db, f"SELECT relacl AS acl, relowner AS owner FROM pg_class WHERE oid = {oid}")
    return tables


def read_acl(c, db, source_sql):
    return c.json(db, f"""
        SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee,
               a.privilege_type AS priv, a.is_grantable AS grantable
          FROM ({source_sql}) s, aclexplode(s.acl) a
         WHERE a.grantee <> s.owner""")


def read_functions(c, db, patterns):
    fns = c.json(db, f"""
        SELECT p.oid, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args,
               pg_get_functiondef(p.oid) AS def, l.lanname AS lang,
               obj_description(p.oid, 'pg_proc') AS comment
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_language l ON l.oid = p.prolang
         WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p') AND {like_any('p.proname', patterns)}
         ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)""")
    for f in fns:
        f["acl"] = read_acl(c, db, f"SELECT proacl AS acl, proowner AS owner FROM pg_proc WHERE oid = {f['oid']}")
    return fns


# ── Emitters ─────────────────────────────────────────────────────────────────

def grant_lines(kind, target, acl, default_privs, default_grantees):
    """GRANT/REVOKE statements turning Supabase's defaults into `acl`.
    Grantees whose privilege delta is identical are merged into one line."""
    actual = {}
    for a in acl:
        actual.setdefault(a["grantee"], set()).add(a["priv"])
    expected = {g: set(default_privs) for g in default_grantees}
    revokes, grants = {}, {}
    for g in sorted(set(actual) | set(expected)):
        have, want = actual.get(g, set()), expected.get(g, set())
        if want - have:
            revokes.setdefault(frozenset(want - have), []).append(g)
        if have - want:
            grants.setdefault(frozenset(have - want), []).append(g)

    def privs(p):
        return "ALL" if set(p) == set(default_privs) and len(default_privs) > 1 else \
            ", ".join(sorted(p, key=lambda x: (default_privs + [x]).index(x)))

    lines = []
    for p, gs in sorted(revokes.items(), key=lambda kv: kv[1]):
        lines.append(f"REVOKE {privs(p)} ON {kind}{target} FROM {', '.join(gs)};")
    for p, gs in sorted(grants.items(), key=lambda kv: kv[1]):
        lines.append(f"GRANT {privs(p)} ON {kind}{target} TO {', '.join(gs)};")
    return lines


def order_tables(tables):
    """Topological by FK so every reference points at a table already made.
    A cycle is broken by deferring the offending FKs to ALTER TABLE."""
    names = {t["name"] for t in tables}
    by_name = {t["name"]: t for t in tables}
    deps = {t["name"]: {k["ref"].replace("public.", "") for k in t["constraints"]
                        if k["type"] == "f"} & names - {t["name"]} for t in tables}
    ordered, done, deferred = [], set(), []
    while len(ordered) < len(tables):
        ready = sorted(n for n in names - done if deps[n] <= done)
        if not ready:
            n = sorted(names - done)[0]
            for k in by_name[n]["constraints"]:
                if k["type"] == "f" and k["ref"].replace("public.", "") not in done | {n}:
                    deferred.append((n, k))
            ready = [n]
        n = ready[0]
        ordered.append(by_name[n])
        done.add(n)
    return ordered, deferred


def order_functions(fns):
    """Callees before callers. Only LANGUAGE sql bodies are checked at CREATE
    time, but ordering every function this way keeps the file readable."""
    names = sorted({f["name"] for f in fns}, key=len, reverse=True)
    calls = {}
    for f in fns:
        body = f["def"].split("AS $", 1)[-1]
        calls[f["oid"]] = {n for n in names if n != f["name"] and re.search(rf"\b{n}\s*\(", body)}
    ordered, done = [], set()
    remaining = list(fns)
    while remaining:
        ready = [f for f in remaining if calls[f["oid"]] <= done] or remaining[:1]
        f = ready[0]
        ordered.append(f)
        remaining.remove(f)
        if not any(g["name"] == f["name"] for g in remaining):
            done.add(f["name"])
    return ordered


def table_block(t, deferred_names):
    out = [f"-- ── {t['name']} " + "─" * max(3, 73 - len(t["name"]))]
    cols = []
    for col in t["columns"]:
        line = f"  {col['name']} {col['type']}"
        if col["identity"] == "a":
            line += " GENERATED ALWAYS AS IDENTITY"
        elif col["identity"] == "d":
            line += " GENERATED BY DEFAULT AS IDENTITY"
        elif col["generated"] == "s":
            line += f" GENERATED ALWAYS AS ({col['def']}) STORED"
        elif col["def"] is not None:
            line += f" DEFAULT {col['def']}"
        if col["notnull"]:
            line += " NOT NULL"
        cols.append(line)
    width = max(len(c["name"]) for c in t["columns"])
    cols = [re.sub(r"^  (\S+) ", lambda m: "  " + m.group(1).ljust(width) + " ", c) for c in cols]
    for k in t["constraints"]:
        if (t["name"], k["name"]) in deferred_names:
            continue
        cols.append(f"  CONSTRAINT {k['name']} {k['def']}")
    out.append(f"CREATE TABLE IF NOT EXISTS public.{t['name']} (")
    out.append(",\n".join(cols))
    out.append(");")
    for i in t["indexes"]:
        out.append(re.sub(r"^CREATE (UNIQUE )?INDEX ", r"CREATE \1INDEX IF NOT EXISTS ", i["def"]) + ";")
    if t["rls"]:
        out.append(f"ALTER TABLE public.{t['name']} ENABLE ROW LEVEL SECURITY;")
    if t["force_rls"]:
        out.append(f"ALTER TABLE public.{t['name']} FORCE ROW LEVEL SECURITY;")
    out += grant_lines("", f"public.{t['name']}", t["acl"], TABLE_PRIVS, DEFAULT_ROLES)
    if t["comment"]:
        out.append(f"COMMENT ON TABLE public.{t['name']} IS {sql_lit(t['comment'])};")
    for col in t["columns"]:
        if col["comment"]:
            out.append(f"COMMENT ON COLUMN public.{t['name']}.{col['name']} IS {sql_lit(col['comment'])};")
    for i in t["indexes"]:
        if i["comment"]:
            out.append(f"COMMENT ON INDEX {i['name']} IS {sql_lit(i['comment'])};")
    for k in t["constraints"]:
        if k["comment"]:
            out.append(f"COMMENT ON CONSTRAINT {k['name']} ON public.{t['name']} IS {sql_lit(k['comment'])};")
    return "\n".join(out)


def policy_sql(table, p):
    cmd = {"r": "SELECT", "a": "INSERT", "w": "UPDATE", "d": "DELETE", "*": "ALL"}[p["cmd"]]
    lines = [f"DROP POLICY IF EXISTS {quote_ident(p['name'])} ON public.{table};",
             f"CREATE POLICY {quote_ident(p['name'])} ON public.{table}"]
    if not p["permissive"]:
        lines.append("  AS RESTRICTIVE")
    lines.append(f"  FOR {cmd} TO {', '.join(p['roles'])}")
    if p["using"]:
        lines.append(f"  USING ({p['using']})")
    if p["check"]:
        lines.append(f"  WITH CHECK ({p['check']})")
    lines[-1] += ";"
    return "\n".join(lines)


def quote_ident(s):
    return s if re.fullmatch(r"[a-z_][a-z0-9_]*", s) else '"' + s.replace('"', '""') + '"'


def wrap_list(prefix, items, width=79):
    lines, cur = [], prefix
    for i, item in enumerate(items):
        piece = item + (", " if i < len(items) - 1 else "")
        if len(cur) + len(piece.rstrip()) > width and cur.strip() != prefix.strip():
            lines.append(cur.rstrip())
            cur = "--   "
        cur += piece
    lines.append(cur.rstrip())
    return "\n".join(lines)


def prose(text):
    return textwrap.fill(text, 79, initial_indent="-- ", subsequent_indent="-- ").split("\n")


def section(title):
    return f"\n\n{RULE}\n-- {title}\n{RULE}\n"


def check_supported(c, db, args):
    """Refuse object kinds the emitters below do not write, rather than
    produce a baseline that silently lacks them."""
    found = c.json(db, f"""
        SELECT 'view or materialized view ' || c.relname AS what
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm') AND {like_any('c.relname', args.tables)}
        UNION ALL
        SELECT 'trigger ' || t.tgname || ' on ' || c.relname
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal AND n.nspname = 'public' AND {like_any('c.relname', args.tables)}
        UNION ALL
        SELECT 'type ' || t.typname
          FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd')
            OR (t.typtype = 'c' AND n.nspname = 'public'
                AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
        UNION ALL
        SELECT 'serial default on ' || c.relname || '.' || a.attname
          FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
          JOIN pg_class c ON c.oid = d.adrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND {like_any('c.relname', args.tables)}
           AND pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%'""")
    if found:
        sys.exit("squash.py cannot emit these yet; extend it before squashing:\n  " +
                 "\n  ".join(f["what"] for f in found))


def function_block(f):
    b = [f"-- {f['name']}({f['args']})", f["def"].rstrip() + ";"]
    target = f"public.{f['name']}({f['args']})"
    b += grant_lines("FUNCTION ", target, f["acl"], ["EXECUTE"], ["PUBLIC"] + DEFAULT_ROLES)
    if f["comment"]:
        b.append(f"COMMENT ON FUNCTION {target} IS {sql_lit(f['comment'])};")
    return "\n".join(b)


def callees(fns):
    names = sorted({f["name"] for f in fns}, key=len, reverse=True)
    return {f["name"]: {n for n in names if n != f["name"]
                        and re.search(rf"\b{n}\s*\(", f["def"].split("AS $", 1)[-1])} for f in fns}


def plan_files(args, fns, policies):
    """Assign every function to a file. Functions a policy expression calls,
    and whatever they call, go in the tables file so RLS sits beside its
    tables; the rest go to the first --function-group whose regex matches,
    with a '.*' catch-all tried last wherever it sits in file order."""
    calls = callees(fns)
    helpers = {n for _, p in policies for n in calls
               if re.search(rf"\b{n}\s*\(", (p["using"] or "") + (p["check"] or ""))}
    frontier = list(helpers)
    while frontier:
        for n in calls.get(frontier.pop(), ()):
            if n not in helpers:
                helpers.add(n)
                frontier.append(n)
    groups = args.function_group or [["functions", ".*", "Every function."]]
    assigned, unmatched = {g[0]: [] for g in groups}, []
    tables_fns = []
    for f in order_functions(fns):
        if f["name"] in helpers:
            tables_fns.append(f)
            continue
        g = next((g[0] for g in sorted(groups, key=lambda g: g[1] == ".*") if re.search(g[1], f["name"])), None)
        (assigned[g] if g else unmatched).append(f)
    if unmatched:
        sys.exit("functions no --function-group matches (add one, or end with a catch-all '.*'):\n  " +
                 "\n  ".join(sorted({f["name"] for f in unmatched})))
    return tables_fns, [(g[0], g[2], assigned[g[0]]) for g in groups]


def sources(args, files):
    """'the 58 migrations in archive/2026-09-28/ and 059_x.sql' — the first
    --migrations directory is named by --archive, the place it is moved to."""
    parts = []
    for i, src in enumerate(args.migrations):
        if os.path.isdir(src):
            n = sum(1 for f in files if os.path.dirname(f) == os.path.normpath(src)) + \
                (len(args.skip) if i == 0 else 0)
            parts.append(f"the {n} migrations in {args.archive if i == 0 else src}/")
        else:
            parts.append(os.path.basename(src))
    return " and ".join(parts)


def header(args, files, title, names, index, lines):
    today = datetime.date.today().isoformat()
    order = [f"{n}{' (this file)' if i == index else ''}" for i, n in enumerate(names)]
    head = [RULE, f"-- {args.app} — {title}", "--",
            wrap_list("-- Run on an empty database in this order: ", order),
            "-- then every later NNN_*.sql in this directory, in number order.", "--",
            *prose(f"Generated on {today} by .claude/skills/squash-migrations/squash.py from "
                   f"{sources(args, files)}: they were replayed into an empty database and these "
                   "files were read back out of its catalog. A database built from them diffs clean "
                   "against that replay."),
            "--",
            "-- FRESH-DB ONLY. Production reaches this state through the migrations it was",
            "-- generated from. Never run these files there."]
    if args.prereq:
        # Last two path components (`_shared/004_api_logs.sql`): the files are
        # read from wherever this one is installed, not from where it was built.
        short = ["/".join(os.path.normpath(p).split(os.sep)[-2:]) for p in args.prereq]
        head += ["--"] + prose("Needs these first, for the cross-app tables it reads: " + ", ".join(short) + ".")
    if lines:
        head += ["--"] + lines
    return "\n".join(head + [RULE])


GRANTS_NOTE = ["-- Grants are the difference from Supabase's defaults, which give anon,",
               "-- authenticated and service_role everything on a new table or function (and",
               "-- EXECUTE to PUBLIC). An object with no GRANT/REVOKE lines keeps them."]


def build_files(c, db, args, files):
    """[(filename, text)] for the tables file, one file per function group,
    then the seed."""
    check_supported(c, db, args)
    tables = read_tables(c, db, args.tables)
    fns = read_functions(c, db, args.functions)
    ordered, deferred = order_tables(tables)
    deferred_names = {(n, k["name"]) for n, k in deferred}
    policies = [(t["name"], p) for t in ordered for p in t["policies"]]
    tables_fns, groups = plan_files(args, fns, policies)
    groups = [g for g in groups if g[2]]
    names = (["001_baseline_tables.sql"] +
             [f"{i + 2:03d}_baseline_functions_{g[0]}.sql" for i, g in enumerate(groups)] +
             [f"{len(groups) + 2:03d}_seed.sql"])

    roles = c.json(db, f"""
        SELECT rolname AS name, rolcanlogin AS login, rolinherit AS inherit FROM pg_roles
         WHERE rolname NOT LIKE 'pg\\_%' AND rolname NOT IN ({', '.join(sql_lit(r) for r in STUB_ROLES)})
         ORDER BY rolname""")
    schema_acl = read_acl(c, db, "SELECT nspacl AS acl, nspowner AS owner FROM pg_namespace WHERE nspname = 'public'")
    exts = c.json(db, """
        SELECT e.extname AS name, n.nspname AS schema FROM pg_extension e
          JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname <> 'plpgsql' ORDER BY 1""")
    pubs = c.json(db, f"""
        SELECT pubname, tablename FROM pg_publication_tables
         WHERE schemaname = 'public' AND {like_any('tablename', args.tables)} ORDER BY 1, 2""")

    about = [f"-- {len(tables)} tables in foreign-key order, each with its indexes, RLS switch,",
             "-- grants and comments."]
    if policies:
        about += prose(f"Then the {len(policies)} RLS policies, preceded by the "
                       f"function{'s' if len(tables_fns) != 1 else ''} they call.")
    out = [header(args, files, "baseline: tables", names, 0, about + ["--"] + GRANTS_NOTE)]
    pre = []
    for r in roles:
        attrs = ("LOGIN PASSWORD " + sql_lit(args.role_password) if r["login"] else "NOLOGIN") + \
                ("" if r["inherit"] else " NOINHERIT")
        pre.append("DO $$\nBEGIN\n"
                   f"  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {sql_lit(r['name'])}) THEN\n"
                   f"    CREATE ROLE {r['name']} {attrs};\n  END IF;\nEND $$;")
    for a in schema_acl:
        if a["grantee"] in {r["name"] for r in roles}:
            pre.append(f"GRANT {a['priv']} ON SCHEMA public TO {a['grantee']};")
    for e in exts:
        pre.append(f"CREATE SCHEMA IF NOT EXISTS {e['schema']};")
        pre.append(f"CREATE EXTENSION IF NOT EXISTS {e['name']} WITH SCHEMA {e['schema']};")
    if pre:
        out.append(section("Roles and extensions") + "\n".join(pre))
        if roles and args.role_password == "change-me":
            out.append("-- LOGIN roles get a placeholder password; set a real one out of band.")
    out.append(section(f"Tables ({len(tables)})"))
    out.append("\n\n".join(table_block(t, deferred_names) for t in ordered))
    if deferred:
        out.append("\n\n-- Foreign keys that close a cycle, added once both ends exist.")
        for n, k in deferred:
            out.append(f"ALTER TABLE public.{n} ADD CONSTRAINT {k['name']} {k['def']};")
    if tables_fns:
        out.append(section("Functions the policies call") + "\n\n".join(function_block(f) for f in tables_fns))
    if policies:
        out.append(section(f"Row-level security policies ({len(policies)})") +
                   "\n\n".join(policy_sql(t, p) for t, p in policies))
    if pubs:
        body = []
        for p in pubs:
            body.append(f"  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = {sql_lit(p['pubname'])})\n"
                        f"     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables\n"
                        f"                      WHERE pubname = {sql_lit(p['pubname'])} AND schemaname = 'public'\n"
                        f"                        AND tablename = {sql_lit(p['tablename'])}) THEN\n"
                        f"    ALTER PUBLICATION {p['pubname']} ADD TABLE public.{p['tablename']};\n"
                        f"  END IF;")
        out.append(section("Realtime publication") +
                   "-- Guarded: a plain Postgres database has no supabase_realtime publication.\n"
                   "DO $$\nBEGIN\n" + "\n".join(body) + "\nEND $$;")
    result = [(names[0], "\n".join(out) + "\n")]

    for i, (name, desc, group) in enumerate(groups, start=1):
        about = prose(f"{desc} {len(group)} functions, callees first, so the file runs top to "
                      "bottom. Bodies are pg_get_functiondef() output: the server's normalized rendering.")
        text = (header(args, files, f"baseline: {name} functions", names, i, about + ["--"] + GRANTS_NOTE) +
                "\n\n\n" + "\n\n".join(function_block(f) for f in group) + "\n")
        result.append((names[i], text))

    result.append((names[-1], build_seed(c, db, args, tables, files, names)))
    return result, [t["name"] for t in tables]


def build_seed(c, db, args, tables, files, names):
    ordered, _ = order_tables(tables)
    blocks, counts = [], []
    for t in ordered:
        n = int(c.query(db, f"SELECT count(*) FROM public.{t['name']}"))
        if n:
            blocks.append(insert_block(c, db, f"public.{t['name']}", "true"))
            counts.append(f"{t['name']} ({n})")
    for spec in args.extra_seed:
        rel, _, where = spec.partition(":")
        blocks.append(insert_block(c, db, rel, where or "true"))
        counts.append(rel.split("(")[0])
    about = ["-- Every row the migrations leave in an otherwise empty database. A one-time",
             "-- backfill touches nothing there, so what remains is the reference data the",
             "-- app needs to work at all. ON CONFLICT DO NOTHING, so a second run is a no-op.",
             "--", wrap_list("-- Tables: ", counts)]
    return (header(args, files, "seed: reference rows", names, len(names) - 1, about) +
            "\n\n\n" + "\n\n\n".join(blocks) + "\n")


VOLATILE_DEFAULT = r"now\(\)|CURRENT_(TIMESTAMP|DATE|TIME)|clock_timestamp|gen_random_uuid|uuid_generate|random\("


def seeded_columns(c, db, rel):
    """Columns a seed INSERT names. A column whose default is volatile
    (created_at DEFAULT now()) is left to that default: the replay's value is
    the moment the replay ran, which means nothing on another database."""
    rel, _, only = rel.partition("(")
    only = [x.strip() for x in only.rstrip(")").split(",") if x.strip()]
    cols = c.json(db, f"""
        SELECT a.attname AS name, a.attidentity AS identity, t.typcategory IN ('N', 'B') AS bare,
               pg_get_expr(d.adbin, d.adrelid) AS def
          FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = {sql_lit(rel)}::regclass AND a.attnum > 0
           AND NOT a.attisdropped AND a.attgenerated = '' ORDER BY a.attnum""")
    if only:
        return rel, [col for col in cols if col["name"] in only]
    return rel, [col for col in cols if not (col["def"] and re.search(VOLATILE_DEFAULT, col["def"], re.I))]


def insert_block(c, db, rel, where):
    rel, cols = seeded_columns(c, db, rel)
    pk = c.query(db, f"""
        SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY array_position(i.indkey, a.attnum))
          FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = {sql_lit(rel)}::regclass AND i.indisprimary""") or "1"
    exprs = ", ".join(f"coalesce({quote_ident(col['name'])}::text, 'NULL')" if col["bare"] else
                      f"quote_nullable({quote_ident(col['name'])}::text)" for col in cols)
    rows = json.loads(c.query(db, f"SELECT coalesce(json_agg(json_build_array({exprs}) ORDER BY {pk}), '[]') "
                                  f"FROM {rel} WHERE {where}"))
    widths = [max(len(r[i]) for r in rows) for i in range(len(cols))]
    out = [f"-- ── {rel} " + "─" * max(3, 73 - len(rel))]
    overriding = " OVERRIDING SYSTEM VALUE" if any(col["identity"] == "a" for col in cols) else ""
    out.append(f"INSERT INTO {rel} ({', '.join(quote_ident(col['name']) for col in cols)}){overriding} VALUES")
    lines = []
    for r in rows:
        cells = [v + "," if i < len(r) - 1 else v for i, v in enumerate(r)]
        padded = " ".join(cell.ljust(widths[i] + 1) if i < len(r) - 1 else cell for i, cell in enumerate(cells))
        lines.append(f"  ({padded})")
    out.append(",\n".join(lines))
    out.append("ON CONFLICT DO NOTHING;")
    for col in cols:
        if col["identity"]:
            out.append(f"SELECT setval(pg_get_serial_sequence({sql_lit(rel)}, {sql_lit(col['name'])}),"
                       f" (SELECT max({quote_ident(col['name'])}) FROM {rel}));")
    return "\n".join(out)


# ── Verification ─────────────────────────────────────────────────────────────

def normalized_dump(c, db, tables, extra_seed):
    schema = c.dump(db, "--schema-only", "--schema=public", "--no-owner")
    data = []
    for rel in [f"public.{t}" for t in tables] + [spec.partition(":")[0] for spec in extra_seed]:
        where = dict(spec.partition(":")[::2] for spec in extra_seed).get(rel) or "true"
        name, cols = seeded_columns(c, db, rel)
        cols_sql = ", ".join(quote_ident(col["name"]) for col in cols)
        data.append(f"{name}: " + c.query(db, f"SELECT coalesce(json_agg(r ORDER BY r::text), '[]') "
                                              f"FROM (SELECT {cols_sql} FROM {name} WHERE {where}) r"))
    catalog = c.query(db, """
        SELECT string_agg(x, E'\\n' ORDER BY x) FROM (
          SELECT 'extension ' || extname || ' ' || extnamespace::regnamespace AS x FROM pg_extension
          UNION ALL
          SELECT 'publication ' || pubname || ' ' || schemaname || '.' || tablename FROM pg_publication_tables
        ) q
    """)
    strip = lambda s: [l for l in s.splitlines() if l and not l.startswith("--") and "pg_catalog.set_config" not in l
                       and not l.startswith("\\restrict") and not l.startswith("\\unrestrict")]
    return strip(schema) + ["== data =="] + data + ["== catalog =="] + catalog.splitlines()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--migrations", action="append", required=True,
                    help="directory of NNN_*.sql replayed in name order, or a single file; repeat to "
                         "replay several in the order given")
    ap.add_argument("--prereq", action="append", default=[],
                    help="file to run before the migrations (cross-app tables they read); not squashed")
    ap.add_argument("--skip", action="append", default=[],
                    help="basename to leave out of the replay: a data-only migration that needs live data")
    ap.add_argument("--tables", action="append", required=True, help="LIKE pattern for the app's tables")
    ap.add_argument("--functions", action="append", default=[], help="LIKE pattern for the app's functions")
    ap.add_argument("--extra-seed", action="append", default=[],
                    help="'schema.table(col, ...):WHERE clause' rows outside public to carry into "
                         "the seed; the column list keeps stub-only columns out")
    ap.add_argument("--app", required=True, help="name used in the file headers")
    ap.add_argument("--archive", required=True,
                    help="where the first --migrations directory is archived to, as the headers cite it")
    ap.add_argument("--role-password", default="change-me", help="placeholder password for LOGIN roles")
    ap.add_argument("--function-group", nargs=3, action="append", default=[],
                    metavar=("NAME", "REGEX", "DESCRIPTION"),
                    help="functions whose name matches REGEX go to NNN_baseline_functions_<NAME>.sql; "
                         "files follow the order given. The first matching REGEX wins, except that a "
                         "'.*' group is tried last. Every function must match one. Omitted: one file")
    ap.add_argument("--out", required=True, help="output directory for the generated files")
    ap.add_argument("--port", type=int, default=54329)
    ap.add_argument("--verify", action="store_true", help="rebuild from the output and diff against the replay")
    args = ap.parse_args()
    if not args.functions:
        args.functions = ["\x00"]

    files = []
    for src in args.migrations:
        found = sorted(glob.glob(os.path.join(src, "[0-9][0-9][0-9]_*.sql"))) if os.path.isdir(src) else [src]
        files += [os.path.normpath(f) for f in found if os.path.basename(f) not in args.skip]
    if not files:
        sys.exit(f"no NNN_*.sql files in {args.migrations}")
    os.makedirs(args.out, exist_ok=True)

    c = Cluster(args.port)
    c.start()
    try:
        for db in ("replay", "squashed"):
            c.query("postgres", f"CREATE DATABASE {db}")
            c.psql_file(db, STUBS)
            for p in args.prereq:
                c.psql_file(db, p)
        for f in files:
            c.psql_file("replay", f)
        print(f"replayed {len(files)} migrations", file=sys.stderr)

        outputs, table_names = build_files(c, "replay", args, files)
        paths = []
        for name, text in outputs:
            path = os.path.join(args.out, name)
            paths.append(path)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
            print(f"wrote {path} ({text.count(chr(10))} lines)", file=sys.stderr)

        if args.verify:
            for p in paths:
                c.psql_file("squashed", p)
            # Running every file twice proves they are safe to re-run.
            for p in paths:
                c.psql_file("squashed", p)
            a = normalized_dump(c, "replay", table_names, args.extra_seed)
            b = normalized_dump(c, "squashed", table_names, args.extra_seed)
            diff = list(difflib.unified_diff(a, b, "replay", "squashed", lineterm=""))
            if diff:
                print("\n".join(diff[:400]))
                print(f"VERIFY FAILED: {len(diff)} diff lines", file=sys.stderr)
                return 1
            print(f"verified: squashed database matches the replay ({len(a)} dump lines compared)",
                  file=sys.stderr)
        return 0
    finally:
        c.stop()


if __name__ == "__main__":
    sys.exit(main())
