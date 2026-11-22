// Bundle entry for the real-Chromium Scheduler Tasks screenshot spec (tasks-shots.spec.ts).
// Mounts the real TasksView for a fixed cwd over a stub window.api whose `tasks` namespace holds
// 7 Tasks across 2 pipelines and 3 runs: one imported (source 'direct'), one 'rate_limited',
// one 'slot_timeout', one 'error', and a detail body whose output is truncated. The
// 'Scripts may run Tasks' switch reads on. Nothing here touches a real disk.
import { createRoot } from 'react-dom/client'
import { TasksView } from '../../src/renderer/components/tabs/scheduler/TasksView'
import type { TaskDetail, TaskSummary } from '../../src/preload/api.d'

const CWD = '/home/user/Projects/burrow'
const at = (iso: string) => new Date(iso).toISOString()
const sha = (c: string) => c.repeat(64)

const TASKS: TaskSummary[] = [
  // Pipeline "blog-video", run r-1122a (newest).
  {
    taskId: 'tk-7f3a91', source: 'sm', status: 'ok', cwd: CWD, agent: 'demo-video-builder', model: 'sonnet', effort: 'medium',
    caller: { pipeline: 'blog-video', runId: 'r-1122a', step: 'script', attempt: 1 },
    startedAt: at('2026-11-22T17:42:10Z'), endedAt: at('2026-11-22T17:44:31Z'), durationMs: 141_000, slotWaitMs: 2_400,
    exitCode: 0, costUsd: 0.412, numTurns: 9, quota: { rateLimited: false, resetsAt: null },
    promptSha256: sha('a'), promptBytes: 1_842, outputSha256: sha('b'), outputBytes: 1_048_576 + 20_311,
  },
  {
    taskId: 'tk-6e2b80', source: 'sm', status: 'rate_limited', cwd: CWD, agent: 'demo-video-builder', model: 'opus', effort: 'high',
    caller: { pipeline: 'blog-video', runId: 'r-1122a', step: 'storyboard', attempt: 2 },
    startedAt: at('2026-11-22T17:31:02Z'), endedAt: at('2026-11-22T17:31:09Z'), durationMs: 7_200,
    exitCode: 1, costUsd: 0.003, quota: { rateLimited: true, resetsAt: at('2026-11-22T20:00:00Z') },
    error: 'usage limit reached', promptSha256: sha('c'), promptBytes: 922, outputSha256: sha('d'), outputBytes: 0,
  },
  {
    taskId: 'tk-5d1c7f', source: 'sm', status: 'slot_timeout', cwd: CWD, agent: 'demo-video-builder', model: 'sonnet',
    caller: { pipeline: 'blog-video', runId: 'r-1122a', step: 'render', attempt: 1 },
    startedAt: at('2026-11-22T17:20:45Z'), slotWaitSec: 600, durationMs: 600_000,
    error: 'no session slot free within 600s', promptSha256: sha('e'), promptBytes: 640,
  },
  // Pipeline "blog-video", run r-1121b (older).
  {
    taskId: 'tk-4c0d6e', source: 'direct', status: 'ok', cwd: CWD, agent: 'claude', model: 'haiku',
    caller: { pipeline: 'blog-video', runId: 'r-1121b', step: 'summary' }, importId: 'imp-1121',
    startedAt: at('2026-11-21T22:05:00Z'), endedAt: at('2026-11-21T22:05:18Z'), durationMs: 18_400,
    exitCode: 0, costUsd: 0.021, promptSha256: sha('f'), promptBytes: 412, outputSha256: sha('1'), outputBytes: 2_210,
  },
  {
    taskId: 'tk-3b9e5d', source: 'sm', status: 'ok', cwd: CWD, agent: 'demo-video-builder', model: 'sonnet',
    caller: { pipeline: 'blog-video', runId: 'r-1121b', step: 'script', attempt: 1 },
    startedAt: at('2026-11-21T21:50:12Z'), endedAt: at('2026-11-21T21:52:40Z'), durationMs: 148_300,
    exitCode: 0, costUsd: 0.388, promptSha256: sha('2'), promptBytes: 1_790, outputSha256: sha('3'), outputBytes: 9_402,
  },
  // Pipeline "digest", run d-1122.
  {
    taskId: 'tk-2a8f4c', source: 'sm', status: 'error', cwd: CWD, agent: 'claude', model: 'sonnet', effort: 'low',
    caller: { pipeline: 'digest', runId: 'd-1122', step: 'classify', attempt: 1 },
    startedAt: at('2026-11-22T15:10:00Z'), endedAt: at('2026-11-22T15:10:41Z'), durationMs: 41_000,
    exitCode: 2, costUsd: 0.054, error: 'envelope is_error: tool call failed', promptSha256: sha('4'), promptBytes: 3_100,
    outputSha256: sha('5'), outputBytes: 220,
  },
  {
    taskId: 'tk-1f7a3b', source: 'sm', status: 'ok', cwd: CWD, agent: 'claude', model: 'haiku', effort: 'low',
    caller: { pipeline: 'digest', runId: 'd-1122', step: 'fetch', attempt: 1 },
    startedAt: at('2026-11-22T15:08:30Z'), endedAt: at('2026-11-22T15:08:52Z'), durationMs: 22_100,
    exitCode: 0, costUsd: 0.009, promptSha256: sha('6'), promptBytes: 512, outputSha256: sha('7'), outputBytes: 4_880,
  },
]

const LONG_OUTPUT = [
  '# Script — "Burrow in 60 seconds"', '',
  ...Array.from({ length: 40 }, (_, i) => `Scene ${i + 1}: ${i % 2 ? 'cut to the terminal; the Task row lands in the ledger.' : 'voice-over names the step and its cost.'}`),
  '', '… (stored copy capped at 1 MiB)',
].join('\n')

const BODIES: Record<string, TaskDetail['body']> = {
  'tk-7f3a91': {
    taskId: 'tk-7f3a91', startedAt: TASKS[0].startedAt,
    prompt: 'Write a 60-second demo script for the Burrow blog post "Tasks, tracked".\nKeep each scene to one sentence.',
    output: LONG_OUTPUT, outputTruncated: true,
  },
}

const detail = (id: string): TaskDetail | null => {
  const t = TASKS.find((x) => x.taskId === id)
  if (!t) return null
  return { ...t, body: BODIES[id] ?? { taskId: id, prompt: `Prompt for ${id}.`, output: t.outputBytes ? `Output of ${id}.` : undefined } }
}

let switchOn = true
const api = {
  tasks: {
    list: async () => ({ ok: true as const, tasks: TASKS, total: TASKS.length, hasMore: false, skippedLines: 0 }),
    get: async ({ id }: { id: string }) => ({ ok: true as const, task: detail(id) }),
    getSwitch: async () => ({ ok: true as const, enabled: switchOn }),
    setSwitch: async ({ enabled }: { enabled: boolean }) => {
      switchOn = enabled
      return { ok: true as const, enabled, changedAt: new Date().toISOString() }
    },
  },
}

// Anything TasksView reaches for that the fixture doesn't model resolves harmlessly — and is
// logged, so a new dependency shows up in the spec's console capture instead of crashing the mount.
function fallback(target: any, path: string): any {
  return new Proxy(target, {
    get(t, k) {
      if (typeof k === 'symbol' || k in t) {
        const v = t[k as any]
        return v && typeof v === 'object' ? fallback(v, `${path}.${String(k)}`) : v
      }
      console.warn(`[stub-api] unmodelled window.api${path}.${String(k)}`)
      return fallback(async () => undefined, `${path}.${String(k)}`)
    },
  })
}
;(window as any).api = fallback(api, '')

createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh' }}>
    <TasksView scopeCwd={CWD} />
  </div>,
)
