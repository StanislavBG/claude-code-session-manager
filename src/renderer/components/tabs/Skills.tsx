import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { MarkdownEditor } from '../ui/MarkdownEditor'
import { SaveBar } from '../ui/SaveBar'
import { EmptyState } from '../ui/EmptyState'
import { Toggle } from '../ui/Toggle'
import { ProvenanceBadge } from '../ui/ProvenanceBadge'
import { useConfig } from '../../state/config'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import { listSkillEntries, type SkillListError } from '../../lib/listSkills'
import { useConfigDirWatch } from '../../lib/useConfigDirWatch'
import type { Scope } from '../../lib/scopes'
import type { DirEntry } from '../../../preload/api'
import { readSkillDisabled, setSkillDisabled, parseSkillMeta } from '../../lib/skillFrontmatter'
import { toast } from '../../state/toast'
import { ExtensionsToolbar, type ExtensionsToolbarMenuItem } from './extensions/ExtensionsToolbar'

const WATCH_DEBOUNCE_MS = 250
const SELF_SAVE_WINDOW_MS = 2000
/** Same cap listSkillEntries keeps on SKILL.md reads. */
const READ_CONCURRENCY = 6

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
  /** `description` frontmatter field (SKILL.md or the command file), if present. */
  description?: string
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Reads each command file's frontmatter `description`, at most
 * READ_CONCURRENCY reads in flight. A failed read keeps the command listed
 * without a description and reports the failure in `errors`.
 */
async function readCommandDescriptions(
  paths: string[],
  errors: SkillListError[],
): Promise<Array<string | undefined>> {
  const out: Array<string | undefined> = paths.map(() => undefined)
  let next = 0
  const worker = async () => {
    for (let idx = next++; idx < paths.length; idx = next++) {
      try {
        const r = await window.api.config.readText(paths[idx])
        if (r.error) errors.push({ path: paths[idx], error: r.error })
        else if (r.exists) out[idx] = parseSkillMeta(r.text).description ?? undefined
      } catch (e) {
        errors.push({ path: paths[idx], error: errorText(e) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker))
  return out
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** List section header (3a): 11px semibold uppercase label + mono count. */
function SectionHeader({ label, count, testId }: { label: string; count: number; testId: string }) {
  return (
    <div
      data-testid={testId}
      className="flex items-center gap-2 mt-3 mx-1.5 mb-1 text-[11px] font-semibold tracking-[0.06em] uppercase text-fg-faint"
    >
      {label}
      <span data-testid={`${testId}-count`} className="font-mono font-medium tracking-normal text-fg-faint/60">
        {count}
      </span>
    </div>
  )
}

/** One quiet line under a section header: nothing matches, nothing yet, or the listing failed. */
function SectionNote({ children, testId, title }: { children: ReactNode; testId?: string; title?: string }) {
  return (
    <div data-testid={testId} title={title} className="mx-1.5 mb-1 text-xs text-fg-faint">
      {children}
    </div>
  )
}

function SkillsComponent({ onAdd, scope = 'user' }: { onAdd?: () => void; scope?: Scope } = {}) {
  const home = useHomeDir()
  const activeTab = useActiveTab()
  const cwd = activeTab?.cwd ?? null

  const [items, setItems] = useState<Item[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  // Paths that failed to list on the latest load — drives the inline error state.
  const [loadErrors, setLoadErrors] = useState<SkillListError[]>([])
  // Path of the skill whose inline "remove?" confirmation is open.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  // False until the first listing lands, so the empty states never flash.
  const [listed, setListed] = useState(false)

  const scopeRoots = useMemo(() => {
    if (!home) return null
    return roots(home, cwd)
  }, [home, cwd])

  // Current scope's roots — also the set of directories watched below, so
  // both derive from the same scope/scopeRoots pair.
  const bases = useMemo(() => {
    if (!scopeRoots) return null
    return scope === 'user' ? scopeRoots.user : scopeRoots.project
  }, [scope, scopeRoots])

  // Enumerate skills and commands for the active scope. Callable both on
  // mount/scope change and from the directory watch below (Skills.tsx used
  // to only list once at mount — an external edit to a SKILL.md or command
  // file outside this app was invisible until reload).
  const loadSeq = useRef(0)
  const loadItems = useCallback(async () => {
    // Bumped before any early return too, so a still-in-flight call from a
    // just-superseded (bases/scope) pair can never win a race against this
    // one — including the "scope lost its bases" transition below.
    const seq = ++loadSeq.current
    if (!bases) {
      setItems([])
      setLoadErrors([])
      setListed(true)
      return
    }
    const next: Item[] = []
    const errors: SkillListError[] = []
    try {
      // Skills: subdirs containing SKILL.md, possibly nested under a
      // namespace dir (e.g. ~/.claude/skills/user/<name>/SKILL.md).
      const skills = await listSkillEntries(bases.skills)
      errors.push(...skills.errors)
      for (const s of skills.entries) {
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
    } catch (e) {
      errors.push({ path: bases.skills, error: errorText(e) })
    }
    try {
      // Commands: each .md file is a command; its card shows the frontmatter
      // description. Read after the skills so the read cap holds overall.
      const cmdsDir = await window.api.config.listDir(bases.commands, { filesOnly: true })
      if (!cmdsDir.ok) errors.push({ path: bases.commands, error: cmdsDir.error ?? 'failed to list directory' })
      const cmdFiles = (cmdsDir.entries as DirEntry[]).filter((e) => e.name.endsWith('.md'))
      const descriptions = await readCommandDescriptions(cmdFiles.map((e) => e.path), errors)
      cmdFiles.forEach((e, idx) => {
        next.push({
          kind: 'commands',
          scope,
          name: e.name.replace(/\.md$/, ''),
          path: e.path,
          dir: null,
          disabled: false,
          description: descriptions[idx],
        })
      })
    } catch (e) {
      errors.push({ path: bases.commands, error: errorText(e) })
    }
    if (loadSeq.current !== seq) return
    for (const e of errors) toast.error(`Could not read ${e.path}: ${e.error}`)
    setLoadErrors(errors)
    next.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'skills' ? -1 : 1
    )
    setItems(next)
    setListed(true)
    setSelectedPath((cur) => (next.find((i) => i.path === cur) ? cur : next[0]?.path ?? null))
  }, [bases, scope])

  useEffect(() => { void loadItems() }, [loadItems])

  // Invalidate any still-in-flight loadItems on actual unmount — the seq bump
  // above only covers a NEW call superseding an old one; nothing else calls
  // loadItems after the component is gone.
  useEffect(() => () => { loadSeq.current += 1 }, [])

  // Watch-driven re-lists: debounced, never restarting a load in flight (one
  // trailing load follows it), and skipped when the event is the echo of this
  // page's own just-saved SKILL.md (the list cannot have changed).
  const loadItemsRef = useRef(loadItems)
  loadItemsRef.current = loadItems
  const itemsRef = useRef(items)
  itemsRef.current = items
  const selectedPathRef = useRef(selectedPath)
  selectedPathRef.current = selectedPath
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadInFlight = useRef(false)
  const loadPending = useRef(false)
  const runLoad = useCallback(async () => {
    if (loadInFlight.current) {
      loadPending.current = true
      return
    }
    loadInFlight.current = true
    try {
      await loadItemsRef.current()
    } finally {
      loadInFlight.current = false
    }
    if (loadPending.current) {
      loadPending.current = false
      void runLoad()
    }
  }, [])
  useEffect(() => () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
  }, [])
  const onWatchEvent = useCallback((changedPath: string) => {
    const sel = selectedPathRef.current
    const selItem = sel ? itemsRef.current.find((i) => i.path === sel) : null
    const savedAt = sel ? useConfig.getState().files[sel]?.lastSavedAt : null
    if (
      selItem?.dir && savedAt && Date.now() - savedAt < SELF_SAVE_WINDOW_MS &&
      (changedPath === selItem.dir || selItem.dir.startsWith(`${changedPath}/`))
    ) return
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null
      void runLoad()
    }, WATCH_DEBOUNCE_MS)
  }, [runLoad])

  useConfigDirWatch(bases ? [bases.skills, bases.commands] : [], onWatchEvent)

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
    // Refresh the editor if this skill is open so its frontmatter reflects
    // disk. keepDirty: a draft typed while the write was in flight survives.
    if (useConfig.getState().files[item.path]) void useConfig.getState().loadText(item.path, true)
  }

  // Uninstall a skill by deleting its directory. Trash-backed (recoverable) and
  // reinstallable from the Library, so this is a "remove from Installed", not a
  // destructive wipe. Disable (toggle) only stops auto-invocation; Remove takes
  // the skill out of the active set entirely.
  async function removeSkill(item: Item) {
    if (!item.dir) return
    setConfirmRemove(null)
    const r = await window.api.files.delete(item.dir)
    if (!r.ok) {
      toast.error(r.error ?? 'failed to remove skill')
      return
    }
    toast.info(`Removed "${item.name}" — moved to trash`)
    unwatchFile(item.path)
    // Selection is derived from the fresh list inside the updater, never from
    // the `items` captured when the (async) remove started.
    setItems((prev) => {
      const remaining = prev.filter((i) => i.path !== item.path)
      setSelectedPath((cur) => (cur !== item.path ? cur : remaining[0]?.path ?? null))
      return remaining
    })
  }

  useEffect(() => {
    if (!selectedPath) return
    if (!files[selectedPath]) loadText(selectedPath)
    watchFile(selectedPath)
    return () => unwatchFile(selectedPath)
  }, [selectedPath])

  const [saveError, setSaveError] = useState<string | null>(null)

  if (!home) return <EmptyState title="loading…" />
  if (scope === 'project' && !cwd) {
    return (
      <Panel
        toolbar={
          <>
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

  const file = selectedPath ? files[selectedPath] : null

  // Filter on name or description, case-insensitive; a leading "/" is how a
  // name is shown, so "/deploy" finds the deploy command too.
  const needle = filter.trim().toLowerCase().replace(/^\//, '')
  const matches = (i: Item) =>
    !needle || i.name.toLowerCase().includes(needle) || !!i.description?.toLowerCase().includes(needle)
  const skillItems = items.filter((i) => i.kind === 'skills')
  const commandItems = items.filter((i) => i.kind === 'commands')
  const shownSkills = skillItems.filter(matches)
  const shownCommands = commandItems.filter(matches)
  // Load errors under a root: that section is empty because it could not be read.
  const errorsUnder = (root: string | undefined) =>
    root ? loadErrors.filter((e) => e.path === root || e.path.startsWith(`${root}/`)) : []
  const skillErrors = errorsUnder(bases?.skills)
  const commandErrors = errorsUnder(bases?.commands)

  // "Create a skill →" starts the same flow as the + New menu's New skill
  // item. Until that flow exists it opens this scope's catalog, when there is one.
  const startNewSkill = onAdd
  // Only a caller with a catalog for this scope can browse it; Project scope has none.
  const newMenu: ExtensionsToolbarMenuItem[] = onAdd
    ? [{ label: 'Browse catalog…', testId: 'skills-new-browse-catalog', onSelect: onAdd }]
    : []

  const renderItem = (i: Item) => {
    const selected = selectedPath === i.path
    const dirty = !!files[i.path]?.dirty
    return (
      <div
        key={i.path}
        data-testid="skills-item"
        data-path={i.path}
        onClick={() => setSelectedPath(i.path)}
        className={`flex flex-col gap-[3px] px-2.5 py-2 bg-bg-hi border rounded-[7px] cursor-pointer ${
          selected ? 'border-accent' : 'border-line hover:border-rule'
        }`}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="skills-item-name"
            aria-current={selected ? 'true' : undefined}
            title={i.disabled ? 'Disabled — Claude will not auto-invoke this skill' : undefined}
            className={`flex-1 min-w-0 truncate text-left font-mono text-[12.5px] font-semibold text-fg ${
              i.disabled ? 'line-through opacity-50' : ''
            }`}
          >
            /{i.name}
          </button>
          <ProvenanceBadge
            interactive={false}
            scope={i.scope}
            input={{ type: i.kind === 'commands' ? 'command' : 'skill', name: i.name }}
          />
          {dirty && <span data-testid="skills-item-dirty" title="Unsaved edits" className="shrink-0 w-1 h-1 rounded-full bg-accent" />}
          {/* Skills can be turned off via frontmatter, or removed; commands cannot.
              These controls act on the skill without selecting its card. */}
          {i.kind === 'skills' && (
            <span className="shrink-0 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <span title={dirty ? 'This skill has unsaved edits — save or revert before toggling' : undefined}>
                <Toggle
                  checked={!i.disabled}
                  disabled={dirty}
                  onChange={(v) => void toggleSkillDisabled(i, !v)}
                />
              </span>
              {confirmRemove === i.path ? (
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void removeSkill(i)}
                    title={`Remove ${i.name} — moves the folder to trash; reinstall from the Library`}
                    className="text-[10px] font-semibold text-red-400 hover:text-red-300"
                  >
                    confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(null)}
                    title="Cancel"
                    className="text-[10px] text-fg-faint hover:text-fg"
                  >
                    cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRemove(i.path)}
                  title="Remove skill — moves the folder to trash; reinstall from the Library"
                  aria-label={`Remove ${i.name}`}
                  className="text-fg-faint hover:text-red-400 leading-none px-0.5"
                >
                  ✕
                </button>
              )}
            </span>
          )}
        </div>
        {i.description && (
          <div data-testid="skills-item-desc" title={i.description} className="truncate text-[11.5px] text-fg-faint">
            {i.description}
          </div>
        )}
      </div>
    )
  }

  // Each section shows its matching cards, else says why it is empty —
  // nothing at all until the first listing lands.
  let skillsBody: ReactNode = null
  if (shownSkills.length > 0) skillsBody = shownSkills.map(renderItem)
  else if (!listed) skillsBody = null
  else if (skillItems.length > 0) skillsBody = <SectionNote>No skills match the filter</SectionNote>
  else if (skillErrors.length > 0) {
    skillsBody = (
      <SectionNote testId="skills-list-skills-error" title={skillErrors.map((e) => `${e.path}: ${e.error}`).join('\n')}>
        Could not list skills
      </SectionNote>
    )
  } else {
    skillsBody = (
      <div
        data-testid="skills-empty"
        className="mx-0.5 mb-1 px-3 py-[11px] flex flex-col gap-[5px] border border-dashed border-rule rounded-[7px] text-xs leading-[1.45] text-fg-dim"
      >
        <span className="font-semibold text-fg">No skills yet</span>
        <span>A skill is a folder with a SKILL.md that Claude loads when a task calls for it.</span>
        {startNewSkill && (
          <button
            type="button"
            data-testid="skills-create-link"
            onClick={() => startNewSkill()}
            className="self-start font-semibold text-accent hover:underline"
          >
            Create a skill →
          </button>
        )}
      </div>
    )
  }

  let commandsBody: ReactNode = null
  if (shownCommands.length > 0) commandsBody = shownCommands.map(renderItem)
  else if (!listed) commandsBody = null
  else if (commandItems.length > 0) commandsBody = <SectionNote>No commands match the filter</SectionNote>
  else if (commandErrors.length > 0) {
    commandsBody = (
      <SectionNote testId="skills-list-commands-error" title={commandErrors.map((e) => `${e.path}: ${e.error}`).join('\n')}>
        Could not list slash commands
      </SectionNote>
    )
  } else commandsBody = <SectionNote>No slash commands</SectionNote>

  return (
    <div className="h-full flex flex-col">
      <ExtensionsToolbar
        filter={filter}
        onFilterChange={setFilter}
        placeholder="Filter skills and commands"
        summary={`${plural(skillItems.length, 'skill', 'skills')} · ${plural(commandItems.length, 'command', 'commands')}`}
        primary={{ label: '+ New', testId: 'skills-new', items: newMenu }}
      />
      <div className="flex-1 min-h-0">
        <Panel
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
            sidebarWidth="300px"
            sidebar={
              <div data-testid="skills-list" className="flex flex-col gap-1 px-2 py-1">
                <SectionHeader label="Skills" count={shownSkills.length} testId="skills-section-skills" />
                {skillsBody}
                <SectionHeader label="Slash commands" count={shownCommands.length} testId="skills-section-commands" />
                {commandsBody}
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
              ) : items.length === 0 && loadErrors.length > 0 ? (
                <div data-testid="skills-list-error">
                  <EmptyState
                    title="could not list skills or commands"
                    hint={loadErrors.map((e) => `${e.path}: ${e.error}`).join('\n')}
                  />
                </div>
              ) : (
                <EmptyState title={items.length === 0 ? 'no skills or commands' : 'select an item'} />
              )
            }
          />
        </Panel>
      </div>
    </div>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const Skills = memo(SkillsComponent)
