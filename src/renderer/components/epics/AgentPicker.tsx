import type { AgentPersona } from '../../../preload/api'

/** Deterministic dot color per agent name, same hashed-palette idea
 *  sched-primitives.tsx's ProjectTag uses for project dots — a stable,
 *  content-derived color rather than a fixed per-row index (so the same
 *  persona always gets the same dot across renders/sessions). */
const AGENT_DOT_PALETTE = ['#b85c34', '#a3441f', '#6f7d52', '#8a7a60', '#7a6a8a', '#5f7a7d', '#c96442', '#4f7d72']
export function agentDot(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AGENT_DOT_PALETTE[h % AGENT_DOT_PALETTE.length]
}

/** Fixed department display order, mid-startup shape (decided 2026-08-02) —
 *  Engineering leads/executors first (most-picked), specialist reviewers
 *  fold into Engineering too (same department, narrower title), then the
 *  other functions in roughly headcount order for a small shop. Any
 *  persona whose `title` doesn't parse as "<Department> — <role>" (or has
 *  no title at all) falls into its own trailing "Other" group rather than
 *  being silently dropped. */
const DEPARTMENT_ORDER = ['Engineering', 'Product', 'Design', 'Quality', 'Platform', 'Growth']

/** Groups personas by the department prefix of their `title` field
 *  ("<Department> — <role>"), in DEPARTMENT_ORDER, with anything
 *  untitled/unrecognized collected into a trailing "Other" group. Pure —
 *  no IO, safe to call on every render. */
export function groupAgentsByDepartment(agents: AgentPersona[]): Array<{ department: string; agents: AgentPersona[] }> {
  const byDept = new Map<string, AgentPersona[]>()
  for (const a of agents) {
    const dept = a.title?.split(' — ')[0]?.trim() || 'Other'
    if (!byDept.has(dept)) byDept.set(dept, [])
    byDept.get(dept)!.push(a)
  }
  const known = DEPARTMENT_ORDER.filter((d) => byDept.has(d)).map((department) => ({ department, agents: byDept.get(department)! }))
  const unknown = [...byDept.keys()].filter((d) => !DEPARTMENT_ORDER.includes(d)).sort()
    .map((department) => ({ department, agents: byDept.get(department)! }))
  return [...known, ...unknown]
}

function roleOf(agent: AgentPersona): string | null {
  return agent.title?.split(' — ')[1] || agent.description || null
}

/**
 * Single-row agent dropdown for the New Session card. The visible row (dot ·
 * name · role · caret) is pure display; a transparent NATIVE `<select>` sits
 * on top of it so the OS supplies the popup, keyboard handling and a11y for
 * free — the New Epic card's scroll container and 3D flip transform would
 * otherwise clip a hand-rolled popover.
 */
export function AgentPicker({
  agents,
  value,
  onChange,
}: {
  agents: AgentPersona[]
  value: string
  onChange: (name: string) => void
}) {
  const selected = agents.find((a) => a.name === value) ?? agents[0] ?? null
  const groups = groupAgentsByDepartment(agents)

  return (
    <div
      data-testid="new-epic-agent-picker"
      className="relative focus-within:ring-1 focus-within:ring-accent-muted"
    >
      <div className="flex h-[42px] min-w-0 items-center gap-2.5 rounded-[10px] border border-line bg-bg px-3.5">
        {selected ? (
          <>
            <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: agentDot(selected.name) }} />
            <span className="font-mono text-[13px] font-semibold text-fg">{selected.name}</span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-faint">{roleOf(selected)}</span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-faint">No agents in library</span>
        )}
        <span className="flex-shrink-0 text-[11px] text-fg-faint">▾</span>
      </div>
      <select
        data-testid="new-epic-agent-select"
        aria-label="Agent"
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        value={selected?.name ?? ''}
        disabled={agents.length === 0}
        onChange={(e) => onChange(e.target.value)}
      >
        {groups.map(({ department, agents: deptAgents }) => (
          <optgroup key={department} label={department}>
            {deptAgents.map((a) => {
              const role = roleOf(a)
              return (
                <option
                  key={a.name}
                  value={a.name}
                  data-testid={`new-epic-agent-${a.name}`}
                  data-selected={a.name === selected?.name ? 'true' : 'false'}
                >
                  {role ? `${a.name} — ${role}` : a.name}
                </option>
              )
            })}
          </optgroup>
        ))}
      </select>
    </div>
  )
}
