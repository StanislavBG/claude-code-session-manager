# PRD 772 code-review nits (dormant-default new sessions)

Source: code-reviewer pass on commit 5f1bee5 ("default new project sessions to Chat view").
Verdict was clean — no Critical/Important. These are Minor cleanups worth a tiny PRD:

1. **Stale docstring** — `src/renderer/lib/createPickedSession.ts:1-11` still describes spawning
   `claude --dangerously-skip-permissions --session-id <uuid>` and "Throws on IPC / spawn
   failures". It now creates a dormant Chat-view tab with no spawn; only `pickDirectory` IPC can throw.
2. **Misleading toast copy** — `src/renderer/App.tsx:181` and `:319`:
   "Could not start new session. Is the claude CLI on PATH?" can now only fire on a
   directory-picker IPC failure — the CLI is never invoked at tab creation. Reword.
3. **Silent argument drop** — `src/renderer/state/sessions.ts:137`: `dormant: true` with a
   non-null `startupCommand` silently discards the command. Consider a discriminated union
   (`{ dormant: true } | { startupCommand: string | null }`) or a dev-mode warning.
4. **Pre-existing, noted in passing** — `useKnownProjects.ts:135` tags tabs
   `presetId: 'projects-tab'` but no such preset exists in `presets.ts`, so `restartTab`'s
   `findPreset` fallback always fires for these tabs. Predates 772.

All are no-behavior or copy-level; bundle into one ~8-minute PRD.

## RESOLUTION

**Queued as `812-dormant-default-session-review-nits`** (this repo's own
`session-manager-operations/scheduler/prds/`) — bundles all 4 findings (stale docstring, misleading
toast copy, silent-argument-drop dev warning, `projects-tab` preset-id mismatch check) exactly as
suggested, sized ~10 min.
