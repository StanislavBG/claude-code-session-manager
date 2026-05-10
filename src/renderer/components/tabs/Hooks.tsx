import { useEffect, useMemo, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { SaveBar } from '../ui/SaveBar'
import { EmptyState } from '../ui/EmptyState'
import { Modal } from '../ui/Modal'
import { ScopeSwitcher } from '../ui/ScopeSwitcher'
import { useConfig } from '../../state/config'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import { SETTINGS_SCOPES, type Scope } from '../../lib/scopes'
import { HooksLibrary } from './Library'
import { ViewTabs } from '../ui/ViewTabs'
import { EffectiveTree } from '../ui/EffectiveTree'
import { mergeScopes, getAtPath, setAtPath } from '../../lib/mergeScopes'
import { parseScopedJson } from '../../lib/parseScopedJson'
import { settingsSchema } from '../../lib/settingsSchema'
import type { TestFireHookResult } from '../../../preload/api'

/**
 * Hooks tab — scalable event-list UI over settings.json `hooks` key.
 * Claude Code supports 26 hook events (Apr 2026) and 4 hook types
 * (command, http, prompt, agent).
 */
const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
  'PostCompact',
  'PreBash',
  'PostBash',
  'PreEdit',
  'PostEdit',
  'PreRead',
  'PostRead',
  'PreWrite',
  'PostWrite',
  'PreGlob',
  'PreGrep',
  'PreTaskCreate',
  'PreTaskUpdate',
  'PreWebFetch',
  'PreWebSearch',
  'PreMcpToolUse',
  'PostMcpToolUse',
] as const
type HookEvent = (typeof HOOK_EVENTS)[number]

const HOOK_TYPES = ['command', 'http', 'prompt', 'agent'] as const
type HookType = (typeof HOOK_TYPES)[number]

// Minimal placeholder payloads used to seed the "Test fire" textarea per event.
// Aim is "smallest valid-shape JSON the hook is likely to receive" so the user
// can edit from a sensible starting point rather than typing from scratch.
const DEFAULT_PAYLOADS: Record<HookEvent, Record<string, unknown>> = {
  PreToolUse: { tool_name: 'Bash', tool_input: { command: 'ls' } },
  PostToolUse: { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_result: '' },
  UserPromptSubmit: { prompt: 'hello' },
  Notification: { title: 'test', message: 'test notification' },
  Stop: { reason: 'end_turn' },
  SubagentStop: { reason: 'end_turn' },
  SessionStart: { source: 'startup' },
  SessionEnd: { reason: 'user_quit' },
  PreCompact: { transcript_path: '' },
  PostCompact: { transcript_path: '' },
  PreBash: { tool_input: { command: 'ls' } },
  PostBash: { tool_input: { command: 'ls' }, tool_result: '' },
  PreEdit: { tool_input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' } },
  PostEdit: { tool_input: { file_path: '/tmp/x' }, tool_result: '' },
  PreRead: { tool_input: { file_path: '/tmp/x' } },
  PostRead: { tool_input: { file_path: '/tmp/x' }, tool_result: '' },
  PreWrite: { tool_input: { file_path: '/tmp/x', content: '' } },
  PostWrite: { tool_input: { file_path: '/tmp/x' }, tool_result: '' },
  PreGlob: { tool_input: { pattern: '**/*.ts' } },
  PreGrep: { tool_input: { pattern: 'TODO' } },
  PreTaskCreate: { tool_input: { description: 'task' } },
  PreTaskUpdate: { tool_input: { task_id: 'id' } },
  PreWebFetch: { tool_input: { url: 'https://example.com' } },
  PreWebSearch: { tool_input: { query: 'test' } },
  PreMcpToolUse: { tool_name: 'mcp__server__tool', tool_input: {} },
  PostMcpToolUse: { tool_name: 'mcp__server__tool', tool_input: {}, tool_result: '' },
}

interface HookRule {
  type: HookType
  command?: string
  url?: string
  prompt?: string
  agent?: string
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

  const scopePaths = useMemo(() => {
    const out: Partial<Record<Scope, string>> = {}
    for (const s of SETTINGS_SCOPES.scopes) {
      const p = SETTINGS_SCOPES.resolve(s, home ?? '', cwd)
      if (p) out[s] = p
    }
    return out
  }, [home, cwd])
  const path = scopePaths[scope] ?? null

  const files = useConfig((s) => s.files)
  const loadJson = useConfig((s) => s.loadJson)
  const setDraft = useConfig((s) => s.setDraft)
  const saveJson = useConfig((s) => s.saveJson)
  const revert = useConfig((s) => s.revert)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  useEffect(() => {
    const paths = Object.values(scopePaths).filter(Boolean) as string[]
    paths.forEach((p) => {
      if (!files[p]) loadJson(p)
      watchFile(p)
    })
    return () => paths.forEach((p) => unwatchFile(p))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(scopePaths)])

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
      <ListDetail
        sidebarWidth="14rem"
        sidebar={
          <div className="py-1">
            {HOOK_EVENTS.map((ev) => {
              const count = countFor(hooks, ev)
              return (
                <button
                  key={ev}
                  onClick={() => setSelectedEvent(ev)}
                  className={`w-full text-left px-3 py-1 text-xs flex items-center justify-between ${
                    selectedEvent === ev
                      ? 'bg-bg-hi text-fg'
                      : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
                  }`}
                >
                  <span className="truncate">{ev}</span>
                  {count > 0 && <span className="text-accent shrink-0 ml-2">{count}</span>}
                </button>
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
  })[t]
  const valueKey: keyof HookRule =
    rule.type === 'command'
      ? 'command'
      : rule.type === 'http'
        ? 'url'
        : rule.type === 'prompt'
          ? 'prompt'
          : 'agent'
  const value = (rule[valueKey] as string | undefined) ?? ''

  return (
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

