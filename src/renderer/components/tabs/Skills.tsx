import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { MarkdownEditor } from '../ui/MarkdownEditor'
import { SaveBar } from '../ui/SaveBar'
import { EmptyState } from '../ui/EmptyState'
import { ScopeSwitcher } from '../ui/ScopeSwitcher'
import { Toggle } from '../ui/Toggle'
import { ProvenanceBadge } from '../ui/ProvenanceBadge'
import { useConfig } from '../../state/config'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import { useLayout } from '../../state/layout'
import { listSkillEntries } from '../../lib/listSkills'
import type { Scope } from '../../lib/scopes'
import type { DirEntry } from '../../../preload/api'
import { SkillsLibrary, ViewSwitcher } from './Library'
import { readSkillDisabled, setSkillDisabled, parseSkillMeta } from '../../lib/skillFrontmatter'
import { toast } from '../../state/toast'

type Kind = 'skills' | 'commands'

function roots(home: string, cwd: string | null) {
  return {
    user: { skills: `${home}/.claude/skills`, commands: `${home}/.claude/commands` },
    project: cwd ? { skills: `${cwd}/.claude/skills`, commands: `${cwd}/.claude/commands` } : null,
  }
}

interface Item {
  kind: Kind
  scope: Scope
  name: string
  /** Absolute path to the editable markdown file. */
  path: string
  /** Absolute path of the skill directory (if applicable). */
  dir: string | null
  /** Skills only: `disable-model-invocation: true` in frontmatter. */
  disabled: boolean
  /** Skills only: `description` frontmatter field, if present. */
  description?: string
}

function SkillsComponent() {
  const home = useHomeDir()
  const activeTab = useActiveTab()
  const cwd = activeTab?.cwd ?? null

  // Scope defaults from the NavFace (leftnav-two-face-framework): Home face
  // -> 'user', Project face -> 'project' (falling back to 'user' when no
  // active-tab cwd resolves). Mirrors SystemPrompt/HistoryDashboard/
  // Scheduler's manuallyTouchedRef + prevNavFaceRef pattern so the default
  // only re-applies on an actual face transition, never on a same-face
  // re-render, and never once the user has manually changed the scope since
  // the last transition.
  const navFace = useLayout((s) => s.navFace)
  const manuallyTouchedRef = useRef(false)
  const prevNavFaceRef = useRef(navFace)

  const [scope, setScope] = useState<Scope>(() => (navFace === 'project' && cwd ? 'project' : 'user'))
  const [items, setItems] = useState<Item[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [view, setView] = useState<'installed' | 'library'>('installed')
  const [filter, setFilter] = useState('')

  const scopeRoots = useMemo(() => {
    if (!home) return null
    return roots(home, cwd)
  }, [home, cwd])

  // Skills is now HOME-only in the sidebar (navGroups.ts), and every nav
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

  // Enumerate skills and commands for the active scope.
  useEffect(() => {
    if (!scopeRoots) return
    let cancelled = false
    const bases =
      scope === 'user' ? scopeRoots.user : scopeRoots.project
    if (!bases) {
      setItems([])
      return
    }
    ;(async () => {
      const next: Item[] = []
      // Skills: subdirs containing SKILL.md, possibly nested under a
      // namespace dir (e.g. ~/.claude/skills/user/<name>/SKILL.md).
      const skillEntries = await listSkillEntries(bases.skills)
      for (const s of skillEntries) {
        next.push({
          kind: 'skills',
          scope,
          name: s.name,
          path: s.path,
          dir: s.dir,
          disabled: readSkillDisabled(s.text),
          description: parseSkillMeta(s.text).description ?? undefined,
        })
      }
      // Commands: each .md file is a command.
      const cmdsDir = await window.api.config.listDir(bases.commands, { filesOnly: true })
      for (const e of cmdsDir.entries as DirEntry[]) {
        if (!e.name.endsWith('.md')) continue
        next.push({
          kind: 'commands',
          scope,
          name: e.name.replace(/\.md$/, ''),
          path: e.path,
          dir: null,
          disabled: false,
        })
      }
      if (!cancelled) {
        next.sort((a, b) =>
          a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'skills' ? -1 : 1
        )
        setItems(next)
        if (!next.find((i) => i.path === selectedPath)) {
          setSelectedPath(next[0]?.path ?? null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, scopeRoots])

  const files = useConfig((s) => s.files)
  const loadText = useConfig((s) => s.loadText)
  const setDraft = useConfig((s) => s.setDraft)
  const saveText = useConfig((s) => s.saveText)
  const revert = useConfig((s) => s.revert)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  // Enable/disable a skill by writing `disable-model-invocation` to its
  // SKILL.md frontmatter — the canonical CLI flag. Reads fresh from disk so a
  // stale in-memory copy never clobbers concurrent edits.
  async function toggleSkillDisabled(item: Item, disabled: boolean) {
    const cur = await window.api.config.readText(item.path)
    if (!cur.exists) return
    const next = setSkillDisabled(cur.text, disabled)
    if (next === cur.text) return
    const w = await window.api.config.writeText(item.path, next)
    if (!w.ok) {
      toast.error(w.error ?? 'failed to update skill')
      return
    }
    setItems((prev) => prev.map((i) => (i.path === item.path ? { ...i, disabled } : i)))
    // Refresh the editor if this skill is open so its frontmatter reflects disk.
    if (files[item.path]) void loadText(item.path)
  }

  // Uninstall a skill by deleting its directory. Trash-backed (recoverable) and
  // reinstallable from the Library, so this is a "remove from Installed", not a
  // destructive wipe. Disable (toggle) only stops auto-invocation; Remove takes
  // the skill out of the active set entirely.
  async function removeSkill(item: Item) {
    if (!item.dir) return
    if (!window.confirm(
      `Remove skill "${item.name}"?\n\nIts folder moves to the trash (recoverable); reinstall any time from the Library.`
    )) return
    const r = await window.api.files.delete(item.dir)
    if (!r.ok) {
      toast.error(r.error ?? 'failed to remove skill')
      return
    }
    toast.info(`Removed "${item.name}" — moved to trash`)
    unwatchFile(item.path)
    setItems((prev) => prev.filter((i) => i.path !== item.path))
    setSelectedPath((cur) => {
      if (cur !== item.path) return cur
      const remaining = items.filter((i) => i.path !== item.path)
      return remaining[0]?.path ?? null
    })
  }

  useEffect(() => {
    if (!selectedPath) return
    if (!files[selectedPath]) loadText(selectedPath)
    watchFile(selectedPath)
    return () => unwatchFile(selectedPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath])

  const [saveError, setSaveError] = useState<string | null>(null)

  if (!home) return <EmptyState title="loading…" />
  if (view === 'library') {
    return (
      <Panel
        toolbar={<ViewSwitcher active={view} onChange={setView} installedLabel="Installed" libraryLabel="Library" />}
      >
        <SkillsLibrary />
      </Panel>
    )
  }
  if (scope === 'project' && !cwd) {
    return (
      <Panel
        toolbar={
          <>
            <ViewSwitcher active={view} onChange={setView} />
            <span className="mx-2 text-fg-faint">·</span>
            <ScopeSwitcher scopes={['user', 'project']} active={scope} onChange={(s) => { manuallyTouchedRef.current = true; setScope(s) }} />
          </>
        }
      >
        <EmptyState
          title="no active project"
          hint="open a tab in a project directory to view project skills & commands"
        />
      </Panel>
    )
  }

  const selectedItem = items.find((i) => i.path === selectedPath) ?? null
  const file = selectedPath ? files[selectedPath] : null

  return (
    <Panel
      toolbar={
        <>
          <ViewSwitcher active={view} onChange={setView} />
          <span className="mx-2 text-fg-faint">·</span>
          <ScopeSwitcher scopes={['user', 'project']} active={scope} onChange={(s) => { manuallyTouchedRef.current = true; setScope(s) }} />
          <span className="ml-3 text-fg-faint">
            {items.length} {items.length === 1 ? 'item' : 'items'}
          </span>
          <div className="flex-1" />
          {selectedItem && (
            <ProvenanceBadge
              scope={selectedItem.scope}
              input={{ type: selectedItem.kind === 'commands' ? 'command' : 'skill', name: selectedItem.name }}
            />
          )}
          <span className="ml-2 text-fg-faint truncate">{selectedItem?.path ?? ''}</span>
        </>
      }
      footer={
        selectedPath && file ? (
          <SaveBar
            dirty={file.dirty}
            busy={file.busy}
            parseError={saveError}
            lastSavedAt={file.lastSavedAt}
            onSave={async () => {
              setSaveError(null)
              const r = await saveText(selectedPath)
              if (!r.ok) setSaveError(r.error ?? 'save failed')
            }}
            onRevert={() => {
              setSaveError(null)
              revert(selectedPath)
            }}
          />
        ) : null
      }
    >
      <ListDetail
        sidebar={
          <div className="py-1">
            <div className="px-2 pb-1">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="filter…"
                className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
              />
            </div>
            {(['skills', 'commands'] as Kind[]).map((kind) => {
              const needle = filter.toLowerCase()
              const group = items.filter((i) => i.kind === kind && (!needle || i.name.toLowerCase().includes(needle)))
              return (
                <div key={kind} className="mb-3">
                  <div className="px-3 py-1 text-xs uppercase tracking-wider text-fg-faint">
                    {kind === 'skills' ? 'Skills' : 'Slash Commands'}
                  </div>
                  {group.length === 0 ? (
                    <div className="px-3 py-1 text-xs text-fg-faint italic">none</div>
                  ) : (
                    group.map((i) => {
                      // Skills can be turned off via frontmatter; commands cannot.
                      const showToggle = i.kind === 'skills'
                      return (
                        <div
                          key={i.path}
                          className={`w-full px-3 py-1 text-xs flex items-center justify-between gap-2 ${
                            selectedPath === i.path
                              ? 'bg-bg-hi text-fg'
                              : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
                          }`}
                        >
                          <button
                            onClick={() => setSelectedPath(i.path)}
                            className="flex-1 min-w-0 text-left"
                          >
                            <div
                              className={`truncate ${i.disabled ? 'line-through opacity-50' : ''}`}
                              title={i.disabled ? 'Disabled — Claude will not auto-invoke this skill' : undefined}
                            >
                              {i.kind === 'commands' ? '/' : ''}
                              {i.name}
                            </div>
                            {i.description && (
                              <div className="truncate text-fg-faint">{i.description}</div>
                            )}
                          </button>
                          <div className="flex items-center gap-2 shrink-0">
                            <ProvenanceBadge
                              interactive={false}
                              scope={i.scope}
                              input={{ type: i.kind === 'commands' ? 'command' : 'skill', name: i.name }}
                            />
                            {files[i.path]?.dirty && (
                              <span className="w-1 h-1 rounded-full bg-accent" />
                            )}
                            {showToggle && (
                              <Toggle
                                checked={!i.disabled}
                                onChange={(v) => void toggleSkillDisabled(i, !v)}
                              />
                            )}
                            {i.kind === 'skills' && (
                              <button
                                onClick={(e) => { e.stopPropagation(); void removeSkill(i) }}
                                title="Remove skill — moves the folder to trash; reinstall from the Library"
                                aria-label={`Remove ${i.name}`}
                                className="text-fg-faint hover:text-red-400 leading-none px-0.5"
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              )
            })}
          </div>
        }
        detail={
          selectedPath && file ? (
            <div className="h-full">
              <MarkdownEditor
                path={selectedPath}
                value={file.draftRaw}
                onChange={(v) => {
                  setSaveError(null)
                  setDraft(selectedPath, v)
                }}
              />
            </div>
          ) : (
            <EmptyState title={items.length === 0 ? 'no skills or commands' : 'select an item'} />
          )
        }
      />
    </Panel>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const Skills = memo(SkillsComponent)
