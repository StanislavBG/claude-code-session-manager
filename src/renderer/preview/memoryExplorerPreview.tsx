// Dev-only browser harness for the Memory Explorer: mounts the real component against a fixture
// `window.api` built from the Claude Design prototype data. Served by the Vite dev server only
// (not a build input). Driven by scripts/memory-explorer-shots.mjs.
import ReactDOM from 'react-dom/client'
import { MemoryExplorer } from '../components/tabs/memory/explorer/MemoryExplorer'
import type {
  MemoryAgent,
  MemoryAggregateResult,
  MemoryListResult,
  MemoryStaleEntry,
  MemoryStaleResult,
  MemoryTarget,
} from '../../preload/api'
import '../styles.css'

const CWD = '~/Projects/session-manager'
const DIR = '~/.claude/projects/-home-bilko-Projects-session-manager/memory'
const DAY = 86_400_000

const CL = {
  sched: { name: 'Scheduler diagnosis & stability', desc: 'Root causes and diagnostics for scheduler freezes, stalls, wedges and idle-with-queue symptoms.' },
  review: { name: 'Needs-review & worktree recovery', desc: 'How parked needs_review rows, worktree failures and cwd hazards stall chains — and how to unblock them.' },
  feedback: { name: 'Working-style feedback', desc: 'Corrections and preferences: when to commit, publish, queue work and end turns.' },
  bilko: { name: 'Bilko & marketing', desc: 'Where the bilko.run site, checkout and pricing actually live.' },
  infra: { name: 'Tooling & test infra', desc: 'Test harnesses, env-sensitive gotchas and Claude Code references.' },
} as const
type ClKey = keyof typeof CL

// slug, cluster, size, age (days), stale, description
const M_RAW: [string, ClKey, string, number, 0 | 1, string][] = [
  ['bilko_run_marketing_repo', 'bilko', '3.6 KB', 16, 1, 'bilko.run marketing/purchase pages live in ~/Projects/Bilko, not this repo.'],
  ['billing_usage_api', 'bilko', '2.5 KB', 29, 1, 'Usage metering endpoint shape and where invoices are generated.'],
  ['claude_code_reference', 'infra', '6.3 KB', 190, 1, 'Flags, hook names and settings paths for Claude Code.'],
  ['claude_design_link_access', 'infra', '1.6 KB', 17, 1, 'How design links are authorised for headless runs.'],
  ['claude_projects_scan_cost', 'sched', '1.6 KB', 29, 1, 'Scanning ~/.claude/projects on every tick is the main idle CPU cost.'],
  ['cross_project_prd_authoring', 'feedback', '1.4 KB', 35, 0, 'Write PRDs in the repo that owns the change, not the caller.'],
  ['develop_loop_calibration', 'infra', '2.6 KB', 20, 1, 'Timeouts and retry counts tuned for the develop loop.'],
  ['e2e_test_infra', 'infra', '1.9 KB', 176, 0, 'Playwright harness layout and how fixtures are seeded.'],
  ['env_sensitive_test_gotcha', 'infra', '883 B', 80, 0, 'Two tests pass locally only because TZ is set.'],
  ['false_rate_limit_pause', 'sched', '1.1 KB', 1, 0, 'Pauses that look like 429s are actually meter refreshes.'],
  ['feedback_always_commit_after_edit', 'feedback', '2.1 KB', 71, 0, 'Commit after every verified edit; never leave a dirty tree.'],
  ['feedback_dont_end_turns_with_questions', 'feedback', '1.4 KB', 29, 0, 'Finish the work; ask only when truly blocked.'],
  ['feedback_dont_file_product_work_at_host', 'feedback', '1.4 KB', 29, 1, 'Product work belongs in the product repo, not the host.'],
  ['feedback_git_publish_autonomy', 'feedback', '1.8 KB', 72, 0, 'Push and publish without asking once checks pass.'],
  ['feedback_queue_by_default', 'feedback', '1.3 KB', 92, 0, 'Queue follow-ups as jobs rather than doing them inline.'],
  ['job_runtime_profile', 'sched', '1.3 KB', 29, 1, 'Typical job durations; anything over 3× is a stall.'],
  ['mac_scheduler_v096_liveness_fixes', 'sched', '2.8 KB', 18, 0, 'Liveness fixes shipped in v0.96 for the mac scheduler.'],
  ['mechanical_recovery_content_conflict', 'review', '2.2 KB', 23, 1, 'Recovering when a worktree merge leaves conflict markers.'],
  ['meter_429_idles_scheduler', 'sched', '1.4 KB', 3, 0, 'A 429 from the meter pauses dispatch with nothing to re-arm it.'],
  ['mutate_reentrant_deadlock', 'sched', '1.4 KB', 17, 0, 'Re-entrant mutate() calls deadlock the state lock.'],
  ['needs_review_chain_stall', 'review', '2.8 KB', 29, 1, 'Parked needs_review rows silently stall the whole chain.'],
  ['needs_review_not_in_history', 'review', '1.4 KB', 29, 1, 'needs_review rows are missing from the history view.'],
  ['reverify_heals_on_foreign_commit', 'review', '1.2 KB', 6, 0, 'Re-verify succeeds when another agent committed the fix.'],
  ['scheduler_dispatch_has_no_driver', 'sched', '2.0 KB', 5, 0, 'Once the tick loop exits, nothing drives dispatch.'],
  ['scheduler_stability_chain', 'sched', '3.1 KB', 4, 0, 'The PRD chain that retires most scheduler stall memories.'],
  ['worktree_cwd_ops_root_hazard', 'review', '1.7 KB', 9, 0, 'Ops run from the root checkout clobber worktree state.'],
]
const R: [string, string, 'retires' | 'related'][] = [
  ['scheduler_stability_chain', 'scheduler_dispatch_has_no_driver', 'retires'],
  ['scheduler_stability_chain', 'needs_review_chain_stall', 'retires'],
  ['scheduler_stability_chain', 'job_runtime_profile', 'retires'],
  ['scheduler_dispatch_has_no_driver', 'meter_429_idles_scheduler', 'related'],
  ['meter_429_idles_scheduler', 'job_runtime_profile', 'related'],
  ['mutate_reentrant_deadlock', 'scheduler_stability_chain', 'related'],
  ['mac_scheduler_v096_liveness_fixes', 'job_runtime_profile', 'related'],
  ['mac_scheduler_v096_liveness_fixes', 'scheduler_dispatch_has_no_driver', 'related'],
  ['claude_projects_scan_cost', 'scheduler_dispatch_has_no_driver', 'related'],
  ['claude_projects_scan_cost', 'feedback_dont_file_product_work_at_host', 'related'],
  ['needs_review_not_in_history', 'needs_review_chain_stall', 'related'],
  ['needs_review_chain_stall', 'worktree_cwd_ops_root_hazard', 'related'],
  ['mechanical_recovery_content_conflict', 'needs_review_chain_stall', 'related'],
  ['reverify_heals_on_foreign_commit', 'needs_review_chain_stall', 'related'],
  ['bilko_run_marketing_repo', 'feedback_queue_by_default', 'related'],
  ['billing_usage_api', 'bilko_run_marketing_repo', 'related'],
  ['cross_project_prd_authoring', 'bilko_run_marketing_repo', 'related'],
  ['false_rate_limit_pause', 'meter_429_idles_scheduler', 'related'],
]
const AG: Record<string, string[]> = {
  'code-reviewer': ['feedback_always_commit_after_edit', 'feedback_git_publish_autonomy', 'env_sensitive_test_gotcha', 'e2e_test_infra', 'cross_project_prd_authoring', 'claude_code_reference', 'feedback_dont_end_turns_with_questions', 'develop_loop_calibration'],
  'release-bot': ['feedback_git_publish_autonomy', 'bilko_run_marketing_repo', 'billing_usage_api', 'mac_scheduler_v096_liveness_fixes'],
  'scheduler-ops': ['meter_429_idles_scheduler', 'scheduler_dispatch_has_no_driver', 'scheduler_stability_chain', 'mutate_reentrant_deadlock', 'job_runtime_profile', 'false_rate_limit_pause', 'claude_projects_scan_cost', 'mac_scheduler_v096_liveness_fixes', 'needs_review_chain_stall', 'worktree_cwd_ops_root_hazard', 'reverify_heals_on_foreign_commit'],
  'docs-writer': [],
}
const AGENT_META: MemoryAgent[] = [
  { name: 'code-reviewer', origin: 'user', memoryScope: 'user', agentFile: '~/.claude/agents/code-reviewer.md' },
  { name: 'release-bot', origin: 'project', memoryScope: 'project', agentFile: '.claude/agents/release-bot.md' },
  { name: 'scheduler-ops', origin: 'user', memoryScope: 'user', agentFile: '~/.claude/agents/scheduler-ops.md' },
  { name: 'docs-writer', origin: 'project', memoryScope: 'project', agentFile: '.claude/agents/docs-writer.md' },
]
const BROKEN_PATHS: Record<string, string[]> = {
  bilko_run_marketing_repo: ['~/Projects/bilko-run/', 'design-mocks/landing-v2/'],
  claude_code_reference: ['docs/hooks-reference.md'],
  develop_loop_calibration: ['scripts/develop-loop.sh'],
  mechanical_recovery_content_conflict: ['src/main/lib/worktreeRecovery.cjs'],
}
const VERIFY_LINE = 'claim checked against commit a41c2e0'
const VERIFY_FIXED = 'still true at HEAD 9b2f71d, wording refreshed'
const FIX_PAIRS: [string, string][] = [
  ['~/Projects/bilko-run/', '~/Projects/Bilko/   (matched by package name)'],
  ['design-mocks/landing-v2/', 'removed, shipped in 65c8ef6'],
]
const ASK_DEFAULT = {
  answer: 'Three memories point to the same chain. A 429 from the meter paused dispatch, but nothing re-armed it, because the dispatcher has no driver once the tick loop exits. A separate deadlock in mutate() could freeze it the same way.',
  citations: ['meter_429_idles_scheduler', 'scheduler_dispatch_has_no_driver', 'mutate_reentrant_deadlock', 'job_runtime_profile'],
}

interface Mem {
  slug: string
  cluster: ClKey
  bytes: number
  mtimeMs: number
  description: string
  body: string
  deadRefs: string[]
  stale: boolean
  verifiedNote: boolean
}

const T0 = Date.now()
const parseBytes = (s: string): number => {
  const n = parseFloat(s)
  return s.endsWith('KB') ? Math.round(n * 1024) : Math.round(n)
}

const mems = new Map<string, Mem>()
const archived = new Set<string>()
for (const [slug, cluster, size, days, stale, description] of M_RAW) {
  const links = R.filter((r) => r[0] === slug)
  const deadRefs = BROKEN_PATHS[slug] ?? []
  const lines = [
    '**Why:** Learned the hard way; the cost of forgetting it recurs.', '',
    '**How to apply:** Check this before touching the area it describes.',
  ]
  if (deadRefs.length) {
    lines.push('', 'Paths:')
    if (slug === 'bilko_run_marketing_repo') lines.push(...FIX_PAIRS.map((p) => p[0]))
    else lines.push(...deadRefs)
  } else if (stale) lines.push('', VERIFY_LINE)
  if (links.length) {
    lines.push('')
    for (const l of links) lines.push(l[2] === 'retires' ? `Retires [[${l[1]}]].` : `See also [[${l[1]}]].`)
  }
  mems.set(slug, {
    slug, cluster, bytes: parseBytes(size), mtimeMs: T0 - days * DAY, description,
    body: lines.join('\n'), deadRefs, stale: !!stale, verifiedNote: deadRefs.length === 0,
  })
}

const stem = (n: string): string => n.replace(/\.md$/, '')
const fileOf = (m: Mem): string =>
  `---\nname: ${m.slug.replace(/_/g, '-')}\ndescription: "${m.description}"\nmetadata:\n  node_type: memory\n  type: project\n  originSessionId: de0e5dbe-8abe-4fec-a9a4-e667767ccbd9\n---\n\n${m.body}\n`
const linksOf = (m: Mem): string[] =>
  [...m.body.matchAll(/\[\[([^\]]+)\]\]/g)].map((x) => x[1])
const staleReason = (m: Mem): string =>
  m.deadRefs.length
    ? `references ${m.deadRefs.length} path${m.deadRefs.length > 1 ? 'es' : ''} that no longer exist`
    : `not re-verified in ${Math.floor((Date.now() - m.mtimeMs) / DAY)} days`
const slugsFor = (t?: MemoryTarget): string[] =>
  t?.agent ? (AG[t.agent.name] ?? []).filter((s) => mems.has(s)) : [...mems.keys()].filter((s) => !archived.has(s))
const ok = { ok: true, error: null }

const memory = {
  async list(t?: MemoryTarget): Promise<MemoryListResult> {
    const dir = t?.agent ? `~/.claude/agents/${t.agent.scope}/memory/${t.agent.name}` : DIR
    const entries = slugsFor(t).map((s) => {
      const m = mems.get(s)!
      return { name: `${s}.md`, path: `${dir}/${s}.md`, mtimeMs: m.mtimeMs, bytes: m.bytes }
    })
    return { entries, workspace: t?.workspace ?? 'default', dir, autoMemoryEnabled: true, error: null }
  },
  async read(name: string) {
    const m = mems.get(stem(name))
    if (!m) return { content: '', exists: false, mtimeMs: 0, bytes: 0, error: 'not found' }
    return { content: fileOf(m), exists: true, mtimeMs: m.mtimeMs, bytes: m.bytes, error: null }
  },
  async write(name: string, content: string) {
    const slug = stem(name)
    const m = mems.get(slug)
    if (!m) return { ok: false, error: 'not found' }
    const desc = /^description:\s*"?(.*?)"?\s*$/m.exec(content)?.[1]
    if (desc) m.description = desc
    m.body = content.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').replace(/^\n+/, '').replace(/\n$/, '')
    m.mtimeMs = Date.now()
    m.bytes = content.length
    if (m.deadRefs.length && m.deadRefs.every((d) => !m.body.includes(d))) { m.deadRefs = []; m.stale = false }
    else if (m.verifiedNote && m.stale && !m.body.includes(VERIFY_LINE)) m.stale = false
    return ok
  },
  async delete(name: string) {
    mems.delete(stem(name)); archived.delete(stem(name))
    return ok
  },
  async create(name: string, description?: string) {
    const slug = stem(name)
    mems.set(slug, {
      slug, cluster: 'infra', bytes: 120, mtimeMs: Date.now(), description: description ?? '',
      body: '', deadRefs: [], stale: false, verifiedNote: true,
    })
    return ok
  },
  async aggregate(workspace: string): Promise<MemoryAggregateResult> {
    const clusters = (Object.keys(CL) as ClKey[]).map((id) => {
      const memberSlugs = [...mems.values()].filter((m) => m.cluster === id && !archived.has(m.slug)).map((m) => m.slug)
      const links = R.filter((r) => memberSlugs.includes(r[0]) && memberSlugs.includes(r[1]))
        .map(([from, to, label]) => ({ from, to, label }))
      return { id, name: CL[id].name, summary: CL[id].desc, memberSlugs, links }
    })
    return { workspace, generatedAt: T0 - 2 * DAY, clusters, orphans: [], cached: true }
  },
  async stale(t?: MemoryTarget): Promise<MemoryStaleResult> {
    const slugs = slugsFor(t)
    const entries: MemoryStaleEntry[] = slugs.map((s) => {
      const m = mems.get(s)!
      return {
        name: `${s}.md`,
        ageDays: Math.floor((Date.now() - m.mtimeMs) / DAY),
        inboundLinks: [...mems.values()].filter((x) => linksOf(x).includes(s)).length,
        deadRefs: m.deadRefs,
        stale: m.stale,
        reasons: m.stale ? [staleReason(m)] : [],
        description: m.description,
        type: 'project',
        originSessionId: 'de0e5dbe-8abe-4fec-a9a4-e667767ccbd9',
        outLinks: linksOf(m),
        danglingLinks: [],
      }
    })
    const index = { lines: 38, bytes: 5230, maxLines: 200, maxBytes: 25600, overBudget: false, nearBudget: false, orphans: [], dangling: [] }
    return { entries, workspace: t?.workspace ?? 'default', error: null, index }
  },
  async agents() { return { agents: AGENT_META } },
  async verify(name: string) {
    const m = mems.get(stem(name))
    if (m) { m.stale = false; m.mtimeMs = Date.now() }
    return ok
  },
  async archive(name: string) { archived.add(stem(name)); return ok },
  async restore(name: string) { archived.delete(stem(name)); return ok },
  async listArchived() { return { names: [...archived].map((s) => `${s}.md`), error: null } },
  async ask(input: { question: string; contextName?: string }) {
    await new Promise((r) => setTimeout(r, 300))
    const ctx = input.contextName ? mems.get(stem(input.contextName)) : undefined
    if (!ctx) return { ok: true, ...ASK_DEFAULT }
    const days = Math.floor((Date.now() - ctx.mtimeMs) / DAY)
    const answer = `${ctx.slug} was last written ${days}d ago. ` + (ctx.stale
      ? `It is flagged stale: ${staleReason(ctx)}. Open it and use Fix with assistant to repoint it.`
      : 'Everything it references still resolves at HEAD, so it reads as accurate.')
    return { ok: true, answer, citations: [ctx.slug] }
  },
  async proposeFix(input: { name: string }) {
    await new Promise((r) => setTimeout(r, 300))
    const m = mems.get(stem(input.name))
    if (!m) return { ok: false, content: '', summary: '', error: 'not found' }
    let content = fileOf(m)
    if (m.slug === 'bilko_run_marketing_repo') {
      for (const [a, b] of FIX_PAIRS) content = content.replace(a, b)
      return { ok: true, content, summary: 'Repointed 2 stale paths' }
    }
    content = content.replace(VERIFY_LINE, VERIFY_FIXED)
    return { ok: true, content, summary: 'Refreshed 1 claim' }
  },
}

// Everything else the shell touches (voice, config watch, clipboard, shell, …) is a no-op:
// `on*` subscribers return an unsubscribe fn, anything else resolves undefined.
const noop = (prop: string) => (prop.startsWith('on') ? () => () => undefined : async () => undefined)
const overrides: Record<string, Record<string, unknown>> = {
  memory,
  config: { watch: async () => undefined, unwatch: async () => undefined, onChanged: () => () => undefined },
  clipboard: { writeText: async () => undefined },
  shell: { open: async () => undefined },
}
const ns = (name: string) =>
  new Proxy(overrides[name] ?? {}, { get: (t, p: string) => (p in t ? t[p] : noop(p)) })
;(window as unknown as { api: unknown }).api = new Proxy({}, { get: (_t, p: string) => ns(p) })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div style={{ width: 1320, height: 900, position: 'relative', overflow: 'hidden' }}>
    <MemoryExplorer cwd={CWD} />
  </div>,
)
