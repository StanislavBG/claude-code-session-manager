---
title: Document session-manager-operations namespaces as data contracts
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
---
# Goal

Formalize `session-manager-operations/` as a set of documented data contracts, one README.md per owned namespace, matching the existing `session-manager-operations/feedback/README.md` in structure and rigor. Today `src/main/lib/opsOwnership.cjs`'s `OWNERS` map (lines 43-54) declares 5 namespaces — `prompt-sessions` (owner: `epics`), `scheduler` (owner: `scheduler`), `project-brief` (owner: `project-home`), `feedback` (owner: `feedback`), `browser` (owner: `browser`) — but only `feedback/README.md` exists; `prompt-sessions`, `scheduler`, and `project-brief` have no README despite being actively written by the app every session. Add one to each. Additionally: resolve the open question of whether a "general / non-tab-specific operations" namespace is needed. On disk today, `session-manager-operations/` also contains `architecture/`, `design-mocks/`, `HUMAN_LEARN/`, and `reviews/` folders that are NOT in the OWNERS map at all — these are written directly by Claude Code skills (e.g. `explain-to-me` writes `HUMAN_LEARN/`) via the Write tool, outside the app's own IPC-mediated write path, which is why `opsOwnership.cjs`'s fail-closed check doesn't block them (that check only guards the app's own `config.cjs` writeJson/writeTextAtomic/etc. call sites, not direct filesystem writes by tooling). Determine and document whether this is the correct, intentional split (app-owned runtime state goes through OWNERS + single-writer law; skill-authored documentation/artifact folders are a separate, deliberately unenforced category) or whether a gap exists that needs a new declared namespace — write the decision down, don't leave it implicit.

# Acceptance criteria

- [ ] ## READMEs
- [ ] `session-manager-operations/prompt-sessions/README.md` exists, documenting: what it stores (active Epics in `active-index.json`, archived Epics as one JSON per Epic), the JSON shape of an Epic/PromptSession entry (read `src/renderer/state/promptSessions.ts` or equivalent for the actual TypeScript type — quote real field names, don't invent them), sole writer (`epics`, per opsOwnership.cjs), the one declared cross-writer delegation (scheduler writing `active-index.json` — confirm exact scope from opsOwnership.cjs's DELEGATIONS table), and file lifecycle (active → archived).
- [ ] `session-manager-operations/scheduler/README.md` exists, documenting: the `epics/<epic-id>/prds/<NN>-<slug>.md` PRD-source layout, the `state/` queue + history shard files (name them from `lib/queueStore.cjs`), the retired flat `prds/` → `prds-archived/` auto-consolidation behavior, sole writer (`scheduler`), and PRD frontmatter/body contract (can reference `/develop`'s PRD_AUTHORING.md rather than duplicating it).
- [ ] `session-manager-operations/project-brief/README.md` exists, documenting: what `brief.json` (or equivalent — confirm actual filename from `src/main` or renderer code) stores, its shape, sole writer (`project-home`), and how/when it's regenerated vs hand-edited.
- [ ] Each new README follows `feedback/README.md`'s structure (purpose, storage location/naming pattern, required shape, ownership, lifecycle) adapted to that namespace — do not copy feedback-specific sections (like "How to submit") that don't apply.
- [ ] ## General-namespace decision
- [ ] A decision is written down (in `CLAUDE.md`'s single-writer-law section, or a short note in `session-manager-operations/HUMAN_LEARN/` if more appropriate) stating explicitly: whether a new 'general' OWNERS namespace is needed right now, and why/why not — based on checking whether anything currently needs to write cross-cutting non-tab-specific operational data and has no existing home. If the answer is 'not needed yet', explicitly name the existing unenforced skill-authored folders (architecture/, design-mocks/, HUMAN_LEARN/, reviews/) as the deliberate 'not app-owned runtime state' category so a future reader doesn't mistake their absence from OWNERS for an oversight.
- [ ] ## Tests
- [ ] `timeout 120 npm run typecheck` passes (should be a no-op if this PRD is docs-only, but confirms nothing broke).
- [ ] `timeout 60 npm run health` reports GREEN or the same status as before this PRD (docs changes shouldn't affect it, but verify).

# Implementation notes

Read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` first. Model each new README on `session-manager-operations/feedback/README.md` (already on disk, read it in full for tone/structure/length). Source-of-truth files to quote real shapes from, not guess: `src/main/lib/opsOwnership.cjs` (OWNERS + DELEGATIONS tables), `src/renderer/state/promptSessions.ts` (or wherever the Epic/PromptSession TS type is defined — grep for `promptSessionArchivePath`), `src/main/lib/queueStore.cjs` and `src/main/lib/prdLocations.cjs` (scheduler state/PRD layout), the project-brief owner code (grep `project-brief` in `src/main`). This is a docs-only PRD — do not modify any runtime code, only add README.md files and the one CLAUDE.md/HUMAN_LEARN decision note.

# Out of scope

- Creating a new OWNERS namespace/folder unless the investigation concludes one is genuinely needed with a real current writer — don't invent a 'general' namespace speculatively.
- Rewriting or restructuring feedback/README.md itself.
- Adding a README to architecture/, design-mocks/, HUMAN_LEARN/, or reviews/ — those are out of the OWNERS single-writer system by design per this PRD's own findings; document that fact, don't retrofit READMEs onto them here.
- Any code change to opsOwnership.cjs, config.cjs, or any main-process write path.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
