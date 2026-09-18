# docs/ — FROZEN ARCHIVE

This is a **FROZEN ARCHIVE** of pre-2026-08 dev/design notes. Nothing here is authoritative. Current architecture lives in [`session-manager-operations/architecture/`](../session-manager-operations/architecture/) and partition boundaries live in [`project-partition.md`](../session-manager-operations/architecture/project-partition.md).

`docs/` is neither listed in `package.json`'s `files` array nor scanned by
`scripts/ops-sweep.cjs` — it has no automated hygiene coverage and its contents are
never shipped. Nothing in this folder is re-verified; a stale claim here stays stale
until a human edits it.

## Per-group status

| Group | Last commit | Status |
| --- | --- | --- |
| [`voice/`](voice/) (31 files) | 2026-05-09 | **HISTORICAL** — F1–F9 all shipped. The `*.impl.critique.md` files are dated snapshots; several of their Severe findings have since been fixed (e.g. F3's saturation curve and 60 Hz aria, now `MicLevelMeter.tsx:92,107-110`). F8 semantic turn detection was **designed, NOT implemented** — `src/renderer/lib/turnDetectorWorker.ts` is a stub and the host never consults its result. Current behavior lives in `src/renderer/lib/speechRecognition.ts` and `src/renderer/state/voice.ts`, not here. See [`voice/master-plan.md`](voice/master-plan.md) for the block's index. |
| [`web-remote/`](web-remote/) (4 files) | 2026-09-12 | **STALE** — the desktop half of web remote was removed 2026-08-06 (`b014cc2`). The file:line citations inside these docs point at deleted files (`src/main/webRemote.cjs`, `src/renderer/components/tabs/WebRemote.tsx`, `tests/unit/ipc-web-remote.spec.ts`). Current state lives in [`../web-remote/CLAUDE.md`](../web-remote/CLAUDE.md) and [`../web/README.md`](../web/README.md). `PRIOR-ART.md` is external-facing prior-art research, not a claim about this codebase, so it cannot rot the same way. A fifth file — a completed, self-superseded work order recording an edit to a sibling repo — was removed 2026-09. |
| [`prd/editor/`](prd/editor/) (6 files) | 2026-06-03 | **HISTORICAL** — shipped. The TipTap-for-markdown decision recorded here was later reversed. |
| [`design/`](design/) (8 files) | 2026-07-30 | **HISTORICAL** — see [`design/README.md`](design/README.md). `browser-tab.design.jsx` specs a Browser tab that was never built. |
| [`History-pre-Design.md`](History-pre-Design.md) | 2026-07-10 | **STALE** — Tiers 0-3 it describes have since shipped. |
| [`Browser-pre-Design.md`](Browser-pre-Design.md) | 2026-07-09 | **STALE** — the Browser tab it specs was never built. |

Four singleton docs were removed 2026-09 (audited/proposed a component or PRD path no longer
in the codebase): an audit of a UI component retired five days after the audit was written; a
proposal pointing at a scheduler PRD path that is no longer read; a resolved incident note (its
"repo is never idle" concurrent-writer lesson is folded into
[`scheduler-operations.md`](../session-manager-operations/architecture/scheduler-operations.md#10-concurrent-writer-hazard-the-repo-is-never-idle));
and the sibling-repo work order mentioned above.

## Live inbound code pointers — preserve on any future move

- `src/renderer/lib/speechRecognition.ts:67` → [`voice/prd/F8-turn-detection.v2.md`](voice/prd/F8-turn-detection.v2.md)
- `src/renderer/lib/speechRecognition.ts:85` → [`voice/prd/F6-streaming-partials.v2.md`](voice/prd/F6-streaming-partials.v2.md)

## Phantom references

Several `docs/voice/prd/*.md` files defer their e2e contract to `e2e_test_infra.md`,
and F8 cites `preset_architecture.md`. Neither file has ever existed in this repo
(`git log --all` returns nothing for either name) — do not go looking for them.
