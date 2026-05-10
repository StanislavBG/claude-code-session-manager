import { useEffect, useMemo, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ScopeSwitcher } from '../ui/ScopeSwitcher'
import { SaveBar } from '../ui/SaveBar'
import { JsonEditor } from '../ui/JsonEditor'
import { EmptyState } from '../ui/EmptyState'
import { EffectiveTree } from '../ui/EffectiveTree'
import { EffectiveCards } from '../ui/EffectiveCards'
import { ViewTabs } from '../ui/ViewTabs'
import { useConfig } from '../../state/config'
import { useSessions } from '../../state/sessions'
import { SETTINGS_SCOPES, type Scope } from '../../lib/scopes'
import { useHomeDir } from '../../lib/useHomeDir'
import { mergeScopes, setAtPath } from '../../lib/mergeScopes'
import { parseScopedJson } from '../../lib/parseScopedJson'
import { settingsSchema } from '../../lib/settingsSchema'
import { SettingsTelemetry } from './SettingsTelemetry'

export function Settings() {
  const home = useHomeDir()
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const cwd = activeTab?.cwd ?? null

  const [scope, setScope] = useState<Scope>('user')
  const [view, setView] = useState<'effective' | 'tree' | 'raw' | 'telemetry'>('effective')

  // Resolve paths for every scope so we can annotate existence on the switcher.
  const scopePaths = useMemo(() => {
    const out: Partial<Record<Scope, string>> = {}
    for (const s of SETTINGS_SCOPES.scopes) {
      const p = SETTINGS_SCOPES.resolve(s, home ?? '', cwd)
      if (p) out[s] = p
    }
    return out
  }, [home, cwd])

  const activePath = scopePaths[scope] ?? null

  const files = useConfig((s) => s.files)
  const loadJson = useConfig((s) => s.loadJson)
  const setDraft = useConfig((s) => s.setDraft)
  const saveJson = useConfig((s) => s.saveJson)
  const revert = useConfig((s) => s.revert)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  // Load + watch every resolvable scope path so the switcher annotations stay live.
  useEffect(() => {
    const paths = Object.values(scopePaths).filter(Boolean) as string[]
    paths.forEach((p) => {
      if (!files[p]) loadJson(p)
      watchFile(p)
    })
    return () => {
      paths.forEach((p) => unwatchFile(p))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(scopePaths)])

  const [saveError, setSaveError] = useState<string | null>(null)

  const effective = useMemo(
    () => mergeScopes(parseScopedJson(files, scopePaths)),
    [files, scopePaths]
  )

  const overrideInto = (path: string[], value: unknown) => {
    const target = scopePaths[scope]
    if (!target) return
    setSaveError(null)
    const draft = files[target]?.draftRaw ?? ''
    let current: unknown = {}
    if (draft.trim()) {
      try {
        current = JSON.parse(draft)
      } catch {
        current = {}
      }
    }
    const next = setAtPath(current, path, value)
    setDraft(target, JSON.stringify(next, null, 2) + '\n')
  }

  if (!home) return <EmptyState title="loading…" />

  const file = activePath ? files[activePath] : null
  const scopeNeedsCwd = (s: Scope) => s !== 'user' && !cwd

  return (
    <Panel
      toolbar={
        <>
          <ViewTabs
            options={[
              { key: 'effective', label: 'Guided' },
              { key: 'tree', label: 'Tree' },
              { key: 'raw', label: 'Raw' },
              { key: 'telemetry', label: 'Telemetry' },
            ]}
            active={view}
            onChange={setView}
          />
          {view !== 'telemetry' && (
            <>
              <span className="mx-2 text-fg-faint">·</span>
              <ScopeSwitcher
                scopes={SETTINGS_SCOPES.scopes}
                active={scope}
                onChange={setScope}
                annotate={(s) => {
                  if (scopeNeedsCwd(s)) return { exists: false }
                  const p = scopePaths[s]
                  if (!p) return null
                  const f = files[p]
                  return { exists: f?.exists ?? false, dirty: f?.dirty ?? false }
                }}
              />
              <span className="ml-3 text-fg-faint truncate">
                {view === 'effective' ? `overrides → ${activePath ?? '—'}` : activePath ?? '—'}
              </span>
            </>
          )}
          <div className="flex-1" />
          <a
            href="https://code.claude.com/docs/en/settings"
            target="_blank"
            rel="noreferrer"
            className="text-fg-faint hover:text-fg-dim underline-offset-2 hover:underline"
          >
            schema reference ↗
          </a>
        </>
      }
      footer={
        view !== 'telemetry' && activePath && file ? (
          <SaveBar
            dirty={file.dirty}
            busy={file.busy}
            parseError={saveError || file.parseError}
            lastSavedAt={file.lastSavedAt}
            leading={file.exists ? null : <span>file will be created on save</span>}
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
      {view === 'telemetry' ? (
        <SettingsTelemetry />
      ) : scopeNeedsCwd(scope) ? (
        <EmptyState
          title="no active project"
          hint="open a tab in a project directory to edit project or local settings"
        />
      ) : view === 'effective' ? (
        <EffectiveCards
          node={effective}
          targetScope={scope}
          onOverride={overrideInto}
          schema={settingsSchema()}
        />
      ) : view === 'tree' ? (
        <EffectiveTree
          node={effective}
          targetScope={scope}
          onOverride={overrideInto}
          schema={settingsSchema()}
        />
      ) : activePath && file ? (
        <JsonEditor
          path={activePath}
          value={file.draftRaw}
          onChange={(v) => {
            setSaveError(null)
            setDraft(activePath, v)
          }}
        />
      ) : (
        <EmptyState title="resolving…" />
      )}
    </Panel>
  )
}
