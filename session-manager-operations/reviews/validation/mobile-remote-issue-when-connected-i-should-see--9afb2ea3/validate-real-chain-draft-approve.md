# Validation: real-chain-approve-follows-draft-ux (PRD 2842)

Base: d67ab7924df0b1cc20928944065beae96cbb706b. PRD commit: ca03b9b2. `git diff base..HEAD --stat` also shows package.json/package-lock.json from the unrelated release bump 88b96e87 (v0.130.3). The PRD's own commit touches only `web/remote-app/src/__tests__/real-chain.browser.spec.ts`.

## real-chain-approve-follows-draft-ux — VERIFIED

- Seeded inbound proposal: spec `start()` adds `epic-inbound` ('Chain Inbound Proposal', status proposed) with `source: { producer: 'cross-project-feedback', fromCwd }`. No autoApprove stamp. The plain proposed and active Epics are unchanged.
- Approve test: clicks the 'Chain Inbound Proposal' row and then `epic-approve`. It asserts `epic-inbound` becomes active, `epic-proposed` stays 'proposed', `epic-active` stays 'active', and a `merge-active-index` call was recorded.
- Draft-start test ('Start Session on a plain proposed draft round-trips...'): clicks the plain row, waits for `new-epic-card`, fills `new-epic-goal`, and clicks `new-epic-create`. It then polls the on-disk `active-index.json` via `readIndex(h)` until `epic-proposed` status is 'active'. It also checks that goalText contains the typed goal, that the inbound proposal stays 'proposed', that `merge-active-index` was called, and that `frameErrors` is `[]`. The status flip is asserted on disk, not just in the UI.
- Refusal test: uses the inbound row and asserts the refusal toast, an unchanged `active-index.json` (Buffer compare) and no `merge-active-index` call. The toast text was updated to match `approveProposed` after b098fd12.
- Gate (all SM_* unset): `npm --prefix web/remote-app test -- src/__tests__/real-chain.browser.spec.ts` gave 8/8 passed. `npm --prefix web/remote-app run typecheck` exited 0.
- Scope: no product source changed. The PRD's own commit changed only the spec file.

## Whole web/remote-app suite — green

`npm --prefix web/remote-app test` with all SM_* unset, run from the repo root: Test Files 35 passed (35), Tests 237 passed | 1 skipped. No red specs. The output had React act() warnings in ConnectScreen tests, which are noise and not failures. `web/remote-app/node_modules` was symlinked from the main checkout. It is gitignored and not committed.

## Findings

- Critical: none.
- Important: none.
- Minor: the draft-start test fills an objective, because the seeded draft is title-only and Start needs one. The PRD allows this (a user would type it), but it means the test does not cover starting a draft that already has an objective.
- Minor: `/code-review` and `/security-review` were not run. I self-reviewed the diff instead. It is test-only, with no secrets, no unsafe input and no path traversal; the temp dirs come from `mkdtemp`.
