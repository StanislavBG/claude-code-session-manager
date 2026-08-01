---
title: "Home face: global behavior preference — default landing tab on launch"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
dependsOn: [leftnav-two-face-framework, nav-face-session-manager-config]
---
# Goal

Add one new global behavior preference toggle to the Home-only Session-Manager Config tab
(`src/renderer/components/tabs/SessionManagerConfig.tsx`): "Open to Home on launch" (boolean).
This is a genuinely new cross-project behavior control, not a reshuffle of an existing tab.
Persist it via the existing `config.cjs` `writeJson`/atomic-write helper into a new small file
`~/.claude/session-manager/app-prefs.json` (do not reuse `scheduler-machine.json`, which is a
different concern), and read it once at boot to decide the initial `focusedPanelId` in
`src/renderer/state/layout.ts`'s `DEFAULT_LAYOUT` construction. When the pref is absent, current
default behavior (whatever layout.ts does today) must be unchanged.

# Acceptance criteria

- [ ] New toggle "Open to Home on launch" renders in SessionManagerConfig.tsx's Home-only
      surface, reading/writing via the existing `config.cjs` writeJson helper (grep config.cjs
      for the exact exported function name and its atomic tmp+rename pattern before use — do not
      reimplement atomic write)
- [ ] Preference persists to `~/.claude/session-manager/app-prefs.json` as
      `{ "openToHomeOnLaunch": boolean }`
- [ ] `src/renderer/state/layout.ts` reads this file once at its `DEFAULT_LAYOUT`/initial-state
      construction point (grep for where `focusedPanelId` is first initialized) and sets the
      initial `focusedPanelId` to `'overview'` when the pref is true; when the pref is absent or
      false, existing current behavior is preserved unchanged
- [ ] New unit test: pref file absent -> initial focusedPanelId matches current unmodified
      behavior; pref file `{openToHomeOnLaunch:true}` -> initial focusedPanelId is 'overview';
      write-then-read round-trips through the toggle component with a mocked config IPC layer
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the new/updated test files> passes
- [ ] npm run lint:selectors passes

# Implementation notes

Depends on leftnav-two-face-framework and nav-face-session-manager-config having landed. Read
`src/main/config.cjs`'s `writeJson`/`writeTextAtomic` exports and `src/renderer/state/layout.ts`
in full before writing any code — this repo's CLAUDE.md explicitly bans reimplementing the
tmp+rename atomic-write pattern; reuse the existing helper via the same IPC path Settings.tsx
uses. `~/.claude/session-manager/app-prefs.json` is a new file this PRD creates; there is no
existing reader/writer for it yet, so both sides (renderer read/write call + main-process
IPC plumbing if the existing writeJson IPC handler doesn't already accept an arbitrary path
under `~/.claude/session-manager/`) may need wiring — grep how `scheduler-machine.json` is
read/written for the closest existing precedent of a small machine-level JSON prefs file.

# Out of scope

- Any other new global behavior toggle beyond "Open to Home on launch" (additional toggles are
  follow-up PRDs, not bundled here per PRD scope-sizing convention)
- New-project template/default-scope inheritance settings (a separate, larger follow-up idea —
  do not build it here)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
