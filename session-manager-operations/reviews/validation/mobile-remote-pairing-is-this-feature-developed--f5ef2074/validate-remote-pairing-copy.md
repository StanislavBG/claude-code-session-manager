# Validation: remote pairing copy (PRDs 1752, 1753)

Base: a3d290168a4973c18a6bb28786dfb6ea9de022d4. Commits: 5656979b (1752), b0602df4 (1753).
PRD files found in `prds-archived/`.

## remote-app-pairing-copy-desktop-location (1752) — VERIFIED
- Intro `<p>` names Settings → Phone remote: `web/remote-app/src/components/ConnectScreen.tsx:63-65`.
- `<ol>` order (open SM; Settings → Phone remote + 'Allow remote control from the web'; 'Pair Device…' + enter code): `ConnectScreen.tsx:82-86`.
- No 'Configure → Remote' / 'Remote tab' in the component (diff removes both; JSDoc at `ConnectScreen.tsx:15` now says Settings → Phone remote).
- SAS sheet text: `web/remote-app/src/App.tsx:183`.
- New spec `web/remote-app/src/__tests__/connect-screen-copy.spec.tsx` mocks `../api` requestOtp → `{code:'ABCD1234'}`, asserts the copy before/after 'Generate pairing code', and asserts the absent strings.
- Gate: `npm test` in web/remote-app: 6 files, 19 tests passed. `npm run typecheck`: clean. `npm ci` NOT re-run; I symlinked the main checkout's `web/remote-app/node_modules` temporarily (removed afterward).

## settings-remote-pairing-hint-phone-label (1753) — VERIFIED
- Hint names `bilko.run/projects/session-manager` and 'Generate pairing code', no 'Add Device': `src/renderer/components/tabs/SettingsRemote.tsx:398-401`.
- `data-testid="settings-remote-pair-hint"` on the hint div (`SettingsRemote.tsx:398`); diff shows no other markup/logic change.
- New test in `SettingsRemote.test.tsx` (+8 lines) asserts contains/contains/not-contains.
- Gate: vitest SettingsRemote.test.tsx 7/7 passed; `npm run typecheck` clean; `npm run lint` clean (check-page-stewards clean as the last step; no errors seen). Used a temporary root `node_modules` symlink (removed afterward).

## Cross-checks
- Phone → desktop labels verbatim: 'Allow remote control from the web' = `SettingsRemote.tsx:374`; 'Pair Device…' = `SettingsRemote.tsx:402`; 'Phone remote' = `Settings.tsx:161`.
- Desktop → phone button label: 'Generate pairing code' = `ConnectScreen.tsx:96`. URL path matches `web/remote-app/vite.config.ts:7` (`base: '/projects/session-manager/'`).

## Review of combined diff
6 files, +47/−9. Copy-only; no input handling, secrets, or path changes. No duplicated helpers.

## Findings
### Critical
- none
### Important
- none
### Minor
- `web/remote-app/src/__tests__/e2eKeyStore.spec.ts:4` was changed (a `declare const Buffer` typing shim) though it is outside 1752's `# Files`. It was needed to make the phone-app typecheck gate pass; harmless, but unreported scope.
- The 'Pair Device…' / 'Allow remote control…' phone-side strings are hard-coded duplicates of desktop labels, so they can drift. The new spec guards the phone side only.
- Deploy of the phone app (hand-vendoring into the Bilko repo) is out of scope and not done; the live bilko.run copy stays stale until a human redeploys.
