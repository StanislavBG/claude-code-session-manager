---
title: Per-turn attribution captions, outcome labels, bubble geometry, inline answer chips
cwd: ~/Projects/session-manager
estimateMinutes: 20
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
dependsOn: [842-retire-legacy-tab-chat-rail]
---

# Goal

Restore the mock's per-turn attribution layer in the Epics Discussion thread
(ChatTranscriptTurn.tsx): "you · <age>" / "claude · <age>" mono captions above bubbles, a
running dot on the in-flight agent turn, an outcome label (sage) on finished agent turns,
26px agent avatar, and the mock's bubble corner geometry (user bubble 12/12/4/12 — small
corner bottom-RIGHT toward the sender; agent card 4/12/12/12). Also restore needs-you INLINE
answer buttons (mock renders the options as buttons in the turn; shipped says "Reply in the
composer below" at :381-383) — clicking one submits that answer through the existing chat
answer path.

# Acceptance criteria

- [ ] Captions with relative ages (reuse formatAgo) on both roles; running dot while
  streaming; outcome label when the turn carries one.
- [ ] Corner radii and 26px avatar per the mock; verify against
  session-manager-operations/design-mocks/epics/epics-mock.jsx Turn (lines ~395-443).
- [ ] Needs-input turns render clickable option buttons that submit via the same code path
  the composer's answer uses (find it in state/chat.ts needs-input handling) — keep the
  composer path working too.
- [ ] Changes gated so non-Epic consumers of ChatTranscriptTurn (if any remain after 842)
  are unaffected — grep importers first.

# Implementation notes

Turn data: ChatTurn in state/chat.ts:34-43 (at, role, questions, toolUses). Ages via
formatAgo. Almanac tokens only.

# Out of scope

- Transcript backfill, split-into affordance.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— every rule is mandatory, especially Execution discipline (bounded commands, verify before
done). All renderer PRDs: `timeout 300 npm run typecheck` + `npm run lint:selectors` +
targeted `timeout 300 npx vitest run <files>` must pass; add/extend vitest coverage for your
change.
