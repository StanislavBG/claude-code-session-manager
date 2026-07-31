---
title: Move UsageMeters widget into Home tab; remove the Usage nav destination
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

The Usage tab is overloaded; the only widget the user finds useful is the billing meters card (`UsageMeters` — plan name chip, Session 5-hour bar with reset time, Weekly bar with reset time). Move that card into the Home tab and remove the Usage nav destination entirely. Backend cleanup of the now-dead usage-matrix pipeline is a follow-up PRD (785).

# Acceptance criteria

## Core functionality

- [ ] `UsageMeters` renders inside `src/renderer/components/tabs/Home.tsx` as a card, fed by the same `state/billing.ts` store the Usage tab used (`useBilling`/`refreshBilling`/`getBillingData` — see `Usage.tsx:7` and its render at `Usage.tsx:75`); Home already reads billing (`Home.tsx:~112`) so reuse its existing data flow rather than duplicating fetch logic
- [ ] `src/renderer/components/tabs/usage/UsageMeters.tsx` and `usage-primitives.tsx` survive (move them to a sensible location if `tabs/usage/` is otherwise deleted, e.g. `components/tabs/home/` or `components/ui/` — update importers)
- [ ] Deleted: `src/renderer/components/tabs/Usage.tsx`, `tabs/usage/TopologyHeader.tsx`, `tabs/usage/SessionMatrix.tsx`, `tabs/usage/AlertsStrip.tsx`
- [ ] `'usage'` nav destination removed from: `navGroups.ts` NAV_ITEMS, `LeftNav.tsx` NavKey union, `App.tsx` SCREEN_KEYS, `MainPane.tsx` routing, `CommandPalette.tsx`, `slashCommand.ts` mapping (+ its test if it references 'usage'), `learningContent.ts` (remove the 'usage' block so `Record<NavKey,...>` typechecks), `AlmanacIcon.tsx` 'usage' icon if unused after
- [ ] `AlmanacFooter.tsx:76` — the 5h-usage pill's `onNavigate?.('usage')` retargets to `'overview'` (Home, where the meters now live); pill itself stays
- [ ] `tests/e2e/tabs-smoke.spec.ts` 'usage' entry removed from the tab list

## Interaction / integration

- [ ] `state/billing.ts` untouched (AlmanacFooter and Home still consume it)
- [ ] `state/usageMatrix.ts` NOT deleted yet (PRD 785) — it just loses its last consumer here
- [ ] `BillingStatusOverlay`/`BillingStatusBanner` usage: if only Usage.tsx mounted the overlay, move it alongside UsageMeters into Home so billing fetch errors stay visible (Toast conventions: don't swallow errors)

## Tests

- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 600 npm run test:unit` passes

# Implementation notes

Serial after PRDs 781-783 (they edit the same nav files: navGroups, LeftNav, App, MainPane, CommandPalette, learningContent, tabs-smoke). What 781 delivered there: the `'subagents'` key is already gone; apply the same removal pattern for `'usage'`. Line numbers predate that chain — re-grep.

Place the meters card prominently near the top of Home's layout (Home is `key: 'overview'`, label "Home"). Match Home's existing card styling (Panel / CARD conventions) rather than inventing a new frame. Keep `UsageMeters.tsx` itself unmodified except its import path for `tierTone`.

CLAUDE.md: update the AlmanacFooter bullet ("Pills navigate to Settings / Usage / Scheduler") and any Usage-tab references.

# Out of scope

- Deleting `state/usageMatrix.ts`, `src/main/usageMatrix.cjs`, its IPC registration and transcripts.cjs coupling — PRD 785
- Redesigning Home beyond adding this card
- Subagents-chain work (PRDs 781-783)

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
