---
title: Extend consistent voice input to the Memory panel's Send composer
cwd: ~/Projects/session-manager
estimateMinutes: 20
---

# Goal

Depends on PRDs 790 and 791, which must land first — read their actual landed diffs before
starting. The user's stated principle: "if we have a text-entry area with a Send button it
should have a consistent voice input as well." src/renderer/components/tabs/MemoryNaturalPanel.tsx
already has a textarea + Send composer structurally identical to Chat's (~line 467-489, gated on
its own `activeTabId`, sends to "the active terminal" per its own placeholder copy) but has no
voice input at all. This PRD adds VoiceButton there too, at the left of its composer row,
matching PRD 791's placement convention.

Two other Send+textarea surfaces were surveyed and are explicitly NOT included here:
BroadcastBar.tsx (src/renderer/components/BroadcastBar.tsx) sends one prompt to a
user-selected checklist of MULTIPLE tabs at once — there is no single coherent tab for voice
recording to target, and picking one arbitrarily would misrepresent which session the spoken
words are "for." That needs a product decision (e.g. record generically and just fill the shared
textarea, never tab-scoped) which is out of scope for this PRD. AssistantRail.tsx
(src/renderer/components/tabs/editor/AssistantRail.tsx) already has its own voice affordance
(`onListen`) tied to the code-editor's selection/edit flow — a different, already-established
pattern — and does not need VoiceButton.

# Acceptance criteria

- [ ] Confirm whether MemoryNaturalPanel's `activeTabId` (~line 489) is the same value as
      useSessions.getState().activeTabId (which is what VoiceButton's onClick reads internally,
      src/renderer/components/VoiceButton.tsx ~line 44) or a separately-tracked value. If they
      can differ, give VoiceButton an optional `tabId` prop that overrides its internal lookup
      when provided (additive, existing callers unaffected), and pass MemoryNaturalPanel's own
      activeTabId through it. If they are always the same value, document why in a code comment
      and skip adding the prop — do not add unused flexibility
- [ ] MemoryNaturalPanel.tsx's composer row (~line 467, `<div className="flex gap-2 items-end">`)
      renders `<VoiceButton />` as its first child, before the `<textarea>`, matching PRD 791's
      placement
- [ ] Confirm PRD 790's dormant-vs-live routing in voice.ts requires no MemoryNaturalPanel-specific
      changes — the panel's target tab may be a live/running terminal (not necessarily dormant
      Chat), and PRD 790's status-based branch should already handle both cases correctly with
      just the button wired up here; if it does not, note the gap rather than silently patching
      voice.ts again in this PRD (that would indicate PRD 790's AC was incomplete and should be
      flagged, not quietly worked around)
- [ ] Test coverage: VoiceButton renders in MemoryNaturalPanel's composer, and resolves/receives
      the correct tabId per whichever design the first AC line above settled on
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 300 npx vitest run` for whichever test files were touched passes

# Implementation notes

Read first: PRDs 790 and 791's actual landed diffs, src/renderer/components/tabs/MemoryNaturalPanel.tsx
in full (activeTabId source, composer JSX ~440-495), src/renderer/components/VoiceButton.tsx in
full, src/renderer/components/BroadcastBar.tsx and
src/renderer/components/tabs/editor/AssistantRail.tsx (read only, to confirm the out-of-scope
reasoning above still holds — do not modify either file).

# Out of scope

- BroadcastBar.tsx — multi-tab-target composer, no single coherent recording target, needs a
  product decision not made here
- AssistantRail.tsx — already has its own voice affordance (onListen), different established
  pattern, left untouched
- Any further voice.ts changes beyond what PRD 790 already landed

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
