# Validation: agents-override-registers-project-root

Base: 2a8c4389 (commits: 53383032 `fix(agents): register the open project's root before writing an override`). PRD file: epics/.../prds-archived/2805-agents-override-registers-project-root.md.

## agents-override-registers-project-root — VERIFIED

- AC1: `saveOverlay` calls `addAllowedRoot(validatePath(project.cwd))` right after `findOpenProject` (agentLibrary.cjs, diff hunk @@ -148); findOpenProject throws `project not open` first.
- AC2: `savePersona` has `addAllowedRoot = configMgr.addAllowedRoot` and passes it on; JSDoc states dormant-tab rationale.
- AC3: test 'a dormant open project (root never registered) …' in agentOverlayWrite.test.cjs; no validatePath/writeTextAtomic stubs; asserts overlay `---\nmodel: opus\n---\n` and global byte-identical.
- AC4: 'a not-open or empty cwd under HOME …' asserts `project not open` and allowed roots unchanged.
- AC5 / gate: vitest on the 3 files → 3 files, 31 tests passed; `npm run typecheck` clean; `npm run lint` ok (e2e budget 18/19).

## Real-path probe (no stubs)

`env -i HOME=<tmp> PATH=$PATH node` script; tabs.json with one tab (cwd HOME/proj), global dev-lead.md present; `validated(schemas.agentsSavePersona, p => agentLibrary.savePersona(p))` with the Agents-page payload (model opus, effort inherit), no addAllowedRoot call:

```
roots before false
result {"ok":true,"path":"/tmp/smhome-WnSW/proj/.claude/agents/dev-lead.md"}
overlay "---\nmodel: opus\n---\n"
global identical true
```

## Combined diff review

2 files, +57/-2 (agentLibrary.cjs, agentOverlayWrite.test.cjs). Self-review: the cwd passes validatePath before registration; unknown cwd registers nothing; the IPC schema is strict so the renderer cannot inject `addAllowedRoot`; no secrets; reuses existing helper.

## Findings

- Critical: none
- Important: none
- Minor: the root stays registered for the process lifetime after a save (same as the projectBrief precedent); acceptable.
