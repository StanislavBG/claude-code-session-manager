# Plan 2 — Local-Browser Vector DB Skill Research

**Goal:** Mine the user's local browser (history, bookmarks, open tabs, reader cache) as a personalized signal of skill interest, embed into a vector store, and surface high-affinity candidates.

## Data sources (local only — never leaves machine)

1. **Chromium history** — `~/.config/google-chrome/Default/History` (SQLite: `urls`, `visits`).
2. **Chromium bookmarks** — `~/.config/google-chrome/Default/Bookmarks` (JSON).
3. **Firefox places** — `~/.mozilla/firefox/*.default*/places.sqlite` (`moz_places`, `moz_historyvisits`).
4. **Brave / Arc / Vivaldi** — same schemas as Chromium.
5. **Reader mode / Pocket / Readwise export** — if user has one, JSON dump.
6. **Shell history** — `~/.bash_history`, `~/.zsh_history` — grep for `claude`, `mcp`, `skill`, `plugin` commands actually run.

## Pipeline

1. **Extract** (read-only, never mutate source):
   - Open SQLite read-only: `sqlite3 file:History?mode=ro`.
   - Filter URLs matching: `github.com/*`, `*.anthropic.com`, `claude.com`, `mcpmarket.com`, `claudemarketplaces.com`, `npmjs.com/package/*mcp*|*claude*`.
   - Keep: url, title, visit_count, last_visit, typed_count.
2. **Embed** — use local `transformers.js` (`all-MiniLM-L6-v2`, 384-dim) in the Electron renderer, no network call.
3. **Store** — `~/.claude/session-manager/vectors.sqlite` using `sqlite-vec` extension (loadable via better-sqlite3). Tables: `docs(id, url, title, text, ts, source)`, `vec_docs(id, embedding)`.
4. **Query** — at discovery time, embed each web-candidate's `description` and `readme` and compute cosine similarity against user's top-N browsed docs. Use max-sim over top-5 user docs as personalization score.
5. **Boost** — add `0.25 * personalization_score` to Plan 1's composite score.
6. **Explain** — attach "you've viewed X related pages" to each candidate in UI.

## Privacy & safety

- Read-only access to browser DBs; copy to tmp before query to avoid locking.
- Never ship embeddings or URLs off-device.
- User opt-in toggle in Settings tab before first scan.
- Respect Incognito / Private Browsing (browsers don't persist — nothing to read).

## Integration points in this repo

- New main-process module `src/main/vector.cjs`:
  - `scanBrowserHistory(opts)` → rows
  - `embedAndStore(rows)` → void
  - `queryByText(text, k)` → `{id, url, title, score}[]`
- IPC channel `vector:query` exposed to renderer.
- New Settings toggle `vectorIndex.enabled` under user scope.
- Skills Library tab consumes scores via new prop `personalizationScore`.

## Success criteria

- Scan completes in <5s for 50k-row histories.
- Top-10 personalized candidates differ meaningfully from raw web ranking.
- Zero network egress during scan/embed.
