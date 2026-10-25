# Validation: install seeds contract truth

Base: 2f6b5e091c683af63917ad15f65a1c86c0c91d34. Commits: be604cff (test comments), 03c56f13 (telemetry.md). Foreign commit in range, not part of this plan: 345fdf9b (mainHeapSnapshot.cjs).

Cross-repo claim (read-only, `git -C ~/Projects/Bilko show 523ba538:server/routes/telemetry.ts`): `sanitizeSeeds` at :261; /install upsert has `seeds = excluded.seeds` at :504 and stores JSON or NULL at :521; `docs/telemetry-beacons.md` has section "First-run setup outcomes (`seeds`)" at :58. Verified.

## telemetry-test-seeds-persisted-comment — VERIFIED
- Both comment lines read exactly `// Bilko's /install route persists \`seeds\` to app_installs.seeds (bilko-run 523ba538).` (rg count 2; be604cff diff, test.cjs ~:630 and ~:949, each directly above the key-list `expect`).
- "the server ignores the key" absent: `rg --files-without-match` exit 0; no ignore/drop-seeds wording remains.
- be604cff diffstat: 1 file, 2 insertions, 2 deletions, comment lines only. Nothing under src/main/lib/telemetry/ changed by this commit.
- Gate: rg checks exit 0; `npx vitest run src/main/__tests__/telemetryClient.test.cjs` → 49 passed.

## telemetry-doc-install-keys-seeds — VERIFIED
- Key list now ends `..., timezone, env, seeds` (15 keys; matches buildInstallWire in telemetryClient.cjs:559-585 key-for-key). 
- `seeds` paragraph follows (03c56f13): buildSeeds() keeps only status; sanitizeSeeds() returns null or exactly devPlugin/schedulerMcp/agentPersonas with done/pending/failed/exhausted/null. Matches telemetryBoot.cjs:35-50 and SEED_ENUM.
- Paragraph says Bilko persists `seeds` to `app_installs.seeds` (523ba538) and points at docs/telemetry-beacons.md "First-run setup outcomes (`seeds`)".
- Privacy **Sent** paragraph mentions the three fixed step names, enum values only, and that fix text/paths are dropped.
- No "server ignores seeds" wording; Bilko's filtering rules (slug names, 20-step cap) not restated. Only telemetry.md changed by 03c56f13.
- Gate: three rg checks exit 0; `npm run lint:docs` → ok (21 junctions, 34 files).

## Findings
- Critical: none.
- Important: none.
- Minor: telemetry.md ~:232-236 has one overlong line (the "Unlike `track`/..." sentence run on after the parenthetical); cosmetic only.
- Minor: range contains unrelated commit 345fdf9b touching src/main/lib/telemetry/ (mainHeapSnapshot.cjs); not from these PRDs.
- Self-review of combined diff: docs/comments only, no secrets, no input handling.
