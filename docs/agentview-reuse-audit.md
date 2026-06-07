# AgentView Reuse Audit

Scope: `src/renderer/components/tabs/AgentView.tsx` (no `agent/` subdirectory exists).

## Findings table

| Datum | Agent-View source | Canonical source | Verdict | Action |
|---|---|---|---|---|
| Billing fetch result | `useBilling((s) => s.data)` — line 61 | `state/billing.ts` → `useBilling` | REUSE | — |
| 5-hour utilization % | `getFiveHourUtil(billing)` — line 62 | `state/billing.ts` → `getFiveHourUtil` | REUSE | — |
| Per-tab todos / tool uses / plans / agents / activity ring / lastEventAt | `useLiveTab(tab)` — line 59 | `state/live.ts` → `useLiveTab` | REUSE | — |
| Scheduler jobs array | `useState<ScheduleJob[]>` + own `useEffect` calling `window.api.schedule.state()` and `window.api.schedule.onState(...)` — lines 70–78 | `state/scheduleState.ts` → `useScheduleState` | **DUPLICATE** | Replace with `useScheduleState` selector; delete local state + effect |
| Age label for activity feed entries | Local `formatAge(ms)` — lines 432–437 | `lib/formatTime.ts` → `formatRelative(ms)` | **DUPLICATE** | Delete `formatAge`; import and call `formatRelative` |
| Usage matrix | Not referenced | `state/usageMatrix.ts` → `useUsageMatrix` | N/A (not displayed) | — |
| `Panel` layout shell | Local `Panel({ title, subtitle, children })` — lines 211–233 | `components/ui/Panel.tsx` → `Panel({ toolbar, footer, children })` | NOT a duplicate — different API (serif heading + subtitle vs generic toolbar/footer slots) | — |
| Empty state hint | Local `EmptyHint({ children })` — lines 428–430 | `components/ui/EmptyState.tsx` → `EmptyState({ title, hint })` | NOT a duplicate — EmptyHint is inline/italic; EmptyState is centered fullscreen | — |

## Duplicate details

### 1. Scheduler jobs — DUPLICATE

**AgentView source** (`AgentView.tsx` lines 70–78):
```tsx
const [schedulerJobs, setSchedulerJobs] = useState<ScheduleJob[]>([])
useEffect(() => {
  let cancelled = false
  window.api.schedule.state().then((snap: ScheduleStateSnapshot) => {
    if (!cancelled) setSchedulerJobs(snap.jobs)
  }).catch(() => { /* ignore */ })
  const off = window.api.schedule.onState((snap) => setSchedulerJobs(snap.jobs))
  return () => { cancelled = true; off() }
}, [])
```

**Canonical source** (`state/scheduleState.ts`):
> "Before: 5 components (SchedulePanel, Overview, SchedulerPrdsView, LeftNav, AgentView) each opened their own `window.api.schedule.onState(...)` subscription."

The consolidation module names AgentView explicitly but AgentView was never migrated.

**Fix applied**: Deleted lines 70–78 and the now-unused `import type { ScheduleJob, ScheduleStateSnapshot }`. Added `import { useScheduleState } from '../../state/scheduleState'` and `const schedulerJobs = useScheduleState((s) => s.snapshot?.jobs ?? [])`.

### 2. `formatAge` — DUPLICATE

**AgentView source** (`AgentView.tsx` lines 432–437):
```ts
function formatAge(ms: number): string {
  if (ms < 1000) return 'now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}
```

**Canonical source** (`lib/formatTime.ts` → `formatRelative`):
```ts
export function formatRelative(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
}
```

Minor behavioral differences (both acceptable):
- `ms < 1000`: `formatAge` → `'now'`, `formatRelative` → `'0s'`
- `ms = 2h30m`: `formatAge` → `'2h'`, `formatRelative` → `'2h 30m'`

Both are valid for the Activity feed's age labels. The canonical output is more precise.

**Fix applied**: Deleted `formatAge`. Added `formatRelative` to the existing `lib/formatTime` import. All `formatAge(...)` call sites updated to `formatRelative(...)`.
