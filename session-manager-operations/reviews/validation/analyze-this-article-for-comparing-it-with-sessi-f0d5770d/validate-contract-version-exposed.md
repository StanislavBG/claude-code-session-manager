# Validation: contract-version-exposed

Base: 385d8b21 (known). Commit: a4d3e424 (`feat(admin-api): expose outside-contract version…`). PRD file: prds-archived/3315-contract-version-exposed.md.

## contract-version-exposed — VERIFIED

- AC1: `src/main/lib/externalContract.cjs:17,24-28` exports CONTRACT_VERSION=1 and contractInfo() → `{contractVersion, appVersion}`; appVersion from package.json or null (`:20-21`).
- AC2: rule comment at `externalContract.cjs:4-7`.
- AC3: `localAdminHttp.cjs` health answers `{ ok: true, ...contractInfo() }`; test asserts 401 without the token (`localAdminHttp.test.cjs` health test).
- AC4: `ensureToken` and `persistPort` write `{port, token, ...contractInfo()}`; chmod 0600 retained; test asserts full object and mode 0600.
- AC5: 404 body keeps error/unknownRoute/appVersion and adds contractVersion; test asserts it.
- AC6: both test files assert the above; new `src/main/lib/__tests__/externalContract.test.cjs` covers exports.
- Gate re-run: vitest (2 files, 13 tests) passed; `npm run typecheck` exit 0.

## Combined diff review
5 files, +67/-14. No secrets, no path handling or input changes; token-file mode unchanged. Self-review only (no new findings).

## Findings
- Critical: none.
- Important: none.
- Minor: `scripts/lib-layout.json` also edited (`"externalContract": "."`), outside the PRD's `# Files` list; needed for the lib-layout check, harmless.
- Minor: 404 body omits `appVersion` when package.json is unreadable (the pre-existing behaviour), so "keeps appVersion" holds only when readable.
