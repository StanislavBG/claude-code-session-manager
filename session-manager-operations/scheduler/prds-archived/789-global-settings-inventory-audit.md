---
title: "Global-settings audit: inventory every frame action + setting surface, classify global vs per-tab"
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

Produce the ground-truth inventory for the "how are global settings managed" architecture thread. Today, settings/state are scattered: frame-level action buttons (voice, broadcast, watchers, terminal controls, model pickers), per-tab-independent behavior, stray localStorage keys, and config files under `~/.claude/session-manager/`. Deliverable is a single analysis document — `session-manager-operations/architecture/global-settings-inventory.md` — that inventories every user-facing control and persisted setting, classifies each as app-global vs per-tab vs per-panel, and flags inconsistencies. This is a read-and-write-doc PRD: NO application code changes.

# Acceptance criteria

- [ ] `session-manager-operations/architecture/global-settings-inventory.md` exists with these sections: (1) Frame action buttons — every button/control mounted in App.tsx's chrome (sidebar header, TabBar row, AlmanacFooter chips, VoiceButton, BroadcastBar, WatchersPopover, TerminalControls popover), each with file:line, what it controls, and whether its effect is global or per-tab; (2) Persisted settings surfaces — every localStorage key (grep `localStorage.` under src/renderer, list key name + owner file + what it stores), every file under `~/.claude/session-manager/` written by the app (grep writeJson/writeTextAtomic call sites in src/main), and zustand stores with persistence; (3) Per-tab vs global classification table — for each setting/control: current scope, whether that scope is correct or accidental, and one-line rationale; (4) Inconsistencies & open questions — concrete list (e.g. same concern controlled in two places, per-tab setting users expect to be global or vice versa); (5) NO recommendations section — this is inventory, the consolidation design is a follow-up decision
- [ ] Every claim carries a real file:line reference verified by reading the code (no invented paths)
- [ ] Zero changes to any file under src/ — `git status` shows only the new doc (and its directory)
- [ ] `timeout 60 git diff --stat src/` outputs nothing

# Implementation notes

Start points: `src/renderer/App.tsx` (chrome composition ~640-700, action toggles ~155-175), `src/renderer/components/layout/AlmanacFooter.tsx` (chips), `src/renderer/components/TerminalControls.tsx` (terminal settings popover + its localStorage), `src/renderer/components/layout/AlmanacSidebar.tsx:59-176` (width/collapse keys), `src/renderer/lib/rawSessionModel.ts` (model selection scope), `src/renderer/state/*.ts` (which stores persist and where), `grep -rn "localStorage" src/renderer --include=*.ts*` and `grep -rn "writeJson\|writeTextAtomic" src/main` for the exhaustive sweeps.

Context for the classifier column: the app is mid-migration to a dockview-based workbench (PRDs 778-780, 787, 788) where screens become panels; when classifying, note any setting whose natural home would become "per-panel" under that model, but do not design the migration.

`session-manager-operations/architecture/` may not exist — create it.

# Out of scope

- Any code change, refactor, or settings UI
- Recommendations/consolidation design (follow-up thread after the workbench chain lands)
- The workbench layout persistence itself (PRD 788 owns it)

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
