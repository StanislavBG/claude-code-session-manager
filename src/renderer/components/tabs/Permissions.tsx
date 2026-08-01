import { useEffect, useMemo, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ScopeSwitcher } from '../ui/ScopeSwitcher'
import { SaveBar } from '../ui/SaveBar'
import { EmptyState } from '../ui/EmptyState'
import { useConfig } from '../../state/config'
import { useActiveTab } from '../../lib/useActiveTab'
import { useLayout } from '../../state/layout'
import { deriveNavFace } from '../../lib/navFace'
import { PERMISSIONS_SCOPES, type Scope } from '../../lib/scopes'
import { PermissionsPresetsLibrary } from './Library'
import { useHomeDir } from '../../lib/useHomeDir'
import { useScopedConfigFiles } from '../../lib/useScopedConfigFiles'
import { ViewTabs } from '../ui/ViewTabs'
import { EffectiveTree } from '../ui/EffectiveTree'
import { mergeScopes, getAtPath, setAtPath } from '../../lib/mergeScopes'
import { parseScopedJson } from '../../lib/parseScopedJson'
import { settingsSchema } from '../../lib/settingsSchema'

type PermissionList = 'allow' | 'deny' | 'ask'
const LISTS: PermissionList[] = ['allow', 'deny', 'ask']

interface PermissionsShape {
  allow?: string[]
  deny?: string[]
  ask?: string[]
  defaultMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  additionalDirectories?: string[]
}

function parsePerms(raw: string): { perms: PermissionsShape; full: Record<string, unknown>; err: string | null } {
  if (raw.trim() === '') return { perms: {}, full: {}, err: null }
  try {
    const full = JSON.parse(raw) as Record<string, unknown>
    const perms = (full.permissions as PermissionsShape) ?? {}
    return { perms, full, err: null }
  } catch (e) {
    return { perms: {}, full: {}, err: (e as Error).message }
  }
}

function serialize(full: Record<string, unknown>, perms: PermissionsShape): string {
  const next = { ...full, permissions: perms }
  return JSON.stringify(next, null, 2) + '\n'
}

export function Permissions() {
  const home = useHomeDir()
  const activeTab = useActiveTab()
  const cwd = activeTab?.cwd ?? null

  // Scope defaults from the NavFace (leftnav-two-face-framework): Home face
  // -> 'user', Project face -> 'project' (falling back to 'user' when no
  // active-tab cwd resolves). Mirrors Hooks/Skills/SystemPrompt/McpServers'
  // manuallyTouchedRef + prevNavFaceRef pattern so the default only re-applies
  // on an actual face transition, never on a same-face re-render, and never
  // once the user has manually changed the scope since the last transition.
  const focusedPanelId = useLayout((s) => s.focusedPanelId)
  const navFace = deriveNavFace(focusedPanelId)
  const manuallyTouchedRef = useRef(false)
  const prevNavFaceRef = useRef(navFace)

  const [scope, setScope] = useState<Scope>(() => (navFace === 'project' && cwd ? 'project' : 'user'))
  const [view, setView] = useState<'effective' | 'rules' | 'presets'>('effective')

  useEffect(() => {
    if (prevNavFaceRef.current === navFace) return
    prevNavFaceRef.current = navFace
    if (manuallyTouchedRef.current) {
      manuallyTouchedRef.current = false
      return
    }
    setScope(navFace === 'project' && cwd ? 'project' : 'user')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navFace, cwd])

  const handleScopeChange = (next: Scope) => {
    manuallyTouchedRef.current = true
    setScope(next)
  }

  const scopePaths = useScopedConfigFiles(PERMISSIONS_SCOPES, home, cwd)
  const activePath = scopePaths[scope] ?? null
  const files = useConfig((s) => s.files)
  const setDraft = useConfig((s) => s.setDraft)
  const saveJson = useConfig((s) => s.saveJson)
  const revert = useConfig((s) => s.revert)

  const [saveError, setSaveError] = useState<string | null>(null)

  const viewTabs = (
    <ViewTabs
      options={[
        { key: 'effective', label: 'Effective' },
        { key: 'rules', label: 'Rules' },
        { key: 'presets', label: 'Presets' },
      ]}
      active={view}
      onChange={setView}
    />
  )

  const effective = useMemo(() => {
    const merged = mergeScopes(parseScopedJson(files, scopePaths))
    return getAtPath(merged, ['permissions']) ?? { kind: 'object' as const, children: {} }
  }, [files, scopePaths])

  const overrideInto = (path: string[], value: unknown) => {
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
    const nextPerms = setAtPath(current.permissions ?? {}, path, value)
    const next = { ...current, permissions: nextPerms }
    setDraft(target, JSON.stringify(next, null, 2) + '\n')
  }

  if (!home) return <EmptyState title="loading…" />
  if (view === 'presets') {
    return (
      <Panel toolbar={viewTabs}>
        <PermissionsPresetsLibrary />
      </Panel>
    )
  }
  const scopeNeedsCwd = (s: Scope) => s !== 'user' && !cwd
  const file = activePath ? files[activePath] : null
  const { perms, full, err } = file ? parsePerms(file.draftRaw) : { perms: {}, full: {}, err: null }

  const updatePerms = (next: PermissionsShape) => {
    if (!activePath) return
    setSaveError(null)
    setDraft(activePath, serialize(full, next))
  }

  const addRule = (list: PermissionList, value: string) => {
    const v = value.trim()
    if (!v) return
    const cur = perms[list] ?? []
    if (cur.includes(v)) return
    updatePerms({ ...perms, [list]: [...cur, v] })
  }
  const removeRule = (list: PermissionList, idx: number) => {
    const cur = perms[list] ?? []
    updatePerms({ ...perms, [list]: cur.filter((_, i) => i !== idx) })
  }

  return (
    <Panel
      toolbar={
        <>
          {viewTabs}
          <span className="mx-2 text-fg-faint">·</span>
          <ScopeSwitcher
            scopes={PERMISSIONS_SCOPES.scopes}
            active={scope}
            onChange={handleScopeChange}
            annotate={(s) => {
              if (scopeNeedsCwd(s)) return { exists: false }
              const p = scopePaths[s]
              if (!p) return null
              const f = files[p]
              return { exists: f?.exists ?? false, dirty: f?.dirty ?? false }
            }}
          />
          <span className="ml-3 text-fg-faint truncate">{activePath ?? '—'}</span>
          <div className="flex-1" />
          <a
            href="https://code.claude.com/docs/en/settings#permissions"
            target="_blank"
            rel="noreferrer"
            className="text-fg-faint hover:text-fg-dim underline-offset-2 hover:underline"
          >
            rule syntax ↗
          </a>
        </>
      }
      footer={
        activePath && file ? (
          <SaveBar
            dirty={file.dirty}
            busy={file.busy}
            parseError={saveError || err || file.parseError}
            lastSavedAt={file.lastSavedAt}
            onSave={async () => {
              setSaveError(null)
              const res = await saveJson(activePath)
              if (!res.ok) setSaveError(res.error ?? 'save failed')
            }}
            onRevert={() => {
              setSaveError(null)
              revert(activePath)
            }}
          />
        ) : null
      }
    >
      {scopeNeedsCwd(scope) ? (
        <EmptyState
          title="no active project"
          hint="open a tab in a project directory to edit project or local permissions"
        />
      ) : view === 'effective' ? (
        <EffectiveTree
          node={effective}
          targetScope={scope}
          onOverride={overrideInto}
          schema={settingsSchema().rootedAt(['permissions'])}
          rootLabel="permissions"
        />
      ) : activePath && file ? (
        <div className="p-4 space-y-5 max-w-3xl">
          <ModeSelector
            value={perms.defaultMode ?? 'default'}
            onChange={(mode) => updatePerms({ ...perms, defaultMode: mode })}
          />
          {LISTS.map((list) => (
            <RuleList
              key={list}
              list={list}
              rules={perms[list] ?? []}
              onAdd={(v) => addRule(list, v)}
              onRemove={(i) => removeRule(list, i)}
            />
          ))}
          <AdditionalDirs
            dirs={perms.additionalDirectories ?? []}
            onChange={(dirs) => updatePerms({ ...perms, additionalDirectories: dirs })}
          />
        </div>
      ) : (
        <EmptyState title="resolving…" />
      )}
    </Panel>
  )
}

function ModeSelector({
  value,
  onChange,
}: {
  value: PermissionsShape['defaultMode']
  onChange: (m: NonNullable<PermissionsShape['defaultMode']>) => void
}) {
  const modes: NonNullable<PermissionsShape['defaultMode']>[] = [
    'default',
    'acceptEdits',
    'plan',
    'bypassPermissions',
  ]
  return (
    <section>
      <h3 className="text-xs text-fg uppercase tracking-wider mb-2">Default Mode</h3>
      <div className="inline-flex rounded border border-line overflow-hidden">
        {modes.map((m) => (
          <button
            key={m}
            onClick={() => onChange(m)}
            className={`px-2.5 py-1 text-xs transition-colors ${
              value === m
                ? 'bg-bg-hi text-fg'
                : 'bg-bg-elev text-fg-dim hover:text-fg hover:bg-bg-hi'
            }`}
          >
            {m}
          </button>
        ))}
      </div>
    </section>
  )
}

function RuleList({
  list,
  rules,
  onAdd,
  onRemove,
}: {
  list: PermissionList
  rules: string[]
  onAdd: (v: string) => void
  onRemove: (i: number) => void
}) {
  const [input, setInput] = useState('')
  const color =
    list === 'allow'
      ? 'text-green-400'
      : list === 'deny'
        ? 'text-red-400'
        : 'text-yellow-400'
  return (
    <section>
      <h3 className={`text-xs uppercase tracking-wider mb-2 ${color}`}>{list}</h3>
      <div className="flex gap-2 mb-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onAdd(input)
              setInput('')
            }
          }}
          placeholder={
            list === 'allow'
              ? 'e.g. Bash(ls:*) or Read(~/.claude/**)'
              : 'e.g. Write(/etc/**)'
          }
          className="flex-1 bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg placeholder-fg-faint"
        />
        <button
          onClick={() => {
            onAdd(input)
            setInput('')
          }}
          disabled={!input.trim()}
          className="px-2.5 py-1 border border-line rounded text-xs text-fg-dim hover:text-fg hover:bg-bg-hi disabled:opacity-40"
        >
          add
        </button>
      </div>
      {rules.length === 0 ? (
        <div className="text-fg-faint text-xs">no rules</div>
      ) : (
        <ul className="space-y-0.5">
          {rules.map((r, i) => (
            <li
              key={`${i}-${r}`}
              className="flex items-center gap-2 text-xs font-mono bg-bg-elev border border-line rounded px-2 py-1"
            >
              <span className="flex-1 text-fg-dim truncate">{r}</span>
              <button
                onClick={() => onRemove(i)}
                className="text-fg-faint hover:text-red-400"
                title="remove"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function AdditionalDirs({
  dirs,
  onChange,
}: {
  dirs: string[]
  onChange: (d: string[]) => void
}) {
  const [input, setInput] = useState('')
  return (
    <section>
      <h3 className="text-xs text-fg uppercase tracking-wider mb-2">Additional Directories</h3>
      <div className="flex gap-2 mb-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && input.trim()) {
              onChange([...dirs, input.trim()])
              setInput('')
            }
          }}
          placeholder="/absolute/path/to/dir"
          className="flex-1 bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg placeholder-fg-faint"
        />
      </div>
      <ul className="space-y-0.5">
        {dirs.map((d, i) => (
          <li
            key={`${i}-${d}`}
            className="flex items-center gap-2 text-xs font-mono bg-bg-elev border border-line rounded px-2 py-1"
          >
            <span className="flex-1 text-fg-dim truncate">{d}</span>
            <button
              onClick={() => onChange(dirs.filter((_, j) => j !== i))}
              className="text-fg-faint hover:text-red-400"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
