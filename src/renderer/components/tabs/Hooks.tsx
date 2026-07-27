import { useMemo, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { SaveBar } from '../ui/SaveBar'
import { EmptyState } from '../ui/EmptyState'
import { Modal } from '../ui/Modal'
import { ScopeSwitcher } from '../ui/ScopeSwitcher'
import { ProvenanceBadge } from '../ui/ProvenanceBadge'
import { useConfig } from '../../state/config'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import { useScopedConfigFiles } from '../../lib/useScopedConfigFiles'
import { SETTINGS_SCOPES, type Scope } from '../../lib/scopes'
import { HooksLibrary } from './Library'
import { ViewTabs } from '../ui/ViewTabs'
import { EffectiveTree } from '../ui/EffectiveTree'
import { mergeScopes, getAtPath, setAtPath } from '../../lib/mergeScopes'
import { parseScopedJson } from '../../lib/parseScopedJson'
import { settingsSchema } from '../../lib/settingsSchema'
import { Tooltip } from '../ui/Tooltip'
import { HOOK_EVENT_DOCS } from '../../data/hookEventDocs'
import type { TestFireHookResult } from '../../../preload/api'

/**
 * Hooks tab — scalable event-list UI over settings.json `hooks` key.
 * Event list mirrors code.claude.com/docs/en/hooks (verified 2026-05). Legacy
 * tool-specific events (PreBash, PreEdit, etc.) were removed in 2026 and are
 * collapsed under an "unknown events" warning chip instead of cluttering the
 * sidebar.
 */
const HOOK_EVENTS = [
  // Core
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Stop',
  'StopFailure',
  'SessionStart',
  'SessionEnd',
  'Setup',
  'PreCompact',
  'PostCompact',
  'InstructionsLoaded',
  'Notification',
  // Permissions
  'PermissionRequest',
  'PermissionDenied',
  // Subagents/Teams
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  // Tasks
  'TaskCreated',
  'TaskCompleted',
  // State changes
  'ConfigChange',
  'CwdChanged',
  'FileChanged',
  // Worktree
  'WorktreeCreate',
  'WorktreeRemove',
  // Elicitation
  'Elicitation',
  'ElicitationResult',
] as const
type HookEvent = (typeof HOOK_EVENTS)[number]
const KNOWN_HOOK_EVENTS: ReadonlySet<string> = new Set(HOOK_EVENTS)

// Hook config shape per docs: { type, command|url|prompt|agent, args[], timeout, terminalSequence }
// `type: "mcp_tool"` added v2.1.118; `args` v2.1.139; `terminalSequence` v2.1.141.
const HOOK_TYPES = ['command', 'http', 'prompt', 'agent', 'mcp_tool'] as const
type HookType = (typeof HOOK_TYPES)[number]

// Minimal placeholder payloads used to seed the "Test fire" textarea per event.
// Where the doc doesn't specify a payload shape, we leave an empty object so
// the user starts from a documented unknown rather than a fabricated shape.
const DEFAULT_PAYLOADS: Record<HookEvent, Record<string, unknown>> = {
  UserPromptSubmit: { prompt: 'hello' },
  UserPromptExpansion: { command: '/example', expanded: 'hello' },
  PreToolUse: { tool_name: 'Bash', tool_input: { command: 'ls' } },
  PostToolUse: { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_result: '' },
  PostToolUseFailure: { tool_name: 'Bash', tool_input: { command: 'ls' }, error: '' },
  PostToolBatch: { tool_uses: [] },
  Stop: { stop_reason: 'end_turn', output_tokens: 0 },
  StopFailure: { reason: 'rate_limit' },
  SessionStart: { source: 'startup', model: '', agent_type: '' },
  SessionEnd: { reason: 'user_quit' },
  Setup: { mode: 'init' }, // payload: <unknown — see docs>
  PreCompact: { transcript_path: '', trigger: 'manual' },
  PostCompact: { transcript_path: '', trigger: 'manual' },
  InstructionsLoaded: { source: 'session_start' }, // payload: <unknown — see docs>
  Notification: { title: 'test', message: 'test notification' },
  PermissionRequest: { tool_name: 'Bash' }, // payload: <unknown — see docs>
  PermissionDenied: { tool_name: 'Bash', retry: false }, // payload: <unknown — see docs>
  SubagentStart: { agent_type: 'general-purpose' },
  SubagentStop: { agent_type: 'general-purpose', reason: 'end_turn' },
  TeammateIdle: {}, // payload: <unknown — see docs>
  TaskCreated: { task: { description: '' } },
  TaskCompleted: { task: { description: '' } },
  ConfigChange: { source: 'user_settings' },
  CwdChanged: { old_cwd: '', new_cwd: '' },
  FileChanged: { file_path: '', change_type: 'modified' },
  WorktreeCreate: {}, // payload: <unknown — see docs>
  WorktreeRemove: {}, // payload: <unknown — see docs>
  Elicitation: { action: 'accept' }, // payload: <unknown — see docs>
  ElicitationResult: {}, // payload: <unknown — see docs>
}

interface HookRule {
  type: HookType
  command?: string
  url?: string
  prompt?: string
  agent?: string
  /** mcp_tool name (e.g. `mcp__server__tool`) when `type === 'mcp_tool'`. */
  mcpTool?: string
  /** v2.1.139+ exec form — argv after `command` (no shell). */
  args?: string[]
  /** v2.1.141+ terminal escape sequence emitted with notifications (bells). */
  terminalSequence?: string
  matcher?: string
  timeout?: number
}

interface HookGroup {
  matcher?: string
  hooks: HookRule[]
}

type HooksConfig = Partial<Record<HookEvent, HookGroup[]>>

function parseFull(raw: string): { full: Record<string, unknown>; hooks: HooksConfig; err: string | null } {
  if (raw.trim() === '') return { full: {}, hooks: {}, err: null }
  try {
    const full = JSON.parse(raw) as Record<string, unknown>
    return { full, hooks: (full.hooks as HooksConfig) ?? {}, err: null }
  } catch (e) {
    return { full: {}, hooks: {}, err: (e as Error).message }
  }
}

function serialize(full: Record<string, unknown>, hooks: HooksConfig): string {
  return JSON.stringify({ ...full, hooks }, null, 2) + '\n'
}

function countFor(hooks: HooksConfig, ev: HookEvent): number {
  return (hooks[ev] ?? []).reduce((acc, g) => acc + (g.hooks?.length ?? 0), 0)
}

export function Hooks() {
  const home = useHomeDir()
  const activeTab = useActiveTab()
  const cwd = activeTab?.cwd ?? null
  const [scope, setScope] = useState<Scope>('user')
  const [selectedEvent, setSelectedEvent] = useState<HookEvent>('PreToolUse')
  const [view, setView] = useState<'effective' | 'events' | 'library'>('effective')

  const scopePaths = useScopedConfigFiles(SETTINGS_SCOPES, home, cwd)
  const path = scopePaths[scope] ?? null

  const files = useConfig((s) => s.files)
  const setDraft = useConfig((s) => s.setDraft)
  const saveJson = useConfig((s) => s.saveJson)
  const revert = useConfig((s) => s.revert)

  const [saveError, setSaveError] = useState<string | null>(null)
  const [testFire, setTestFire] = useState<{
    event: HookEvent
    matcher: string
    command: string
  } | null>(null)

  const viewTabs = (
    <ViewTabs
      options={[
        { key: 'effective', label: 'Effective' },
        { key: 'events', label: 'Events' },
        { key: 'library', label: 'Library' },
      ]}
      active={view}
      onChange={setView}
    />
  )

  const effective = useMemo(() => {
    const merged = mergeScopes(parseScopedJson(files, scopePaths))
    return getAtPath(merged, ['hooks']) ?? { kind: 'object' as const, children: {} }
  }, [files, scopePaths])

  const overrideInto = (nodePath: string[], value: unknown) => {
    const target = scopePaths[scope]
    if (!target) return
    setSaveError(null)
    const draft = files[target]?.draftRaw ?? ''
    let current: Record<string, unknown> = {}
    if (draft.trim()) {
      try {
        current = JSON.parse(draft) as Record<string, unknown>
      } catch {
        current = {}
      }
    }
    const nextHooks = setAtPath(current.hooks ?? {}, nodePath, value)
    const next = { ...current, hooks: nextHooks }
    setDraft(target, JSON.stringify(next, null, 2) + '\n')
  }

  if (!home) return <EmptyState title="loading…" />
  if (view === 'library') {
    return (
      <Panel toolbar={viewTabs}>
        <HooksLibrary />
      </Panel>
    )
  }
  if (scope !== 'user' && !cwd) {
    return (
      <Panel
        toolbar={
          <>
            {viewTabs}
            <span className="mx-2 text-fg-faint">·</span>
            <ScopeSwitcher scopes={['user', 'project', 'local']} active={scope} onChange={setScope} />
          </>
        }
      >
        <EmptyState title="no active project" />
      </Panel>
    )
  }
  if (!path) return <EmptyState title="loading…" />

  const file = files[path]
  const { full, hooks, err } = file ? parseFull(file.draftRaw) : { full: {}, hooks: {}, err: null }

  // Old 2025-era event names (PreBash etc.) silently disappear from the
  // documented sidebar; surface them in a single chip so users notice the
  // drift without us re-rendering deprecated UI.
  const unknownEvents = Object.keys(hooks).filter((k) => !KNOWN_HOOK_EVENTS.has(k))
  const unknownCount = unknownEvents.reduce(
    (acc, k) => acc + (hooks[k as HookEvent] ?? []).reduce((a, g) => a + (g.hooks?.length ?? 0), 0),
    0,
  )

  const updateHooks = (next: HooksConfig) => {
    setSaveError(null)
    setDraft(path, serialize(full, next))
  }

  const groups = hooks[selectedEvent] ?? []

  const addGroup = () => {
    updateHooks({
      ...hooks,
      [selectedEvent]: [...groups, { matcher: '', hooks: [{ type: 'command', command: '' }] }],
    })
  }
  const updateGroup = (idx: number, g: HookGroup) => {
    const next = groups.slice()
    next[idx] = g
    updateHooks({ ...hooks, [selectedEvent]: next })
  }
  const removeGroup = (idx: number) => {
    updateHooks({ ...hooks, [selectedEvent]: groups.filter((_, i) => i !== idx) })
  }

  return (
    <Panel
      toolbar={
        <>
          {viewTabs}
          <span className="mx-2 text-fg-faint">·</span>
          <ScopeSwitcher scopes={['user', 'project', 'local']} active={scope} onChange={setScope} />
          <span className="ml-3 text-fg-faint truncate">
            {view === 'effective' ? `overrides → ${path}` : path}
          </span>
          <div className="flex-1" />
          <a
            href="https://code.claude.com/docs/en/hooks"
            target="_blank"
            rel="noreferrer"
            className="text-fg-faint hover:text-fg-dim underline-offset-2 hover:underline"
          >
            hook reference ↗
          </a>
        </>
      }
      footer={
        file ? (
          <SaveBar
            dirty={file.dirty}
            busy={file.busy}
            parseError={saveError || err || file.parseError}
            lastSavedAt={file.lastSavedAt}
            onSave={async () => {
              setSaveError(null)
              const r = await saveJson(path)
              if (!r.ok) setSaveError(r.error ?? 'save failed')
            }}
            onRevert={() => {
              setSaveError(null)
              revert(path)
            }}
          />
        ) : null
      }
    >
      {view === 'effective' ? (
        <EffectiveTree
          node={effective}
          targetScope={scope}
          onOverride={overrideInto}
          schema={settingsSchema().rootedAt(['hooks'])}
          rootLabel="hooks"
        />
      ) : (
      <div className="flex flex-col h-full">
      {unknownCount > 0 ? (
        <div className="px-3 py-2 border-b border-line text-xs bg-bg-elev text-fg-dim">
          <span className="text-yellow-400">⚠</span> {unknownCount} hook(s) configured under
          unknown event names: <span className="font-mono text-fg">{unknownEvents.join(', ')}</span>
          <span className="text-fg-faint"> · these are ignored by Claude Code 2026; edit settings.json directly to remove.</span>
        </div>
      ) : null}
      <ListDetail
        sidebarWidth="14rem"
        sidebar={
          <div className="py-1">
            {HOOK_EVENTS.map((ev) => {
              const count = countFor(hooks, ev)
              const doc = HOOK_EVENT_DOCS[ev]
              const tip = doc ? (
                <span className="block space-y-1">
                  <span className="block text-fg">{doc.when}</span>
                  <span className="block text-fg-faint font-mono">payload: {doc.payload}</span>
                  {doc.example ? (
                    <span className="block text-fg-faint italic">e.g. {doc.example}</span>
                  ) : null}
                </span>
              ) : (
                <span className="text-fg-faint italic">no documentation yet</span>
              )
              return (
                <div key={ev} className="[&>span]:w-full">
                  <Tooltip content={tip} align="bottom-center">
                    <button
                      onClick={() => setSelectedEvent(ev)}
                      title={doc?.when}
                      className={`w-full text-left px-3 py-1 text-xs ${
                        selectedEvent === ev
                          ? 'bg-bg-hi text-fg'
                          : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="truncate">{ev}</span>
                        {count > 0 && <span className="text-accent shrink-0 ml-2">{count}</span>}
                      </div>
                      {doc ? (
                        <span className="block text-[11px] leading-[1.3] text-fg-faint/80 font-normal truncate">
                          {doc.when}
                        </span>
                      ) : (
                        <span className="block text-[11px] leading-[1.3] text-fg-faint/80 italic font-normal truncate">
                          no documentation yet
                        </span>
                      )}
                    </button>
                  </Tooltip>
                </div>
              )
            })}
          </div>
        }
        detail={
          <div className="p-4 space-y-3 max-w-3xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xs uppercase tracking-wider text-fg">{selectedEvent}</h3>
              <button
                onClick={addGroup}
                className="px-2 py-0.5 text-xs border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi"
              >
                + add group
              </button>
            </div>
            {groups.length === 0 ? (
              <div className="text-fg-faint text-xs">no hooks for this event</div>
            ) : (
              groups.map((g, i) => (
                <HookGroupEditor
                  key={i}
                  group={g}
                  jsonInvalid={!!err}
                  onChange={(next) => updateGroup(i, next)}
                  onRemove={() => removeGroup(i)}
                  onTestFire={(rule) =>
                    setTestFire({
                      event: selectedEvent,
                      matcher: g.matcher ?? '',
                      command: rule.command ?? '',
                    })
                  }
                />
              ))
            )}
          </div>
        }
      />
      </div>
      )}
      {testFire ? (
        <TestFireModal
          event={testFire.event}
          matcher={testFire.matcher}
          command={testFire.command}
          onClose={() => setTestFire(null)}
        />
      ) : null}
    </Panel>
  )
}

function HookGroupEditor({
  group,
  jsonInvalid,
  onChange,
  onRemove,
  onTestFire,
}: {
  group: HookGroup
  jsonInvalid: boolean
  onChange: (g: HookGroup) => void
  onRemove: () => void
  onTestFire: (rule: HookRule) => void
}) {
  const addHook = () =>
    onChange({
      ...group,
      hooks: [...(group.hooks ?? []), { type: 'command', command: '' }],
    })
  const updateHook = (idx: number, h: HookRule) => {
    const next = group.hooks.slice()
    next[idx] = h
    onChange({ ...group, hooks: next })
  }
  const removeHook = (idx: number) =>
    onChange({ ...group, hooks: group.hooks.filter((_, i) => i !== idx) })

  return (
    <div className="border border-line rounded p-3 bg-bg-elev space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-fg-faint w-16">matcher</span>
        <input
          value={group.matcher ?? ''}
          onChange={(e) => onChange({ ...group, matcher: e.target.value })}
          placeholder="tool name regex or exact match (optional)"
          className="flex-1 bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg font-mono"
        />
        <button
          onClick={onRemove}
          className="text-fg-faint hover:text-red-400 text-xs"
          title="remove group"
        >
          × group
        </button>
      </div>
      {(group.hooks ?? []).map((h, i) => (
        <HookRuleEditor
          key={i}
          rule={h}
          jsonInvalid={jsonInvalid}
          onChange={(next) => updateHook(i, next)}
          onRemove={() => removeHook(i)}
          onTestFire={() => onTestFire(h)}
        />
      ))}
      <button
        onClick={addHook}
        className="text-xs text-fg-faint hover:text-fg"
      >
        + add hook
      </button>
    </div>
  )
}

function HookRuleEditor({
  rule,
  jsonInvalid,
  onChange,
  onRemove,
  onTestFire,
}: {
  rule: HookRule
  jsonInvalid: boolean
  onChange: (r: HookRule) => void
  onRemove: () => void
  onTestFire: () => void
}) {
  const placeholderFor = (t: HookType) => ({
    command: 'e.g. node ./scripts/lint.js $FILE',
    http: 'e.g. https://hooks.example.com/notify',
    prompt: 'e.g. Review this change for security issues',
    agent: 'e.g. security-reviewer',
    mcp_tool: 'e.g. mcp__server__tool',
  })[t]
  const valueKey: keyof HookRule =
    rule.type === 'command'
      ? 'command'
      : rule.type === 'http'
        ? 'url'
        : rule.type === 'prompt'
          ? 'prompt'
          : rule.type === 'mcp_tool'
            ? 'mcpTool'
            : 'agent'
  const value = (rule[valueKey] as string | undefined) ?? ''
  const argsText = (rule.args ?? []).join(' ')
  const provInput = {
    type: 'hook' as const,
    name: value || rule.type,
    command: rule.type === 'command' ? rule.command : undefined,
    url: rule.type === 'http' ? rule.url : undefined,
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <select
          value={rule.type}
          onChange={(e) => onChange({ type: e.target.value as HookType })}
          className="bg-bg border border-line rounded px-1 py-0.5 text-xs text-fg"
        >
          {HOOK_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <ProvenanceBadge interactive={false} input={provInput} />
        <input
          value={value}
          onChange={(e) => onChange({ ...rule, [valueKey]: e.target.value })}
          placeholder={placeholderFor(rule.type)}
          className={`flex-1 bg-bg border rounded px-2 py-0.5 text-xs text-fg font-mono ${
            jsonInvalid ? 'border-red-500/70' : !value.trim() ? 'border-yellow-600/50' : 'border-line'
          }`}
        />
        {jsonInvalid ? (
          <span
            className="text-red-400 text-xs"
            title="The enclosing settings.json is malformed; fix the JSON before editing."
          >
            × invalid
          </span>
        ) : null}
        <input
          value={rule.timeout ?? ''}
          onChange={(e) =>
            onChange({ ...rule, timeout: e.target.value ? Number(e.target.value) : undefined })
          }
          placeholder="timeout ms"
          className="w-20 bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
        />
        {rule.type === 'command' ? (
          <button
            onClick={onTestFire}
            disabled={jsonInvalid || !value.trim()}
            className="px-2 py-0.5 text-xs border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi disabled:opacity-40 disabled:cursor-not-allowed"
            title="Run this command with a fake event payload"
          >
            test fire
          </button>
        ) : null}
        <button onClick={onRemove} className="text-fg-faint hover:text-red-400 text-xs">
          ×
        </button>
      </div>
      {rule.type === 'command' ? (
        <div className="flex items-center gap-2 pl-[3.75rem]">
          <span className="text-xs text-fg-faint w-12">args</span>
          <input
            value={argsText}
            onChange={(e) =>
              onChange({
                ...rule,
                args: e.target.value.trim()
                  ? e.target.value.split(/\s+/).filter(Boolean)
                  : undefined,
              })
            }
            placeholder="argv array (v2.1.139+ exec form, no shell)"
            className="flex-1 bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg font-mono"
          />
        </div>
      ) : null}
      <div className="flex items-center gap-2 pl-[3.75rem]">
        <span className="text-xs text-fg-faint w-12">term</span>
        <input
          value={rule.terminalSequence ?? ''}
          onChange={(e) =>
            onChange({ ...rule, terminalSequence: e.target.value || undefined })
          }
          placeholder="terminalSequence — e.g. \\a (bell), v2.1.141+"
          className="flex-1 bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg font-mono"
        />
      </div>
    </div>
  )
}

function defaultPayloadFor(event: HookEvent): string {
  return JSON.stringify(DEFAULT_PAYLOADS[event] ?? {}, null, 2)
}

// Best-effort matcher evaluation against a parsed payload. Claude Code's
// matcher is matched against tool_name (or similar) — we treat it as a regex
// when the string contains regex metacharacters and as exact otherwise. Empty
// matcher = always matches.
function evaluateMatcher(matcher: string, parsed: unknown): {
  matched: boolean
  target: string | null
  note?: string
} {
  if (!matcher.trim()) return { matched: true, target: null, note: 'empty matcher → matches all' }
  const target = (parsed && typeof parsed === 'object' && 'tool_name' in (parsed as Record<string, unknown>))
    ? String((parsed as Record<string, unknown>).tool_name ?? '')
    : null
  if (target == null) return { matched: false, target: null, note: 'payload has no tool_name to match against' }
  try {
    const re = new RegExp(`^(?:${matcher})$`)
    return { matched: re.test(target), target }
  } catch {
    return { matched: matcher === target, target, note: 'matcher not valid regex; fell back to exact match' }
  }
}

function TestFireModal({
  event,
  matcher,
  command,
  onClose,
}: {
  event: HookEvent
  matcher: string
  command: string
  onClose: () => void
}) {
  const [payload, setPayload] = useState<string>(() => defaultPayloadFor(event))
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TestFireHookResult | null>(null)
  const [matchInfo, setMatchInfo] = useState<{ matched: boolean; target: string | null; note?: string } | null>(null)

  let payloadParseErr: string | null = null
  try {
    JSON.parse(payload)
  } catch (e) {
    payloadParseErr = (e as Error).message
  }

  const run = async () => {
    setRunning(true)
    setResult(null)
    let parsed: unknown = null
    try { parsed = JSON.parse(payload) } catch { /* show err below */ }
    setMatchInfo(evaluateMatcher(matcher, parsed))
    try {
      const r = await window.api.app.testFireHook({ command, payload, timeoutMs: 5000 })
      setResult(r)
    } finally {
      setRunning(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={`Test fire — ${event}`}>
      <div className="space-y-3 text-xs">
        <div>
          <div className="text-fg-faint mb-1">resolved command</div>
          <div className="font-mono text-fg bg-bg border border-line rounded px-2 py-1 break-all">{command}</div>
        </div>
        <div>
          <div className="text-fg-faint mb-1">matcher</div>
          <div className="font-mono text-fg bg-bg border border-line rounded px-2 py-1">{matcher || <span className="text-fg-faint">(empty — matches all)</span>}</div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-fg-faint">fake event payload (stdin)</span>
            {payloadParseErr ? <span className="text-red-400">× {payloadParseErr}</span> : null}
          </div>
          <textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            rows={8}
            className={`w-full bg-bg border rounded px-2 py-1 font-mono text-fg ${payloadParseErr ? 'border-red-500/70' : 'border-line'}`}
          />
        </div>
        {matchInfo ? (
          <div>
            <div className="text-fg-faint mb-1">matcher result</div>
            <div className="font-mono">
              <span className={matchInfo.matched ? 'text-green-400' : 'text-red-400'}>
                {matchInfo.matched ? '✓ match' : '✗ no match'}
              </span>
              {matchInfo.target != null ? <span className="text-fg-dim"> · target tool_name=&quot;{matchInfo.target}&quot;</span> : null}
              {matchInfo.note ? <div className="text-fg-faint">{matchInfo.note}</div> : null}
            </div>
          </div>
        ) : null}
        {result ? (
          <div className="space-y-1">
            <div className="text-fg-faint">
              exit {result.exitCode} · {result.durationMs}ms
            </div>
            {result.stdout ? (
              <div>
                <div className="text-fg-faint">stdout</div>
                <pre className="bg-bg border border-line rounded p-2 font-mono text-fg whitespace-pre-wrap break-all max-h-40 overflow-auto">{result.stdout}</pre>
              </div>
            ) : null}
            {result.stderr ? (
              <div>
                <div className="text-fg-faint">stderr</div>
                <pre className="bg-bg border border-line rounded p-2 font-mono text-red-300 whitespace-pre-wrap break-all max-h-40 overflow-auto">{result.stderr}</pre>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-2 py-0.5 text-xs border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi"
          >
            close
          </button>
          <button
            onClick={run}
            disabled={running || !!payloadParseErr || !command.trim()}
            className="px-2 py-0.5 text-xs border border-line rounded text-fg hover:bg-bg-hi disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {running ? 'running…' : 'run'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

