---
title: Prompt Queue Detailed view: tags + full PRD-chain + follow-up sequence per item
cwd: ~/Projects/session-manager
estimateMinutes: 30
---
# Goal

Depends on PRDs 773-776, which must land first — read their actual landed diffs before starting (chainRootId field from 775, tag field from 774, and the primary-pane position from 776 all matter here). Now that QueueTicketPanel is the primary pane (PRD 776) and tickets carry a Feature/Bug tag (774) and can chain multiple PRDs under one root ticket (775), the panel itself is still just a flat list of ticket rows. This PRD adds a click-through Detailed view per ticket: clicking a ticket row (in either the flat list or a chain root) opens a view showing the original prompt text, its tag chip, every linked PRD from prdSlugs in order with its live scheduler status, and any follow-up prompts chained onto it (from PRD 775) with their own PRD references — giving the user a single place to see one initiative's full history instead of hunting across the Scheduler tab.

# Acceptance criteria

- [ ] ## Component
- [ ] New component (e.g. src/renderer/components/tabs/subagents-style co-location — place it near TerminalChat.tsx, e.g. src/renderer/components/TicketDetailView.tsx) renders when a ticket row is clicked: the original prompt text, its Feature/Bug tag chip (reusing PRD 774's chip rendering, not a second implementation), and an ordered list of every slug in prdSlugs
- [ ] Each listed PRD renders its live scheduler status using SchBadge from src/renderer/components/tabs/scheduler/sched-primitives.tsx (imported explicitly by name per this repo's Almanac single-source-of-truth convention — do not reimplement status-color logic), sourced from the existing schedule state store (src/renderer/state/scheduleState.ts) rather than a new poller
- [ ] Each listed PRD is clickable and opens it in the Scheduler tab, reusing the existing openPrdSlug function already used at TerminalChat.tsx:412-424 — do not duplicate that navigation logic
- [ ] Follow-up prompts chained onto this ticket (identified via PRD 775's chainRootId pointing at this ticket) render underneath, each showing its own text and its own linked PRD(s) from the chain
- [ ] A close/back control returns from the Detailed view to the ticket list without losing scroll position or existing chat state
- [ ] ## Tests
- [ ] Component test (e.g. src/renderer/components/__tests__/TicketDetailView.test.tsx) covers: a single-PRD chain with no follow-ups, a multi-PRD chain with follow-ups rendering in order, and the tag chip rendering for both feature and bug tags
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 300 npx vitest run src/renderer/components/__tests__/TicketDetailView.test.tsx passes

# Implementation notes

Read first: PRDs 773-776's actual landed diffs (field names for tag/chainRootId may have shifted slightly during their execution — verify against the real code, not this PRD's description of them), src/renderer/components/tabs/scheduler/sched-primitives.tsx (SchBadge, ProjectTag, DetailBlock/Line — reuse these, this is exactly the kind of shared list+detail UI CLAUDE.md's 'canonical list+detail shape' (Skills.tsx) describes), src/renderer/state/scheduleState.ts (job status lookup by slug), src/renderer/components/TerminalChat.tsx (openPrdSlug and the current ticket-row rendering after PRD 776's layout swap).

Editing a PRD from this view is explicitly out of scope — route to the existing Scheduler tab editor via openPrdSlug instead of building a second editing surface.

# Out of scope

- Editing PRD content from this view — use the existing Scheduler tab PRD editor via openPrdSlug
- Extending this Detailed view or an equivalent to the Scheduler tab itself — flagged as a natural follow-up PRD once this chain lands, not included here
- Mobile web-remote exposure of ticket/chain data

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
