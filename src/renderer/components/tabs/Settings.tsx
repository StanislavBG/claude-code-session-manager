import { memo, useEffect, useMemo, useRef, useState } from 'react'
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
import { useLayout } from '../../state/layout'
import { SETTINGS_SCOPES, type Scope } from '../../lib/scopes'
import { useHomeDir } from '../../lib/useHomeDir'
import { useScopedConfigFiles } from '../../lib/useScopedConfigFiles'
import { mergeScopes, setAtPath } from '../../lib/mergeScopes'
import { parseScopedJson } from '../../lib/parseScopedJson'
import { settingsSchema } from '../../lib/settingsSchema'
import { SettingsTelemetry } from './SettingsTelemetry'
import { SettingsAppPrefs } from './SettingsAppPrefs'
import { SettingsEpicIsolation } from './SettingsEpicIsolation'

/**
 * Per-scope statement of WHAT FILE this screen is editing and HOW WIDELY it
 * applies. Settings is not a session preference panel and not a
 * session-manager-owned store: each scope is a direct, byte-level view of the
 * on-disk file the `claude` CLI itself reads on every invocation it launches
 * (see SETTINGS_SCOPES in lib/scopes.ts — the same resolver the New Session
 * grounding board reads with). CLAUDE.md's "Settings is substrate, not
 * per-Epic curation" rule is the reason this is stated on screen rather than
 * left to a tooltip: an edit here changes every current and future session in
 * that scope, which is invisible now that one TAB hosts many sessions.
 */
export const SETTINGS_SCOPE_NOTES: Record<Scope, { title: string; body: string }> = {
  user: {
    title: 'Global settings',
    body:
      'This is the real ~/.claude/settings.json on disk — the same file the claude CLI reads on every session it starts. Edits apply machine-wide, to every project and every session.',
  },
  project: {
    title: 'Project settings',
    body:
      'This is the real <project>/.claude/settings.json on disk, checked into git. Edits apply to every current and future session in this project, for anyone who clones it.',
  },
  local: {
    title: 'Local settings',
    body:
      'This is the real <project>/.claude/settings.local.json on disk, gitignored. Edits apply to every current and future session in this project, on this machine only.',
  },
}

function SettingsComponent() {
  const home = useHomeDir()
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const cwd = activeTab?.cwd ?? null

  // Scope defaults from the NavFace (leftnav-two-face-framework): Home face
  // -> 'user', Project face -> 'project' (falling back to 'user' when no
  // active-tab cwd resolves). Mirrors Permissions/Hooks/Skills' manuallyTouchedRef
  // + prevNavFaceRef pattern so the default only re-applies on an actual face
  // transition, never on a same-face re-render, and never once the user has
  // manually changed the scope since the last transition.
  const navFace = useLayout((s) => s.navFace)
  const manuallyTouchedRef = useRef(false)
  const prevNavFaceRef = useRef(navFace)

  const [scope, setScope] = useState<Scope>(() => (navFace === 'project' && cwd ? 'project' : 'user'))
  const [view, setView] = useState<'effective' | 'tree' | 'raw' | 'telemetry' | 'app'>('effective')

  // Settings is now HOME-only in the sidebar (navGroups.ts), and every nav
  // path that focuses it asserts navFace: 'home' — but a background split
  // (Workbench's `renderer: 'always'`) can keep this screen mounted while a
  // TabBar click elsewhere calls openProjectPanel, flipping navFace to
  // 'project' without unmounting this component — so this branch is live.
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

  // 'telemetry' (~/.config/session-manager/otel.json) and 'app' (Session
  // Manager native prefs, localStorage) are both machine-wide only — no
  // cwd/scope input anywhere in SettingsTelemetry/SettingsAppPrefs, so they
  // render byte-identical regardless of navFace. Project face never offers
  // them (see the ViewTabs options below); this effect just bounces the view
  // back to 'effective' if you land on the Project face while one of them
  // was already selected, so the toolbar never shows an active tab that's no
  // longer in its own options list.
  useEffect(() => {
    if (navFace === 'project' && (view === 'telemetry' || view === 'app')) setView('effective')
  }, [navFace, view])

  const handleScopeChange = (next: Scope) => {
    manuallyTouchedRef.current = true
    setScope(next)
  }

  // Resolve + load + watch every scope path so the switcher annotations stay live.
  const scopePaths = useScopedConfigFiles(SETTINGS_SCOPES, home, cwd)
  const activePath = scopePaths[scope] ?? null

  const files = useConfig((s) => s.files)
  const setDraft = useConfig((s) => s.setDraft)
  const saveJson = useConfig((s) => s.saveJson)
  const revert = useConfig((s) => s.revert)

  const [saveError, setSaveError] = useState<string | null>(null)

  const effective = useMemo(
    () => mergeScopes(parseScopedJson(files, scopePaths)),
    [files, scopePaths]
  )

  const overrideInto = (path: string[], value: unknown, intoScope?: Scope) => {
    // intoScope (optional) lets callers write a delete/reset into a specific
    // scope (e.g. the winner) rather than the user-active editing scope. Used
    // by EffectiveCards' reset-to-default button which targets the
    // most-specific scope that currently holds the key.
    const targetScope = intoScope ?? scope
    const target = scopePaths[targetScope]
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
              // Machine-wide only — see the reset effect above for why these
              // are hidden on the Project face rather than just left visible
              // with identical content.
              ...(navFace === 'home'
                ? [{ key: 'telemetry', label: 'Telemetry' }, { key: 'app', label: 'Session Manager' }] as const
                : []),
            ]}
            active={view}
            onChange={setView}
          />
          {view !== 'telemetry' && view !== 'app' && (
            <>
              <span className="mx-2 text-fg-faint">·</span>
              <ScopeSwitcher
                scopes={SETTINGS_SCOPES.scopes}
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
        view !== 'telemetry' && view !== 'app' && activePath && file ? (
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
      ) : view === 'app' ? (
        <SettingsAppPrefs />
      ) : (
        <>
          <div
            data-testid="settings-scope-note"
            className="sticky top-0 z-10 border-b border-line bg-bg-elev px-3 py-2 text-[11.5px] leading-snug"
          >
            <span className="font-semibold text-fg">{SETTINGS_SCOPE_NOTES[scope].title}</span>
            <span className="mx-1.5 text-fg-faint">·</span>
            <span className="text-fg-dim">{SETTINGS_SCOPE_NOTES[scope].body}</span>
            {activePath && (
              <span className="ml-1.5 font-mono text-fg-faint">{activePath}</span>
            )}
          </div>
          {scope === 'project' && cwd && <SettingsEpicIsolation cwd={cwd} />}
          {scopeNeedsCwd(scope) ? (
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
        </>
      )}
    </Panel>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const Settings = memo(SettingsComponent)
