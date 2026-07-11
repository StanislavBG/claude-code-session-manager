# History Tab — Pre-Design Feature Spec

> **Status:** Pre-design brainstorm / input to designer
> **Author:** Bilko (via Claude Code)
> **Date:** 2026-07-09 (rev. 2 — scoped to analytics only)
> **Audience:** Product designer, then /develop for PRD decomposition
> **One-liner:** History is Session Manager's **usage-analytics dashboard** — cost, tokens, and activity across every project you have ever run Claude Code in, explained and trended over time. It is a place you *understand your usage*, not a place you browse or reopen individual conversations.

---

## 0. Scope Decision (read first)

History is an **analytics surface**. Its charter is cost, tokens, activity, and trends.

**Explicitly OUT of scope (rejected direction):**
- ❌ Full-text search *inside* transcripts / searching individual sessions.
- ❌ Session preview / read-only transcript viewer.
- ❌ Resuming a session from History.
- ❌ Any "browse and reopen a past conversation" flow.

That browse/replay behavior is **not History's job**. The current tab's **Log view + resume button are out-of-charter** and should be treated as a candidate to relocate (e.g. onto a Projects/Terminal surface), not to expand. Everything below builds the analytics product and leaves session exploration out.

---

## 1. Why History Exists

Session Manager is the local cockpit for Claude Code. Every session writes a JSONL transcript to `~/.claude/projects/<encoded-cwd>/<sessionUuid>.jsonl`. History is the one surface that reads **all** of them and answers *analytical* questions:

- How many tokens / how much money did I spend, over what time, on which projects?
- Where is the cost going — which model, how much saved by caching?
- What's my trend — am I spending more this week than last? When do I actually work?

It is **retrospective and aggregate**. It should not duplicate the live **Usage** tab (current 5-hour billing window) or the **Knowledge Graph** (entity extraction). History owns the *historical analytics of the archive* — the charts and the numbers, not the conversations themselves.

---

## 2. Current Features (real inventory)

Grounded in `src/renderer/components/tabs/History.tsx`, `HistoryDashboard.tsx`, and `src/main/historyAggregator.cjs`.

### 2.1 Dashboard view — the usage analytics (the part we keep + grow)
- Aggregates transcripts over a date range via `window.api.history.aggregate({fromDate,toDate})`; default **last 30 days** (`History.tsx:57-58`, `HistoryDashboard.tsx:81`).
- **Controls**: from/to date pickers, project-name filter (`History.tsx:168-192`).
- **Stat tiles** (5): total prompts, input tokens, output tokens, sessions, **est. cost** (highlighted) (`HistoryDashboard.tsx:249-255`).
- **Daily-metric line chart** (Recharts): switchable metric — prompt count / input tok / output tok / sessions / errors / est. cost — one line per project, **capped at 10 projects** (`HistoryDashboard.tsx:180-194, 257-292`).
- **Input-vs-output stacked bar chart** (hand-rolled), per day, with per-bar tooltip (`HistoryDashboard.tsx:294-329`).
- **Per-project table**: project, days active, sessions, prompts, input tok, output tok, **top tool**, est. cost — **sortable** columns (`HistoryDashboard.tsx:331-375`).
- **Auto-refresh** every 30 s + manual `↻ refresh` + a live **freshness indicator** ("updated 12s ago") (`HistoryDashboard.tsx:58, 102-105, 400-416`).
- **Partial-scan warning** banner when the scan is truncated (`HistoryDashboard.tsx:232-236`).
- **Cost model**: flat Sonnet rate **$3 / $15 per MTok** input/output; disclosed in a footnote (`HistoryDashboard.tsx:379`).

### 2.2 Log view — the resume ledger (OUT of charter — flag to relocate)
Present today but **not** the analytics product: a full-disk transcript list (session UUID / project / size / mtime) with a **resume** button that dir-picks then runs `claude --resume` (`History.tsx:107-149, 97-105`), plus id/project filtering and pagination. Per the scope decision (§0), this browse/resume surface should move off History, not grow.

### 2.3 Data the aggregator already captures (but the UI under-uses)
From `historyAggregator.cjs:89-206`, per day+project bucket (local-TZ), with an LRU cache + append-only tail-parse for speed:
- `promptCount`, `inputTokens`, `outputTokens`
- **`cacheReadTokens`, `cacheCreationTokens`** — captured, **never shown**
- `toolBreakdown` (per-tool counts) — only the single **top tool** is surfaced
- `errorCount` — captured, only exposed as one selectable chart metric
- `sessionCount`, `estimatedCostUsd`

> **Key insight:** three valuable analytics signals — **cache tokens, full tool breakdown, error counts** — are already computed and thrown away at the UI. Several features below are really *surfacing analytics we already have*.

---

## 3. Competitive Research — Analytics Products We Learn From

History is a local, single-author **usage-analytics dashboard**. The relevant leaders:

| Category | Exemplars | Analytics capabilities relevant to us |
|---|---|---|
| **AI-usage / cost dashboards** | Anthropic Console usage, OpenAI usage dashboard, Cursor/Cline usage panes | Cost **broken down by model**, **cache-hit savings** called out, budget caps + **projected spend**, CSV/JSON export, **period-over-period deltas** |
| **Dev observability / metrics** | PostHog, Grafana, Datadog, Vercel/Linear dashboards | **Saved views** & filter presets, **trend arrows + moving averages**, **cumulative** lines, drill-down chart→row, threshold/budget warnings, share/export a report |
| **Activity visualization** | GitHub contribution graph, WakaTime, RescueTime | **Activity heatmaps** (calendar of intensity per day), time-of-day patterns, streaks — "when and how much do I work" |

**Cross-cutting themes we adopt:**
- **Explain the number.** Cost decomposed by **model** and **cache**, with savings shown — not one flat rate.
- **Compare over time.** This-period-vs-last, trend arrows, cumulative + projected lines.
- **Visualize rhythm.** A calendar heatmap of activity, not just line charts.
- **Curate the view.** Saved filter/metric/range presets; export the report.

**Deliberately NOT adopted** (the rejected "conversation manager" camp): full-text conversation search, transcript preview, pinning/reopening individual chats. Those belong to a browse surface, not this analytics dashboard (§0).

---

## 4. Our Version — Analytics Feature Set

Tiered MVP → aspirational so /develop can slice PRDs. Everything here is charts / metrics / cost.

### Tier 0 — Surface the analytics we already compute (table stakes)
- **Cache tokens** shown everywhere tokens are — stat tile + per-project table + charts (data already summed in `historyAggregator.cjs:115-116`).
- **Full tool breakdown**, not just "top tool" — a per-project tool-usage bar/heat cell from the captured `toolBreakdown`.
- **Error count** as a first-class column + an error-rate metric (errors / sessions), from the captured `errorCount`.
- **Disk-usage rollup** — "N sessions · X GB on disk" and the heaviest projects (the per-file `size` already exists).

### Tier 1 — Explain the cost ⭐ (signature)
The reason to trust the dashboard.
- **Cost by model.** Capture the `model` field per assistant message; break spend down per model (sonnet / opus / haiku) instead of the flat `$3/$15` constant.
- **Cache-savings line.** Use `cacheReadTokens`/`cacheCreationTokens` to show "$X saved by prompt caching" and cache-hit %.
- **Accurate per-model pricing table** (config-driven, not a single hardcoded rate), with the "estimate, not billing" caveat kept.

### Tier 2 — Trends & comparison ⭐ (signature)
Analytics is about change over time.
- **Period-over-period deltas** — this range vs. previous equal range, with ↑/↓ trend arrows on every stat tile.
- **Cumulative cost line** + **month-end projection** against an optional budget, with a soft warning when projected spend crosses it.
- **Moving-average smoothing** toggle on the daily chart.

### Tier 3 — Activity & richer charts
- **Activity heatmap** — GitHub-style calendar of sessions / tokens / cost per day (selectable intensity metric); spot your work rhythm and streaks.
- **Cost-share breakdown** — per-project and per-model share (donut / stacked area) of total spend.
- **Charts on the shared `dataviz` palette** — replace the ad-hoc `PROJECT_COLORS` hex list and hand-rolled stacked bars with the app's chart system.

### Tier 4 — Reporting & saved views (aspirational)
- **Export** — the aggregate as CSV/JSON; a range as a shareable report.
- **Saved views** — named filter + metric + range presets (e.g. "this-week cost by model", "opus spend, all projects").
- **Budget config** — set a monthly budget; History tracks burn-down and projects against it.

---

## 5. Pixel Mock (ASCII wireframe — input to designer)

### 5.1 Dashboard — cost explained + deltas + heatmap
```
┌───────────────────────────────────────────────────────────────────────────┐
│  Every session, ever — analytics       from [2026-06-09] to [2026-07-09]   │
│  project ▾ all            metric ▾ est. cost           ↻ updated 8s ago     │
├───────────────────────────────────────────────────────────────────────────┤
│  prompts 1,204 ▲12%   in 4.1M ▲8%   out 210k ▼3%   sessions 88   $12.40 ▲5%│
├───────────────────────────────────────────────────────────────────────────┤
│  Spend by model            Cache savings         Activity (per day)        │
│  ### sonnet   $9.10         $6.20 saved           ..::##:....:####::..::.   │
│  ##   opus    $2.80         (32% of input          Mon──────────────Sun    │
│  ..   haiku   $0.50          served from cache)                            │
├───────────────────────────────────────────────────────────────────────────┤
│  daily  [ est. cost ▾ ]  ☑ 7d avg    cumulative ─╱   projected $48 / $50 ⚠ │
│    ╱╲   ╱╲                                                                  │
│  ─╱  ╲─╱  ╲──────────────────────────────────────────────────────────      │
├───────────────────────────────────────────────────────────────────────────┤
│  project        days  sessions  prompts  in tok  out tok  cache  errors  $ │
│  session-mgr      21       61     903     3.1M    150k    1.2M     4   9.10 │
│  burrow            9       18     240     0.8M     48k    0.3M     1   2.80 │
│                                              [ Export CSV ]  [ Save view ] │
└───────────────────────────────────────────────────────────────────────────┘
```

Design language: follow the **Almanac** shell used app-wide (Scheduler / Subagents cockpits); segmented controls match the Scheduler v2 treatment; charts adopt the **`dataviz`** palette rather than ad-hoc hex.

---

## 6. Technical Notes (for architecture, not the designer)

- **Cost by model:** assistant messages carry a `model` field — extend `scanAggrLines` (`historyAggregator.cjs:89`) to bucket tokens **by model**, then price per-model from a config table instead of the flat `$3/$15` constant (`HistoryDashboard.tsx:379`). Cache tokens are already summed (`:115-116`) — price them at the cache rate for the savings figure.
- **Extend the row shape, don't fork:** `DayProjectRow` (`api.d.ts:426`) is the single source — add `byModel`, `cacheReadTokens`, `cacheCreationTokens`, `errorCount` to it (some already present) rather than computing a parallel copy in the renderer (API-reuse standard).
- **Deltas/projection** are pure renderer math over two aggregate ranges — no new IPC beyond a second `aggregate()` call for the previous period.
- **Charts:** route through the shared `dataviz` palette + chart primitives; retire the hand-rolled stacked bars and `PROJECT_COLORS`.
- **Perf:** keep the LRU cache + append-only tail-parse (`:151-206`) and the 30 s auto-refresh discipline; per-model bucketing must not force a full re-scan.
- **Security:** reads honor `validatePath` (allowedRoots = home); exports write via `writeTextAtomic`; IPC validated by `ipcSchemas.cjs`. No transcript content leaves the machine — and note History no longer needs to *read message text* at all beyond token/model/tool metadata, which keeps it lean.

---

## 7. Open Questions for the Designer

1. **Cost trust** — once we break spend down by model, how prominent is the "estimate, not billing" caveat, and do we reconcile against the live Usage tab's real billing numbers?
2. **Heatmap metric** — sessions/day, tokens/day, or cost/day as the calendar's default intensity?
3. **Budget** — is budget config in scope for MVP, or does projection ship first without a target line?
4. **Log view fate** — remove the out-of-charter Log/resume surface from History entirely, or leave it untouched until a relocation home exists? (Recommend: hide it from History, relocate resume onto Projects/Terminal separately.)
5. **Chart density** — one rich scrollable dashboard, or a couple of sub-views (Cost / Activity)?

---

## 8. Suggested MVP Cut (for /develop slicing)

- **PRD 1** — Tier 0: surface cache tokens, full tool breakdown, error column + rate, and a disk-usage rollup (all data already captured).
- **PRD 2** — Tier 1: cost-by-model bucketing + config-driven per-model pricing + cache-savings figure.
- **PRD 3** — Tier 2: period-over-period deltas (trend arrows) + cumulative & projected cost vs. optional budget.
- **PRD 4** — Tier 3: activity heatmap + cost-share breakdown + migrate charts onto the `dataviz` palette.
- **PRD 5** — Tier 4 (stretch): CSV/JSON export + saved views + budget config.
- **PRD 0 (cleanup)** — relocate/remove the Log + resume surface from History per §0.

Tiers 0–2 (PRDs 1–3) are the honest MVP — **surface the data, explain the cost, show the trend**. Tiers 3–4 make it a polished analytics product.

---

## Sources

Landscape-level research (product categories, not deep-linked claims):
- Anthropic Console — usage & cost dashboard: <https://console.anthropic.com>
- OpenAI usage dashboard: <https://platform.openai.com/usage>
- PostHog (analytics, saved insights/dashboards): <https://posthog.com>
- Grafana (dashboards, drill-down, thresholds): <https://grafana.com>
- GitHub contribution graph (activity heatmap pattern): <https://github.com>
- WakaTime (coding-time analytics/heatmaps): <https://wakatime.com>
- Internal: `session-manager-operations/HUMAN_LEARN/index.html#knowledge-graph` (transcript pipeline), `docs/Browser-pre-Design.md` (companion pre-design spec / format).
