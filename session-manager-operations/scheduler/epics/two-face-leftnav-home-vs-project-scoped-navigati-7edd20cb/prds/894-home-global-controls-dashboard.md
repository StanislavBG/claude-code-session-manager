---
title: "Home face: Global Controls dashboard section in Session-Manager Config"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 22
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
dependsOn: [leftnav-two-face-framework, nav-face-session-manager-config]
---
# Goal

Add a new "Global Controls" section to `src/renderer/components/tabs/SessionManagerConfig.tsx`
(the Home-only 'sm-config' destination) that surfaces quick-link summary cards for the
machine-wide (`'user'`-scope) state of the six dual-scope config tabs that now default to
`'user'` scope on Home face (Settings, Permissions, Hooks, MCP Servers, System Prompt, Skills —
per sibling PRDs 880, 881, 883, 884, 887, 888 in this epic). Each card shows a short count/status
summary (e.g. "3 hooks configured globally", "N MCP servers", "Skills: N installed") and
navigating to it via the existing `navigate` prop pattern this app already uses for cross-tab
navigation (e.g. AlmanacFooter pills navigate to Settings/Home/Scheduler). This surfaces
genuinely new global-behavior visibility that didn't exist as a single view before — it is not a
copy of any existing tab.

# Acceptance criteria

- [ ] New "Global Controls" section renders in SessionManagerConfig.tsx as a card grid with one
      card per: Settings (user scope), Permissions (user scope), Hooks (user scope), MCP Servers
      (user scope), System Prompt (user scope), Skills (user scope)
- [ ] Each card's count/status summary is read via the SAME existing config read paths those
      tabs already use (reuse `state/config.ts`'s existing readJson/useConfig usage patterns —
      grep Settings.tsx/Hooks.tsx/McpServers.tsx/Skills.tsx/Permissions.tsx/SystemPrompt.tsx for
      how they currently read `~/.claude/settings.json`, `~/.claude.json`, skills directory
      listing, etc. — do NOT add any new main-process IPC route or handler)
- [ ] Each card's onClick calls the existing `navigate`/`openPanel` mechanism to route to that
      destination (same pattern AlmanacFooter pills already use)
- [ ] New unit test mounts the Global Controls section with a mocked config store and asserts
      each card renders its count/status from the mocked data
- [ ] `git diff --stat -- src/main | wc -l` reports 0 (no main-process/IPC changes — this PRD is
      renderer-only, reusing existing reads)
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the new test file> passes
- [ ] npm run lint:selectors passes

# Implementation notes

Depends on leftnav-two-face-framework and nav-face-session-manager-config having landed (the
`sm-config` key is home-only in NAV_ITEMS). Does NOT depend on PRDs 880/881/883/884/887/888
actually being merged first — this PRD only reads existing `'user'`-scope config state via
existing read helpers, it does not depend on their default-scope-derivation changes. Read
`src/renderer/state/config.ts` and each of Settings.tsx/Hooks.tsx/McpServers.tsx/Skills.tsx/
Permissions.tsx/SystemPrompt.tsx's existing data-loading code before writing new reads — reuse,
do not reinvent.

# Out of scope

- Any new main-process IPC route
- Editing config values from inside the dashboard cards (read-only summary + navigate, per Goal)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
