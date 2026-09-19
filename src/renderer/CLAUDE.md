# src/renderer/ — scoped context

Part of the **DESKTOP HARNESS** partition (except `lib/projectPages/`, below) — see
[`project-partition.md`](../../session-manager-operations/architecture/project-partition.md).

## What's here

React 18 + Vite renderer. Layout (no per-file lists — `ls` it):

- `components/` — `tabs/` (one file per nav destination), `ui/` (design primitives), `layout/`,
  `epics/`, `workbench/`, plus top-level shared components
- `lib/` — pure helpers and hooks · `state/` — zustand stores · `data/` — static data
- `public/vad/` — self-hosted voice-activity assets · `testUtils/` — test helpers

**`lib/projectPages/` holds two hooks** (`useBuilderEpic.ts`, `useProjectPagesOutput.ts`) for the single-`home.html` Project Home; the old `web/project-pages` build toolchain was removed.

**Tab registry = four files that change together:** `lib/navKey.ts` (`NavKey` union),
`lib/screenKeys.ts`, `components/screenComponents.tsx`, `lib/navGroups.ts` (`NAV_ITEMS`). The
count is whatever `NAV_ITEMS` says — never write a literal in a doc.

**Generated — never hand-edit:** `public/vad/` via `npm run refresh:vad-assets` (copies every
`ort-wasm*` file plus silero/worklet; drift-tested); `data/claude-settings-schema.json` via
`npm run sync:settings-schema`.

## Who consumes this

Vite builds it into `dist/`, loaded by Electron's `createWindow`. Tests are glob-covered by
vitest — no registration needed.

## What must NOT be assumed

- **Zero production imports from `src/main`.** Everything crosses `window.api`, typed by
  `src/preload/api.d.ts`.
- **`lib/apiBootCheck.ts` guards only part of the preload namespaces** (hand-kept
  `EXPECTED_NAMESPACES`). Known debt: extend it or build the manifest emitter its comment asks
  for. A namespace missing there is not proof it is unused.
- Blank-screen laws (selectors, hooks, z-ladder) live in the root
  [`CLAUDE.md`](../../CLAUDE.md) Avoid list — not restated here.
- Per-file rationale: [`code-map.md`](../../session-manager-operations/architecture/code-map.md).
