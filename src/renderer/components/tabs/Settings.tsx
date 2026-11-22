/**
 * Settings — the settings.json editor on the Claude config workbench design
 * (design-mocks/claude-config: renders 07-project-settings / 11-home-settings).
 *
 * Left column (ConfigWorkbench list): the SETTINGS FILE card — Project / Local radio rows in a
 * project (the caller owns the choice via `onScopeChange`), the user file on Home — a
 * 'Search N settings' field, the group rail (icon, title, set/total) and, below a divider,
 * Permissions and Hooks rows that open the existing editors in the detail.
 * Detail: one group's setting cards (EffectiveCards) under a header with Show unset / Advanced
 * switches and a '{ } Raw JSON' button that opens the existing raw JSON editor.
 */
import { memo, useMemo, useState, type ReactNode } from 'react'
import { SaveBar } from '../ui/SaveBar'
import { JsonEditor } from '../ui/JsonEditor'
import { EmptyState } from '../ui/EmptyState'
import { SourceChip } from '../ui/SourceChip'
import { Toggle } from '../ui/Toggle'
import { PermissionsRulesEditor } from './Permissions'
import { HooksEventsEditor } from './Hooks'
import { KEY_OWNERS } from '../../lib/settingsGroups'
import { useEffectiveCards, SettingsGroupRail, SettingsGroupCards } from '../ui/EffectiveCards'
import { ConfigWorkbench } from '../claudeConfig/ConfigLayout'
import { AlmanacIcon, type AlmanacIconName } from '../layout/AlmanacIcon'
import { useConfig } from '../../state/config'
import { useSessions } from '../../state/sessions'
import { usePanelTabHint } from '../../state/layout'
import { SETTINGS_SCOPES, type Scope } from '../../lib/scopes'
import { useHomeDir } from '../../lib/useHomeDir'
import { useScopedConfigFiles } from '../../lib/useScopedConfigFiles'
import { mergeScopes, getAtPath, type EffectiveNode } from '../../lib/mergeScopes'
import { parseScopedJson } from '../../lib/parseScopedJson'
import { settingsSchema } from '../../lib/settingsSchema'
import { formatMtimeMs } from '../../lib/formatTime'
import { toast } from '../../state/toast'

/**
 * Per-scope statement of WHAT FILE this screen is editing and HOW WIDELY it
 * applies. Settings is not a session preference panel and not a
 * session-manager-owned store: each scope is a direct, byte-level view of the
 * on-disk file the `claude` CLI itself reads on every invocation it launches
 * (see SETTINGS_SCOPES in lib/scopes.ts). CLAUDE.md's "Settings is substrate, not
 * per-Epic curation" rule is why the file card carries this as its tooltip.
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

export type ProjectSettingsScope = 'project' | 'local'
type View = 'general' | 'permissions' | 'hooks' | 'raw'

const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint'

const FILE_ROWS: Record<Scope, { label: string; meta: string }> = {
  user: { label: 'User', meta: '~/.claude/settings.json · every project' },
  project: { label: 'Project', meta: '.claude/settings.json · in git' },
  local: { label: 'Local', meta: 'settings.local.json · this machine' },
}

function RadioDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`w-4 h-4 shrink-0 mt-0.5 rounded-full box-border ${on ? 'border-[5px] border-fg' : 'border-[1.5px] border-fg-faint'}`}
    />
  )
}

function FileRowBody({ scope, selected }: { scope: Scope; selected: boolean }) {
  return (
    <span className="flex-1 min-w-0">
      <span className={`block text-[13.5px] ${selected ? 'font-semibold text-fg' : 'font-medium text-fg-dim'}`}>{FILE_ROWS[scope].label}</span>
      <span className="block font-mono text-[11.5px] text-fg-faint break-words">{FILE_ROWS[scope].meta}</span>
    </span>
  )
}

function SettingsFileCard({
  scope,
  mtimeMs,
  exists,
  onScopeChange,
}: {
  scope: Scope
  mtimeMs: number | null
  exists: boolean
  onScopeChange?: (s: ProjectSettingsScope) => void
}) {
  const age = !exists ? 'not created yet' : mtimeMs ? `edited ${formatMtimeMs(mtimeMs)}` : ''
  return (
    <div
      data-testid="settings-file-card"
      title={SETTINGS_SCOPE_NOTES[scope].body}
      className="px-3.5 pt-3.5 pb-3 rounded-[14px] bg-bg-hi border border-line flex flex-col gap-1.5"
    >
      <div className="flex items-center px-0.5 pb-1">
        <span className={`flex-1 ${EYEBROW}`}>SETTINGS FILE</span>
        <span className="text-[11.5px] text-fg-faint">{age}</span>
      </div>
      {scope === 'user' ? (
        <>
          <div className="flex gap-[11px] p-2.5 rounded-[10px] bg-bg border border-line">
            <RadioDot on />
            <FileRowBody scope="user" selected />
          </div>
          <div className="px-2.5 pt-1.5 text-xs leading-snug text-fg-faint">
            Each project can override any of these in its own Claude config.
          </div>
        </>
      ) : (
        <div role="radiogroup" aria-label="Settings file" className="flex flex-col gap-1">
          {(['project', 'local'] as const).map((s) => {
            const selected = s === scope
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`settings-file-${s}`}
                disabled={!onScopeChange}
                onClick={() => onScopeChange?.(s)}
                className={`w-full text-left flex gap-[11px] p-2.5 rounded-[10px] border focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                  selected ? 'bg-bg border-line' : 'border-transparent hover:bg-bg/60'
                }`}
              >
                <RadioDot on={selected} />
                <FileRowBody scope={s} selected={selected} />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PaneRow({
  testId,
  icon,
  label,
  trailing,
  selected,
  onSelect,
}: {
  testId: string
  icon: AlmanacIconName
  label: string
  trailing: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-current={selected}
      onClick={onSelect}
      className={`w-full flex items-center gap-2.5 h-[34px] px-3 rounded-[9px] border text-left text-[13.5px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
        selected ? 'bg-bg-hi border-line font-semibold text-fg' : 'border-transparent text-fg-dim hover:bg-bg-hi/60'
      }`}
    >
      <AlmanacIcon name={icon} size={16} className={`shrink-0 ${selected ? 'text-accent' : 'text-fg-faint'}`} />
      <span className="flex-1 min-w-0 truncate">{label}</span>
      <span className="shrink-0 text-xs text-fg-faint whitespace-nowrap">{trailing}</span>
    </button>
  )
}

function DetailHeader({
  eyebrow,
  title,
  summary,
  actions,
}: {
  eyebrow: string
  title: string
  summary?: string
  actions?: ReactNode
}) {
  return (
    <div data-testid="settings-detail-header" className="shrink-0 px-9 pt-6 pb-5 border-b border-line flex items-end gap-4 whitespace-nowrap">
      <div className="flex-1 min-w-0">
        <div className={`truncate ${EYEBROW}`}>{eyebrow}</div>
        <div className="mt-1 flex items-baseline gap-3.5 min-w-0">
          <span className="shrink-0 font-serif text-[34px] font-medium leading-tight text-fg">{title}</span>
          {summary && <span className="truncate text-[14.5px] text-fg-dim">{summary}</span>}
        </div>
      </div>
      {actions && <div className="shrink-0 flex items-center gap-4">{actions}</div>}
    </div>
  )
}

/** Permission rules held anywhere in the merged settings (allow + ask + deny). */
function permissionRuleCount(effective: EffectiveNode): number {
  let n = 0
  for (const list of ['allow', 'ask', 'deny']) {
    const node = getAtPath(effective, ['permissions', list])
    if (node?.kind === 'array') n += node.items.length
  }
  return n
}

function SettingsComponent({
  scope = 'user',
  onScopeChange,
}: { scope?: Scope; onScopeChange?: (scope: ProjectSettingsScope) => void } = {}) {
  const home = useHomeDir()
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const cwd = activeTab?.cwd ?? null

  const [view, setView] = useState<View>('general')
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null)
  usePanelTabHint('settings', (t) => {
    if (t === 'general' || t === 'permissions' || t === 'hooks' || t === 'raw') setView(t)
  })

  // Resolve + load + watch every scope path so the effective merge (and the ladder) stays live.
  const scopePaths = useScopedConfigFiles(SETTINGS_SCOPES, home, cwd)
  const activePath = scopePaths[scope] ?? null

  const files = useConfig((s) => s.files)
  const setDraft = useConfig((s) => s.setDraft)
  const saveJson = useConfig((s) => s.saveJson)
  const revert = useConfig((s) => s.revert)

  const [saveError, setSaveError] = useState<string | null>(null)

  const effective = useMemo(() => mergeScopes(parseScopedJson(files, scopePaths)), [files, scopePaths])
  const schema = settingsSchema()
  const cards = useEffectiveCards({ node: effective, schema })

  const overrideInto = (path: string[], value: unknown, intoScope?: Scope) => {
    // intoScope (optional) lets callers write a delete/reset into a specific scope (e.g. the
    // winner) rather than the editing scope — EffectiveCards' reset targets the winning scope.
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
  const scopeNeedsCwd = scope !== 'user' && !cwd

  const rail = cards.railGroups
  const groupId = selectedGroup && rail.some((g) => g.id === selectedGroup) ? selectedGroup : rail[0]?.id ?? null
  const group = rail.find((g) => g.id === groupId) ?? null
  const groupPlan = cards.groups.find((g) => g.id === groupId) ?? null
  const searching = cards.filter.trim() !== ''

  const selectGroup = (id: string) => {
    if (cards.groups.find((g) => g.id === id)?.advanced && !cards.showAdvanced) cards.setShowAdvanced(true)
    cards.setFilter('')
    setSelectedGroup(id)
    setView('general')
  }
  const setAdvanced = (on: boolean) => {
    cards.setShowAdvanced(on)
    if (!on && groupPlan?.advanced) setSelectedGroup(rail.find((g) => !g.advanced)?.id ?? null)
  }

  const hooksOwner = KEY_OWNERS.find((o) => o.id === 'hooks')
  const hooksSet = hooksOwner ? hooksOwner.keys.filter((k) => getAtPath(effective, [k]) !== null).length : 0
  const rules = permissionRuleCount(effective)
  const scopeWord = scope.toUpperCase()

  const list = (
    <>
      <SettingsFileCard
        scope={scope}
        mtimeMs={file?.mtimeMs ?? null}
        exists={file?.exists ?? true}
        onScopeChange={onScopeChange}
      />
      <label className="flex items-center gap-2 h-[38px] px-3 rounded-[10px] bg-bg-hi border border-line text-[13px] text-fg-faint focus-within:border-fg-faint">
        <AlmanacIcon name="search" size={15} className="shrink-0" />
        <input
          type="search"
          aria-label="Search settings"
          placeholder={`Search ${cards.totalKeys} settings`}
          value={cards.filter}
          onChange={(e) => {
            cards.setFilter(e.target.value)
            setView('general')
          }}
          className="flex-1 min-w-0 bg-transparent outline-none text-fg placeholder:text-fg-faint"
        />
      </label>
      <SettingsGroupRail cards={cards} selectedId={view === 'general' && !searching ? groupId : null} onSelect={selectGroup} />
      <div className="flex flex-col gap-px border-t border-line pt-2.5">
        <PaneRow
          testId="settings-row-permissions"
          icon="permissions"
          label="Permissions"
          trailing={rules ? `${rules} ${rules === 1 ? 'rule' : 'rules'}` : 'none set'}
          selected={view === 'permissions'}
          onSelect={() => setView('permissions')}
        />
        <PaneRow
          testId="settings-row-hooks"
          icon="hooks"
          label="Hooks"
          trailing={`${hooksSet}/${hooksOwner?.keys.length ?? 0}`}
          selected={view === 'hooks'}
          onSelect={() => setView('hooks')}
        />
      </div>
      <a
        href="https://code.claude.com/docs/en/settings"
        target="_blank"
        rel="noreferrer"
        className="px-3 text-xs text-fg-faint hover:text-fg-dim underline-offset-2 hover:underline"
      >
        schema reference ↗
      </a>
    </>
  )

  const rawButton = (
    <button
      type="button"
      onClick={() => setView('raw')}
      className="h-9 px-3.5 rounded-[10px] border border-line bg-bg-hi font-mono text-[13px] font-medium text-fg hover:bg-bg-elev focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      {'{ } Raw JSON'}
    </button>
  )
  const chipLine = (keyPath?: string[]) => (
    <div className="shrink-0 px-9 pt-3">
      <SourceChip path={activePath ?? ''} keyPath={keyPath} />
    </div>
  )
  const errorBanner =
    saveError && view !== 'raw' ? (
      <div role="alert" className="shrink-0 mx-9 mt-3 px-3 py-2 rounded border border-line text-xs text-red-400">
        {saveError}
      </div>
    ) : null

  let detail: ReactNode
  if (scopeNeedsCwd) {
    detail = <EmptyState title="no active project" hint="open a tab in a project directory to edit project or local settings" />
  } else if (!activePath) {
    detail = <EmptyState title="resolving…" />
  } else if (view === 'general') {
    const header = searching
      ? { title: 'Search', summary: `settings matching "${cards.filter.trim()}"` }
      : { title: group?.title ?? 'Settings', summary: groupPlan?.summary }
    detail = (
      <>
        <DetailHeader
          eyebrow={`${scopeWord} SETTINGS · ${group?.setCount ?? 0} OF ${group?.total ?? 0} SET`}
          title={header.title}
          summary={header.summary}
          actions={
            <>
              <Toggle checked={cards.showUnset} onChange={cards.setShowUnset} label="Show unset" />
              <Toggle checked={cards.showAdvanced} onChange={setAdvanced} label="Advanced" />
              {rawButton}
            </>
          }
        />
        {chipLine()}
        {errorBanner}
        <SettingsGroupCards
          cards={cards}
          groupIds={searching ? cards.visibleGroups.map((g) => g.id) : groupId ? [groupId] : []}
          targetScope={scope}
          onOverride={overrideInto}
        />
      </>
    )
  } else if (view === 'permissions') {
    detail = (
      <>
        <DetailHeader
          eyebrow={`${scopeWord} SETTINGS · PERMISSIONS`}
          title="Permissions"
          summary="What Claude may do without asking."
          actions={rawButton}
        />
        {chipLine(['permissions'])}
        {errorBanner}
        <div className="px-6 py-3">
          <PermissionsRulesEditor scope={scope} cwd={cwd} activePath={activePath} />
        </div>
      </>
    )
  } else if (view === 'hooks') {
    detail = (
      <HooksEventsEditor
        scope={scope}
        cwd={cwd}
        path={activePath}
        renderLayout={({ banners, list: events, detail: editor }) => (
          <>
            <DetailHeader
              eyebrow={`${scopeWord} SETTINGS · HOOKS`}
              title="Hooks"
              summary="Commands that run on Claude Code events."
              actions={rawButton}
            />
            {chipLine(['hooks'])}
            {errorBanner}
            {banners}
            <div data-testid="settings-hooks-body" className="flex-1 min-h-0 flex mt-3 border-t border-line">
              <div className="w-56 shrink-0 border-r border-line overflow-y-auto">{events}</div>
              <div className="flex-1 min-w-0 overflow-y-auto">{editor}</div>
            </div>
          </>
        )}
      />
    )
  } else if (file) {
    detail = (
      <>
        <DetailHeader eyebrow={`${scopeWord} SETTINGS · RAW JSON`} title="Raw JSON" summary="The whole file, as the claude CLI reads it." />
        {chipLine()}
        {/* Monaco scrolls itself: this flex-1, overflow-clip box fills the detail height. */}
        <div data-testid="settings-raw-editor" className="flex-1 min-h-0 overflow-clip mt-3">
          <JsonEditor
            path={activePath}
            value={file.draftRaw}
            onChange={(v) => {
              setSaveError(null)
              setDraft(activePath, v)
            }}
          />
        </div>
        <div className="shrink-0 border-t border-line bg-bg-elev">
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
      </>
    )
  } else {
    detail = <EmptyState title="resolving…" />
  }

  return (
    <div data-testid="settings-page" className="flex h-full min-h-0 bg-bg text-fg">
      <ConfigWorkbench list={list} detail={detail} />
    </div>
  )
}

// Memoized: own data comes from store/IPC hooks inside the component.
export const Settings = memo(SettingsComponent)
