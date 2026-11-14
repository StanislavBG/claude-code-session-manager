import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { SaveBar } from '../ui/SaveBar'
import { JsonEditor } from '../ui/JsonEditor'
import { EmptyState } from '../ui/EmptyState'
import { SourceChip } from '../ui/SourceChip'
import { PermissionsRulesEditor } from './Permissions'
import { HooksEventsEditor } from './Hooks'
import { KEY_OWNERS } from '../../lib/settingsGroups'
import {
  useEffectiveCards,
  EffectiveCardsToolbar,
  EffectiveCardsRail,
  EffectiveCardsSections,
} from '../ui/EffectiveCards'
import { PageShell } from '../layout/PageShell'
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
  const schema = settingsSchema()
  // Lifted here (above the early return) so the toolbar, rail and sections —
  // which render into separate PageShell regions — share one filter state.
  const cards = useEffectiveCards({ node: effective, schema })

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

  const scopeNote = (
    <div data-testid="settings-scope-note" className="border-b border-line bg-bg-elev px-3 py-2 text-[11.5px] leading-snug">
      <span className="font-semibold text-fg">{SETTINGS_SCOPE_NOTES[scope].title}</span>
      <span className="mx-1.5 text-fg-faint">·</span>
      <span className="text-fg-dim">{SETTINGS_SCOPE_NOTES[scope].body}</span>
      {activePath && <span className="ml-1.5 font-mono text-fg-faint">{activePath}</span>}
    </div>
  )
  const chipRow = (keyPath?: string[]) => (
    <div className="px-3 py-2">
      <SourceChip path={activePath ?? ''} keyPath={keyPath} />
    </div>
  )
  const errorBanner =
    saveError && view !== 'raw' ? (
      <div role="alert" className="px-3 py-2 border-b border-line text-xs text-red-400">
        {saveError}
      </div>
    ) : null

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
    >
      {view === 'general' && !scopeNeedsCwd(scope) ? (
        // General renders through PageShell. The header (never scrolls) holds
        // only the scope note, the error banner and the filter toolbar; the
        // SourceChip row and OwnedSummaries sit at the top of the ONE content
        // scroller so the cards keep the space (a taller header left ~77 px of
        // cards at 900x650). The group rail is subnav.
        <PageShell
          subnavWidth={192}
          header={
            <>
              {scopeNote}
              {errorBanner}
              <EffectiveCardsToolbar cards={cards} targetScope={scope} />
            </>
          }
          subnav={<EffectiveCardsRail cards={cards} />}
        >
          <div className="px-3 pt-2">
            <SourceChip path={activePath ?? ''} />
          </div>
          <OwnedSummaries effective={effective} onOpenTab={setView} />
          <EffectiveCardsSections cards={cards} targetScope={scope} onOverride={overrideInto} />
        </PageShell>
      ) : scopeNeedsCwd(scope) ? (
        <PageShell header={<>{scopeNote}{errorBanner}</>}>
          <EmptyState
            title="no active project"
            hint="open a tab in a project directory to edit project or local settings"
          />
        </PageShell>
      ) : !activePath ? (
        <PageShell header={<>{scopeNote}{errorBanner}</>}>
          <EmptyState title="resolving…" />
        </PageShell>
      ) : view === 'permissions' ? (
        // Permissions / Hooks / Raw render through PageShell too: scope note +
        // SourceChip are the fixed header, the editor is the ONE scroller.
        <PageShell header={<>{scopeNote}{errorBanner}{chipRow(['permissions'])}</>}>
          <PermissionsRulesEditor scope={scope} cwd={cwd} activePath={activePath} />
        </PageShell>
      ) : view === 'hooks' ? (
        <HooksEventsEditor
          scope={scope}
          cwd={cwd}
          path={activePath}
          renderLayout={({ banners, list, detail }) => (
            <PageShell
              subnavWidth={224}
              header={<>{scopeNote}{errorBanner}{chipRow(['hooks'])}{banners}</>}
              subnav={<div className="min-h-full border-r border-line">{list}</div>}
            >
              {detail}
            </PageShell>
          )}
        />
      ) : file ? (
        <PageShell
          header={<>{scopeNote}{chipRow()}</>}
          footer={
            <div className="border-t border-line bg-bg-elev">
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
            </div>
          }
        >
          {/* Monaco scrolls itself: this h-full, overflow-clip box fills the
              content region exactly, so the content scroller has no range. */}
          <div data-testid="settings-raw-editor" className="h-full overflow-clip">
            <JsonEditor
              path={activePath}
              value={file.draftRaw}
              onChange={(v) => {
                setSaveError(null)
                setDraft(activePath, v)
              }}
            />
          </div>
        </PageShell>
      ) : (
        <PageShell header={<>{scopeNote}{errorBanner}</>}>
          <EmptyState title="resolving…" />
        </PageShell>
      )}
    </Panel>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const Settings = memo(SettingsComponent)
