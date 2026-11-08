import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { SaveBar } from '../ui/SaveBar'
import { JsonEditor } from '../ui/JsonEditor'
import { EmptyState } from '../ui/EmptyState'
import { SourceChip } from '../ui/SourceChip'
import { PermissionsRulesEditor } from './Permissions'
import { HooksEventsEditor } from './Hooks'
import { KEY_OWNERS } from '../../lib/settingsGroups'
import { EffectiveCards } from '../ui/EffectiveCards'
import { ViewTabs } from '../ui/ViewTabs'
import { useConfig } from '../../state/config'
import { useSessions } from '../../state/sessions'
import { usePanelTabHint } from '../../state/layout'
import { SETTINGS_SCOPES, type Scope } from '../../lib/scopes'
import { useHomeDir } from '../../lib/useHomeDir'
import { useScopedConfigFiles } from '../../lib/useScopedConfigFiles'
import { mergeScopes, getAtPath } from '../../lib/mergeScopes'
import { parseScopedJson } from '../../lib/parseScopedJson'
import { settingsSchema } from '../../lib/settingsSchema'
import { toast } from '../../state/toast'

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

/** One line per key-owner: what it holds in the merged settings, and (for tab owners) a jump to that tab. */
function OwnedSummaries({
  effective,
  onOpenTab,
}: {
  effective: Parameters<typeof getAtPath>[0]
  onOpenTab: (tab: 'permissions' | 'hooks') => void
}) {
  return (
    <ul data-testid="settings-owned-summaries" className="px-3 py-2 space-y-1 text-[11.5px] border-b border-line">
      {KEY_OWNERS.map((o) => {
        const set = o.keys.filter((k) => getAtPath(effective, [k]) !== null)
        const text = set.length ? `${set.length} of ${o.keys.length} keys set (${set.join(', ')})` : 'nothing set'
        return (
          <li key={o.id} data-testid={`owned-summary-${o.id}`} className="flex items-center gap-2 text-fg-dim">
            <span className="font-semibold text-fg w-28 shrink-0">{o.label}</span>
            <span className="truncate">{text}</span>
            {o.tab ? (
              <button type="button" onClick={() => onOpenTab(o.tab!)} className="ml-auto text-accent hover:underline shrink-0">
                edit in {o.label} tab →
              </button>
            ) : (
              <span className="ml-auto text-fg-faint shrink-0">managed on the {o.label} page</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function SettingsComponent({ scope = 'user' }: { scope?: Scope } = {}) {
  const home = useHomeDir()
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const cwd = activeTab?.cwd ?? null

  const [view, setView] = useState<'general' | 'permissions' | 'hooks' | 'raw'>('general')
  usePanelTabHint('settings', (t) => {
    if (t === 'general' || t === 'permissions' || t === 'hooks' || t === 'raw') setView(t)
  })

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
    const draft = files[target]?.draftRaw ?? ''
    if (draft.trim()) {
      try {
        JSON.parse(draft)
      } catch (e) {
        // Refuse: an unparseable Raw draft means the user is mid-edit; fix it in Raw first.
        setSaveError(
          `${target} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — fix it in Raw before editing from General.`
        )
        return
      }
    }
    setSaveError(null)
    window.api.claudeConfig
      .patch({ fileId: 'settings', scope: targetScope, cwd, keyPath: path, value })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
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
              { key: 'general', label: 'General' },
              { key: 'permissions', label: 'Permissions' },
              { key: 'hooks', label: 'Hooks' },
              { key: 'raw', label: 'Raw' },
            ]}
            active={view}
            onChange={setView}
          />
          {(
            <>
              <span className="ml-3 text-fg-faint truncate">
                {view === 'general' ? `overrides → ${activePath ?? '—'}` : activePath ?? '—'}
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
        view === 'raw' && activePath && file ? (
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
      {(
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
          {saveError && view !== 'raw' && (
            <div role="alert" className="px-3 py-2 border-b border-line text-xs text-red-400">
              {saveError}
            </div>
          )}
          {scopeNeedsCwd(scope) ? (
            <EmptyState
              title="no active project"
              hint="open a tab in a project directory to edit project or local settings"
            />
          ) : view === 'general' ? (
            <>
              <div className="px-3 pt-2">
                <SourceChip path={activePath ?? ''} />
              </div>
              <OwnedSummaries effective={effective} onOpenTab={setView} />
              <EffectiveCards
                node={effective}
                targetScope={scope}
                onOverride={overrideInto}
                schema={settingsSchema()}
              />
            </>
          ) : view === 'permissions' ? (
            activePath ? (
              <>
                <div className="px-3 pt-2">
                  <SourceChip path={activePath} keyPath={['permissions']} />
                </div>
                <PermissionsRulesEditor scope={scope} cwd={cwd} activePath={activePath} />
              </>
            ) : (
              <EmptyState title="resolving…" />
            )
          ) : view === 'hooks' ? (
            activePath ? (
              <>
                <div className="px-3 pt-2">
                  <SourceChip path={activePath} keyPath={['hooks']} />
                </div>
                <HooksEventsEditor scope={scope} cwd={cwd} path={activePath} />
              </>
            ) : (
              <EmptyState title="resolving…" />
            )
          ) : activePath && file ? (
            <>
            <div className="px-3 pt-2">
              <SourceChip path={activePath} />
            </div>
            <JsonEditor
              path={activePath}
              value={file.draftRaw}
              onChange={(v) => {
                setSaveError(null)
                setDraft(activePath, v)
              }}
            />
            </>
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
