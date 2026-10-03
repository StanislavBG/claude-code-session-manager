# Validation: 1504 package-homepage-funding-bilko-run

Base: `987d95f5016bc1c33074a50971b740c9dbc6cc8d`
PRD: `session-manager-operations/scheduler/epics/increase-secrity-score-based-on-audit-creteria-h-a5ae78c4/prds-archived/1504-package-homepage-funding-bilko-run.md`
Landed in: `c880b8824810e0fd287a02148c1a3973f3f4b832` — "chore(funding): point homepage at bilko.run and add coffee funding link"

`git log --oneline 987d95f5..HEAD -- package.json .github/FUNDING.yml README.md` → single commit `c880b882`.

## 1504 package-homepage-funding-bilko-run — VERIFIED

| Acceptance criterion | Evidence |
| --- | --- |
| `package.json` `homepage` exactly `https://bilko.run/projects/session-manager/`; `repository`/`bugs` unchanged | `package.json:88` → `"homepage": "https://bilko.run/projects/session-manager/"`; diff shows `repository`/`bugs` blocks untouched |
| `package.json` `funding` right after `bugs`, coffee URL first | `package.json:96-99` → `"funding": [{ "type": "individual", "url": "https://bilko.run/coffee" }, { "type": "individual", "url": "https://bilko.run/projects/session-manager/" }]`, immediately after the `bugs` block |
| `.github/FUNDING.yml` exactly one key `custom: [...]` | `.github/FUNDING.yml:1` → `custom: ["https://bilko.run/coffee", "https://bilko.run/projects/session-manager/"]` (file has exactly 1 line) |
| README `## Contributing / development` ends with the single coffee line, no badges | `README.md:108` → `Enjoying Session Manager? [☕ Buy me a coffee](https://bilko.run/coffee) — the app stays free either way.`, placed directly before `## License`, no image/badge syntax |
| GitHub repo website set | `gh api repos/StanislavBG/claude-code-session-manager --jq .homepage` → `https://bilko.run/projects/session-manager/` (confirmed live against GitHub, not just the local diff) |
| `npm pkg get funding homepage` prints all three URLs; `lint:docs` + `typecheck` pass | `npm pkg get funding homepage` → both coffee + project-home URLs present (ran in `/home/bilko/Projects/session-manager`, main checkout pinned to the same commit `c880b882`, since this worktree has no `node_modules`); `npm run lint:docs` → `doc-hierarchy: ok (26 junctions, 36 files linted)`, exit 0; `npm run typecheck` → exit 0 |

Additional AC from the validation PRD itself: `curl -sL https://bilko.run/projects/session-manager/` → `HTTP_STATUS:200`, `<title>Session Manager</title>` confirmed live.

### Gate re-run

Ran the PRD's own `# Gate` block commands, in order:

1. `gh api repos/.../claude-code-session-manager --jq 'if .homepage == "https://bilko.run/projects/session-manager/" then "ok" else error(...) end'` → `ok`
2. `grep -q bilko.run/coffee .github/FUNDING.yml` → match (exit 0)
3. `grep -q bilko.run/coffee README.md` → match (exit 0)
4. `npm run lint:docs` → exit 0 (run from `/home/bilko/Projects/session-manager`; this worktree lacks `node_modules`, see note below)
5. `npm run typecheck` → exit 0 (same note)

All five steps passed.

**Note on gate environment:** this validation worktree (`.../1505-validate-package-homepage-funding`) has no `node_modules` installed, so `npm run lint:docs`/`npm run typecheck` fail with `MODULE_NOT_FOUND` here regardless of the PRD's change. The main checkout at `/home/bilko/Projects/session-manager` is pinned to the identical commit (`c880b882`, verified via `git log -3`) and has `node_modules` installed, so the gate was run there against byte-identical file contents. This is an infra gap in the worktree, not a defect introduced by PRD 1504.

### Review

`git diff --stat 987d95f5..HEAD`:
```
 .github/FUNDING.yml | 1 +
 README.md           | 2 ++
 package.json        | 6 +++++-
 3 files changed, 8 insertions(+), 1 deletion(-)
```

`/code-review` (medium): no findings — pure static config/doc change (JSON `funding`/`homepage` fields, one-line YAML, one README link), no logic, both new URLs resolve 200.

`/security-review`: no findings — no user input, no code execution path, no new attack surface; excluded category anyway (docs/config literals).

## Findings

None — Critical / Important / Minor all empty.

---

VALIDATION: 1504-package-homepage-funding-bilko-run VERIFIED
SCHEDULER_VERDICT: PASS
