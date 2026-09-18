// widgets/usage-panels.js — the Usage spoke's panels.
//
// APPEARANCE ONLY. Every function here is pure: payload in, HTML string out,
// no state, no fetching, no DOM. The lifecycle — the two requests, the caches,
// the window state, the hosts it repaints — is views/admin-usage-view.js, and
// the split is the file-size one CLAUDE.md asks for, along the same seam as
// admin-backfill-view / admin-backfill-panel.
//
// SURFACE: these render inside `bgb-spoke-screen`, which is a RE-POINTED CHROME
// surface, so the `.usage-*` CSS family reads `--polaroid-*` / `--accent-ink` /
// `--accent-fill` / `--well` and never a ground token. A bar reaching for
// `oklch(var(--b1))` here is a black box in light and invisible in dark
// (`.claude/rules/theming.md` §6).

(function () {
  // Enough rows to see the shape, few enough to read on a phone. The rest are
  // a long tail of screens nobody opens, which is itself the finding.
  const TOP_SCREENS = 12;
  const TOP_TABLES = 10;

  const BUCKET_LABELS = { plays: "Play photos", games: "Cover art" };

  /** A count, grouped, and never the word "undefined" on a slow first paint. */
  function n(v) {
    const num = Number(v);
    return isFinite(num) ? num.toLocaleString() : "—";
  }

  function tile(label, value, icon, foot) {
    return `
      <div class="usage-tile">
        <span class="usage-tile__k"><i data-icon="${icon}" class="w-3.5 h-3.5"></i>${escapeHtml(label)}</span>
        <span class="usage-tile__v">${n(value)}</span>
        <span class="usage-tile__d">${escapeHtml(foot || "")}</span>
      </div>
    `;
  }

  function row(label, value, opts) {
    const o = opts || {};
    return `
      <div class="usage-row">
        <span class="usage-row__k">${escapeHtml(label)}${o.sub ? `<em>${escapeHtml(o.sub)}</em>` : ""}</span>
        <span class="usage-row__v${o.quiet ? " usage-row__v--quiet" : ""}"
              ${o.title ? `title="${escapeAttr(o.title)}"` : ""}>${escapeHtml(String(value))}</span>
      </div>
    `;
  }

  // A route name read as a screen name. The payload already stripped `view:`.
  function screenLabel(screen) {
    return String(screen || "").replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  }

  // The app's own tables all share the same nineteen-character prefix, which
  // on a 480px column is most of the label. The two shared tables keep their
  // real names — they are not this app's, and reading them as such would be
  // wrong.
  function tableLabel(name) {
    const s = String(name || "");
    return s.startsWith("boardgamebuddy_")
      ? s.slice("boardgamebuddy_".length).replace(/_/g, " ")
      : s;
  }

  const UsagePanels = {
    WINDOWS: [
      { key: "last_24h", label: "24h", phrase: "in the last 24 hours" },
      { key: "last_7d", label: "7d", phrase: "in the last 7 days" },
      { key: "last_30d", label: "30d", phrase: "in the last 30 days" },
      { key: "all_time", label: "All", phrase: "since launch" },
    ],

    phraseFor(key) {
      const w = UsagePanels.WINDOWS.find((x) => x.key === key);
      return w ? w.phrase : "";
    },

    windowSeg(current, handler) {
      return `
        <div class="theme-seg usage-seg" role="group" aria-label="Time window">
          ${UsagePanels.WINDOWS.map((w) => `
            <button class="theme-seg__opt${w.key === current ? " is-on" : ""}"
                    aria-pressed="${w.key === current ? "true" : "false"}"
                    onclick="${escapeAttr(handler + "('" + w.key + "')")}">${w.label}</button>
          `).join("")}
        </div>
      `;
    },

    // ── People ───────────────────────────────────────────────────────────────

    people(data) {
      const u = data.users || {};
      const a = data.active || {};
      return `
        <div class="set-card-label">People</div>
        <div class="set-card usage-card">
          <div class="usage-tiles">
            ${tile("Accounts", u.total, "users",
              u.new_7d ? `+${n(u.new_7d)} this week` : "no new accounts this week")}
            ${tile("Active today", a.dau, "flame", "opened the app")}
            ${tile("Active this week", a.wau, "history", "distinct accounts")}
            ${tile("Active this month", a.mau, "clock", "distinct accounts")}
          </div>
          ${UsagePanels.dailyStrip(a.daily)}
          <div class="usage-facts">
            <span><b>${n(u.admins)}</b> admin${u.admins === 1 ? "" : "s"}</span>
            <span><b>${n(u.bgg_linked)}</b> linked to BoardGameGeek</span>
            <span><b>${n(u.push_enabled)}</b> with notifications on</span>
          </div>
        </div>
      `;
    },

    dailyStrip(days) {
      if (!days || !days.length) return "";
      const peak = Math.max(1, ...days.map((d) => d.users || 0));
      // A column per day rather than a line: thirty discrete daily counts are
      // thirty bars, and a line between them would draw a reading in between
      // that does not exist. Heights are a share of the peak, so the strip is
      // legible whether the peak is 4 accounts or 400 — the peak is named in
      // the axis rather than implied by the height.
      return `
        <div class="usage-strip" role="img"
             aria-label="Active accounts per day over the last 30 days. Peak ${peak}.">
          ${days.map((d) => {
            const v = d.users || 0;
            const h = v > 0 ? Math.max(6, Math.round((v / peak) * 100)) : 2;
            return `<i style="height:${h}%"${v > 0 ? "" : ' class="is-zero"'}
                       title="${escapeAttr(String(d.day))}: ${v}"></i>`;
          }).join("")}
        </div>
        <div class="usage-strip__axis">
          <span>30 days ago</span><span>peak ${peak}</span><span>today</span>
        </div>
      `;
    },

    // ── Features ─────────────────────────────────────────────────────────────

    features(data, w) {
      const phrase = UsagePanels.phraseFor(w);
      const screens = (data.screens || [])
        .slice()
        .sort((a, b) => (b[w] || 0) - (a[w] || 0))
        .filter((s) => (s[w] || 0) > 0)
        .slice(0, TOP_SCREENS);
      const domain = data.domain || [];
      const origins = (data.play_origins || [])
        .slice()
        .sort((a, b) => (b[w] || 0) - (a[w] || 0))
        .filter((o) => (o[w] || 0) > 0);

      return `
        <div class="set-card-label">Features</div>
        <div class="set-card usage-card">
          <h4 class="usage-h">Screens opened <em>${escapeHtml(phrase)}</em></h4>
          ${screens.length ? `
            <div class="stats-bars">
              ${screens.map((s) => window.BgbStat.bar(
                screenLabel(s.screen), s[w] || 0, screens[0][w] || 0, { wide: true },
              )).join("")}
            </div>
          ` : `<p class="usage-quiet">No screen views recorded ${escapeHtml(phrase)}.</p>`}

          <h4 class="usage-h usage-h--sep">What people make <em>${escapeHtml(phrase)}</em></h4>
          <div class="usage-rows">
            ${domain.map((d) => row(d.feature, n(d[w]))).join("")}
          </div>

          <h4 class="usage-h usage-h--sep">Where plays come from</h4>
          ${origins.length ? `
            <div class="stats-bars">
              ${origins.map((o) => window.BgbStat.bar(
                o.origin, o[w] || 0, origins[0][w] || 0, { wide: true },
              )).join("")}
            </div>
          ` : `<p class="usage-quiet">No plays logged ${escapeHtml(phrase)}.</p>`}
        </div>
      `;
    },

    // ── Storage ──────────────────────────────────────────────────────────────

    storage(data, bucketsHostId, bucketsHtml) {
      const db = data.database || {};
      const tables = (db.tables || []).slice(0, TOP_TABLES);
      const peak = tables.length ? (tables[0].total_bytes || 0) : 0;
      return `
        <div class="set-card-label">Storage</div>
        <div class="set-card usage-card">
          <h4 class="usage-h">
            Database
            <em>${escapeHtml(formatBytes(db.total_bytes))} across
            ${n((db.tables || []).length)} tables</em>
          </h4>
          <div class="stats-bars">
            ${tables.map((t) => window.BgbStat.bar(
              tableLabel(t.table_name), t.total_bytes || 0, peak,
              {
                wide: true,
                display: formatBytes(t.total_bytes),
                // "≈" because reltuples is a planner estimate refreshed by
                // ANALYZE, not a count. The counted figures are in "What
                // people make" above.
                sub: `≈ ${n(t.row_estimate)} rows`,
              },
            )).join("")}
          </div>

          <h4 class="usage-h usage-h--sep">Image buckets</h4>
          <div id="${bucketsHostId}">${bucketsHtml}</div>
        </div>
      `;
    },

    /**
     * The bucket rows, in one of five states: errored, not read yet, loading,
     * unconfigured, and read. Unconfigured is a supported state rather than a
     * failure — local dev has no R2 credentials and needs none — and an error
     * is scoped to ITS OWN row, because the two buckets have separate
     * permissions and one refusing must not hide the other's number.
     */
    bucketRows({ buckets, loading, error, refreshHandler }) {
      if (error) {
        return `
          <p class="usage-quiet">${escapeHtml(error)}
            <button class="btn btn-ghost btn-xs" onclick="${escapeAttr(refreshHandler)}">Try again</button>
          </p>
        `;
      }
      if (!buckets) {
        return loading
          ? window.buddyLoader({ size: 48, padded: false })
          : `<p class="usage-quiet">Bucket sizes not read yet.</p>`;
      }
      const rows = Object.keys(buckets).map((kind) => {
        const b = buckets[kind] || {};
        const label = BUCKET_LABELS[kind] || kind;
        if (!b.configured) return row(label, "not configured", { quiet: true });
        // The usual cause is an R2 token without ListBucket, which R2 reports
        // as AccessDenied — the full string is in the title rather than the
        // row, which has one line to work with.
        if (b.error) return row(label, "couldn't read", { quiet: true, title: b.error });
        // "at least" when the walk hit its page ceiling: the figure is a floor
        // and printing it bare would be a claim the data cannot support.
        const prefix = b.truncated ? "at least " : "";
        return row(label, prefix + formatBytes(b.bytes), {
          sub: `${prefix}${n(b.objects)} object${b.objects === 1 ? "" : "s"}`,
        });
      });
      return `
        <div class="usage-rows">${rows.join("")}</div>
        ${loading
          ? `<p class="usage-quiet">Re-reading…</p>`
          : `<button class="btn btn-ghost btn-xs usage-bucket-refresh"
                     onclick="${escapeAttr(refreshHandler)}">
               <i data-icon="refresh-cw" class="w-3.5 h-3.5"></i> Re-read buckets
             </button>`}
      `;
    },

    // ── Footer ───────────────────────────────────────────────────────────────

    /** Dates the numbers, and is honest about what "active" is measured from. */
    footer(data, { refreshing, refreshHandler }) {
      const at = data.generated_at;
      const since = data.active && data.active.oldest_sample_at;
      return `
        <div class="usage-foot">
          <p>
            ${at ? `Counted ${escapeHtml(formatDate(at))}. ` : ""}Active accounts
            are those that opened the app while signed in, measured from the API
            request log${since
              ? ` — which starts ${escapeHtml(formatDate(since))}, so anything before
                  that is not missing usage, just unmeasured`
              : ""}.
          </p>
          <button class="btn btn-ghost btn-sm" ${refreshing ? "disabled" : ""}
                  onclick="${escapeAttr(refreshHandler)}">
            <i data-icon="refresh-cw" class="w-3.5 h-3.5${refreshing ? " animate-spin" : ""}"></i>
            ${refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      `;
    },
  };

  window.UsagePanels = UsagePanels;
})();
