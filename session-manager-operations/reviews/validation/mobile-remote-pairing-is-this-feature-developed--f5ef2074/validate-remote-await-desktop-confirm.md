# Validation: remote-app-await-desktop-sas-confirm (PRD 1755)

Base: bdbde4c8 (given). Commit for this PRD: `2d59dc86`. The base..HEAD range also holds `e196eeed` and its merge `d744dae6` (PRD 1757, crypto-lib extraction). That is a different plan and is out of scope here. It touches no `web/remote-app` file.

## remote-app-await-desktop-sas-confirm — VERIFIED

- store.ts: field `awaitingDesktopConfirm: boolean` at `web/remote-app/src/store.ts:24`, initial `false` at `:61`.
  - `setPendingSas` sets `true` on a non-null SAS at `:91`.
  - `setSessions` sets `false` at `:77`.
  - `reset()` restores `false` at `:87`.
  - `clearPendingSas` only sets `pendingSas: null`, so the flag is unchanged.
- App.tsx: the button reads `Got it` at `web/remote-app/src/App.tsx:195`. The line above it, at `:189`, reads "Now click “Codes match — confirm” on your computer (Settings → Phone remote). Your sessions appear once you do." `onClick={clearPendingSas}` is kept.
- Cockpit.tsx: the empty state at `web/remote-app/src/components/Cockpit.tsx:61-65` reads "Waiting for you to confirm the 6-digit code on your computer (Settings → Phone remote)…" when `sessions.length === 0` and `awaitingDesktopConfirm` is true. Otherwise the default text is unchanged.
- Spec `web/remote-app/src/__tests__/await-desktop-confirm.spec.tsx` has 4 cases:
  - the store flag lifecycle (set, survives clear, cleared by `setSessions([])`);
  - `reset()` restores the flag;
  - the Cockpit awaiting text;
  - the default Cockpit text.
  It passes.
- Cross-check: `src/renderer/components/tabs/SettingsRemote.tsx:329` has the button text `Codes match — confirm`. It matches the phone copy verbatim: same em dash, same case.
- Gate re-run in the foreground:
  - `npm --prefix web/remote-app ci`: exit 0.
  - `npm --prefix web/remote-app run typecheck`: exit 0.
  - `npm --prefix web/remote-app test`: 7 files and 23 tests passed, exit 0. The `act(...)` warnings come from the existing auth-gate spec and are not new.
- Scope: only the four listed files changed under `web/remote-app`. No protocol or `webRemote.cjs` change from this PRD.

## Review of the combined diff
`/code-review` and `/security-review` were not run. This is a self-review of the web/remote-app diff. The change is UI copy plus a boolean in a zustand store. It adds no new input handling, secrets, or paths. All text is a static JSX literal, and no existing helper is duplicated.

## Findings

Critical: none.

Important: none.

Minor:
- `web/remote-app/src/store.ts:91`: `setPendingSas(null)` leaves the flag untouched. This is a sensible choice, but the PRD did not specify it. The implementer noted it in the PRD report.
- `web/remote-app/src/store.ts:77`: the flag clears on any `setSessions` call, including one before the desktop confirmation. The PRD defines the first `event:session:list` as proof of confirmation, so this is consistent. If the desktop never confirms, the phone waits indefinitely with no timeout hint.
- The "Got it" sheet text and the Cockpit empty state have no render test for the App sheet. The AC only required the Cockpit test, so this is not a gap against the PRD.
