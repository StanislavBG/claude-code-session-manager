---
title: Delete dead unused DocumentViewer.tsx component
cwd: ~/Projects/session-manager
estimateMinutes: 8
---
# Goal

src/renderer/components/layout/DocumentViewer.tsx exports a read-only `DocumentViewer({ filePath, onClose })` component that is never imported anywhere in the codebase (confirmed via `grep -rn "DocumentViewer" src/` — only self-references inside its own file). It predates and is unrelated to the real file-viewing/editing surface the app actually uses (`src/renderer/components/tabs/EditorView.tsx` + `src/renderer/state/editor.ts`'s `useEditor` store, used by the Projects/File-Explorer tab). Delete this dead file and any dead-only supporting code it alone pulled in, so the codebase doesn't carry two competing "document viewer" concepts.

# Acceptance criteria

- [ ] `git rm src/renderer/components/layout/DocumentViewer.tsx` (or equivalent delete) — file no longer exists.
- [ ] Re-run `grep -rn "DocumentViewer" src/` after deletion and confirm zero matches anywhere in the repo (no stray imports, no test files referencing it, no barrel/index re-export).
- [ ] If a test file exists solely to test DocumentViewer (search `src/renderer/components/**/__tests__/*ocumentViewer*` and similar), delete it too — do not leave an orphaned test for deleted code.
- [ ] If DocumentViewer.tsx imported any helper/util that has no other importer after this deletion (check with grep before removing), remove that now-dead helper too; if it's shared with other still-used code, leave it alone.
- [ ] `timeout 300 npm run typecheck` passes with no new errors.
- [ ] `timeout 300 npx vitest run` (full unit suite) passes — confirms nothing else depended on the deleted file.

# Implementation notes

Read ~/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md before starting.

This is pure dead-code removal, confirmed via prior research in this same repo: `grep -rln "DocumentViewer" src/renderer/` returns only `src/renderer/components/layout/DocumentViewer.tsx` itself (its own interface/function/comment) — no importers anywhere. Do not confuse this with the REAL file viewer/editor used by the Projects/File-Explorer tab, which is `src/renderer/components/tabs/EditorView.tsx` + `src/renderer/state/editor.ts` (`useEditor` store) — that component is heavily used and must NOT be touched by this PRD. This PRD only removes the unused `layout/DocumentViewer.tsx` and anything exclusively dead alongside it.

# Out of scope

- Touching EditorView.tsx or the useEditor store — those are live, unrelated, and used elsewhere
- Any change to how the Scheduler/PRDs tab views or edits PRD files (that's a separate PRD)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
