/**
 * ProjectClaudeConfig — the Project face's one home for this project's own Claude Code
 * files (NavKey `memory`, labeled "Claude config"). Home edits only ~/.claude; every file
 * the claude CLI reads from THIS project's directory is edited here. The page frame is the
 * shared dark ConfigBand (design-mocks/claude-config/DESIGN_SPEC.md §1.3, §2) with five
 * tabs and live counts; Plugins and Agents are machine-wide and live on Home only. Each tab
 * reuses the component Home uses, with the project scope passed in, under a thin source
 * strip (the Project/Local switch where the tab has one, plus a SourceChip naming the real file):
 *
 * - Memory    — today's MemoryExplorer (Memory.tsx). Its chip names the folder main resolves
 *               for this project (memory.list's `dir`), never a renderer-side guess.
 * - CLAUDE.md — <cwd>/CLAUDE.md (Project) or <cwd>/CLAUDE.local.md (Local), loaded and saved
 *               through useConfig loadText/saveText. Save never forces, so the store's mtime
 *               conflict check still refuses to overwrite a copy that changed on disk.
 * - Settings  — Settings.tsx at project or local scope, below the Epic worktree isolation
 *               toggle, which sits under a chip naming its own file: it is Session Manager's
 *               per-project setting, not a settings.json key.
 * - MCP       — McpServers at project scope (<cwd>/.mcp.json); Add… opens the catalog drawer
 *               at that same scope.
 * - Skills    — Skills at project scope (<cwd>/.claude/skills/).
 */
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ConfigBand, type ConfigBandTab } from '../claudeConfig/ConfigBand'
import { LearningBody } from '../LearningPanel'
import { LEARNING_CONTENT } from '../learningContent'
import { ViewTabs } from '../ui/ViewTabs'
import { SourceChip, shortenHome } from '../ui/SourceChip'
import { SaveBar } from '../ui/SaveBar'
import { EmptyState } from '../ui/EmptyState'
import { DocumentEditorPane } from './editor/DocumentEditorPane'
import { HomeSessionDrawer } from './home/HomeSessionDrawer'
import { Memory } from './Memory'
import { Settings } from './Settings'
import { SettingsEpicIsolation } from './SettingsEpicIsolation'
import { McpServers, type McpAddContext } from './McpServers'
import { Skills } from './Skills'
import { McpLibrary } from './Library'
import { useConfig } from '../../state/config'
import { usePanelTabHint } from '../../state/layout'
import { toast } from '../../state/toast'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import { encodeWorkspace } from '../../lib/encodeWorkspace'
import { CLAUDE_MD_SCOPES } from '../../lib/scopes'
import { listSkillEntries } from '../../lib/listSkills'
import { useConfigDirWatch } from '../../lib/useConfigDirWatch'
import type { AlmanacIconName } from '../layout/AlmanacIcon'

type ConfigTab = 'memory' | 'claude-md' | 'settings' | 'mcp' | 'skills'
type ProjectScope = 'project' | 'local'

/** The five project tabs, in band order. Plugins and Agents are machine-wide: Home only. */
const PROJECT_CLAUDE_CONFIG_TABS: ReadonlyArray<{ key: ConfigTab; label: string; icon: AlmanacIconName }> = [
  { key: 'memory', label: 'Memory', icon: 'memory' },
  { key: 'claude-md', label: 'CLAUDE.md', icon: 'system-prompt' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
  { key: 'mcp', label: 'MCP', icon: 'mcp' },
  { key: 'skills', label: 'Skills', icon: 'skills' },
]
const TABS = PROJECT_CLAUDE_CONFIG_TABS

const SCOPES: ReadonlyArray<{ key: ProjectScope; label: string }> = [
  { key: 'project', label: 'Project' },
  { key: 'local', label: 'Local' },
]

const isConfigTab = (t: string): t is ConfigTab => TABS.some((o) => o.key === t)

/** Where main keeps the per-project isolation toggle: opsPath(cwd, 'prompt-sessions', …) in epicWorktreeProjectConfig.cjs. */
const epicWorktreeConfigPath = (cwd: string) =>
  `${cwd}/session-manager-operations/prompt-sessions/epic-worktree-config.json`

const CLAUDE_MD_NOTES: Record<ProjectScope, { title: string; body: string }> = {
  project: {
    title: 'Project instructions',
    body:
      'This is the real <project>/CLAUDE.md on disk, normally checked into git. The claude CLI loads it into every session started in this project, for anyone who clones it.',
  },
  local: {
    title: 'Local instructions',
    body:
      'This is the real <project>/CLAUDE.local.md on disk: your own notes for this project on this machine, kept out of git. The claude CLI loads it alongside CLAUDE.md.',
  },
}

const CONFLICT_HINT = 'changed on disk since it was loaded. Revert reloads it'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The files and folders each tab's count reads — also the paths whose changes re-count. */
function countSources(cwd: string, memoryDir: string | null) {
  return {
    claudeMd: [`${cwd}/CLAUDE.md`, `${cwd}/CLAUDE.local.md`],
    settings: [`${cwd}/.claude/settings.json`, `${cwd}/.claude/settings.local.json`],
    mcp: `${cwd}/.mcp.json`,
    skillsDir: `${cwd}/.claude/skills`,
    commandsDir: `${cwd}/.claude/commands`,
    memoryDir,
  }
}

interface ProjectCounts {
  /** The memory folder main resolves for this project (memory.list's `dir`), never a renderer-side guess. */
  memoryDir: string | null
  memory: number | null
  /** How many of CLAUDE.md / CLAUDE.local.md exist. */
  claudeMd: number | null
  /** Distinct top-level keys across .claude/settings.json and settings.local.json. */
  settings: number | null
  mcp: number | null
  skills: number | null
}

const NO_COUNTS: ProjectCounts = { memoryDir: null, memory: null, claudeMd: null, settings: null, mcp: null, skills: null }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** One count; a failed read is `null` (no chip) — the tab body that owns the file reports the error itself. */
async function settle<T>(p: () => Promise<T>): Promise<T | null> {
  try { return await p() } catch { return null }
}

async function readProjectCounts(cwd: string): Promise<ProjectCounts> {
  const memList = await settle(() => window.api.memory.list({ workspace: encodeWorkspace(cwd), cwd }))
  const src = countSources(cwd, memList?.dir ?? null)
  const [claudeMd, settings, mcp, skills] = await Promise.all([
    settle(async () => (await Promise.all(src.claudeMd.map((f) => window.api.config.exists(f)))).filter(Boolean).length),
    settle(async () => {
      const keys = new Set<string>()
      for (const r of await Promise.all(src.settings.map((f) => window.api.config.readJson(f)))) {
        if (r.error) throw new Error(r.error)
        if (isRecord(r.data)) Object.keys(r.data).forEach((k) => keys.add(k))
      }
      return keys.size
    }),
    settle(async () => {
      const r = await window.api.config.readJson(src.mcp)
      if (r.error) throw new Error(r.error)
      const servers = isRecord(r.data) ? r.data.mcpServers : undefined
      return isRecord(servers) ? Object.keys(servers).length : 0
    }),
    // Same totals the Skills tab lists: skill folders plus *.md commands.
    settle(async () => {
      const [list, cmds] = await Promise.all([
        listSkillEntries(src.skillsDir),
        window.api.config.listDir(src.commandsDir, { filesOnly: true }),
      ])
      if (list.errors[0]) throw new Error(list.errors[0].error)
      const commands = cmds.ok ? cmds.entries.filter((e) => e.name.endsWith('.md')).length : 0
      return list.entries.length + commands
    }),
  ])
  return {
    memoryDir: memList?.dir ?? null,
    memory: memList && !memList.error ? memList.entries.length : null,
    claudeMd,
    settings,
    mcp,
    skills,
  }
}

/**
 * Live counts for the band's five tabs, read through the same window.api readers the tab
 * bodies use. Every source path is watched; a change re-reads all counts (they are cheap).
 * Keyed by cwd so a project switch never shows the previous project's numbers.
 */
function useProjectConfigCounts(cwd: string | null): ProjectCounts {
  const [found, setFound] = useState<{ cwd: string; counts: ProjectCounts } | null>(null)
  const reqId = useRef(0)

  const reload = useCallback(() => {
    if (!cwd) return
    const id = ++reqId.current
    void readProjectCounts(cwd).then((counts) => {
      if (id === reqId.current) setFound({ cwd, counts })
    })
  }, [cwd])

  useEffect(() => {
    reload()
    return () => { reqId.current++ }
  }, [reload])

  const counts = found && found.cwd === cwd ? found.counts : NO_COUNTS
  const src = cwd ? countSources(cwd, counts.memoryDir) : null
  useConfigDirWatch(
    src ? [...src.claudeMd, ...src.settings, src.mcp, src.skillsDir, src.commandsDir, src.memoryDir] : [],
    reload,
    { depth: 1 },
  )
  return counts
}

const asCount = (n: number | null): number | undefined => (n == null ? undefined : n)

/** One CLAUDE.md-family file, edited through the config store (dirty draft, watch, mtime-checked save). */
function ClaudeMdTab({ path, scope }: { path: string; scope: ProjectScope }) {
  const file = useConfig((s) => s.files[path])
  const loadText = useConfig((s) => s.loadText)
  const setDraft = useConfig((s) => s.setDraft)
  const saveText = useConfig((s) => s.saveText)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    // Re-read on every open so edits made elsewhere show up; keepDirty keeps an unsaved draft.
    loadText(path, true).catch((e: unknown) => toast.error(`Couldn't read ${path}: ${errText(e)}`))
    watchFile(path)
    return () => { unwatchFile(path) }
  }, [path, loadText, watchFile, unwatchFile])

  const save = useCallback(async () => {
    setSaveError(null)
    // No `force`: saveText refuses with 'conflict' (and toasts) when the disk copy is newer than the draft's base.
    const res = await saveText(path)
    if (!res.ok) setSaveError(res.error === 'conflict' ? CONFLICT_HINT : res.error ?? 'save failed')
  }, [path, saveText])

  // Revert re-reads the file rather than restoring the cached copy, so after a conflict the
  // draft is rebased on what is on disk now and the next save is checked against it.
  const reload = useCallback(() => {
    setSaveError(null)
    loadText(path).catch((e: unknown) => toast.error(`Couldn't read ${path}: ${errText(e)}`))
  }, [path, loadText])

  if (!file) return <EmptyState title="loading…" />
  const note = CLAUDE_MD_NOTES[scope]

  return (
    <div data-testid="project-claude-md" className="flex flex-col h-full min-h-0">
      <div className="shrink-0 border-b border-line bg-bg-elev px-3 py-2 text-[11.5px] leading-snug">
        <span className="font-semibold text-fg">{note.title}</span>
        <span className="mx-1.5 text-fg-faint">·</span>
        <span className="text-fg-dim">{note.body}</span>
      </div>
      {file.loadError && (
        <div role="alert" className="shrink-0 border-b border-line px-3 py-1.5 text-[11px] text-red-400">
          {file.loadError}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <DocumentEditorPane
          path={path}
          value={file.draftRaw}
          defaultMode="split"
          onChange={(v) => {
            setSaveError(null)
            setDraft(path, v)
          }}
          onSave={() => { void save() }}
        />
      </div>
      <div className="shrink-0 border-t border-line">
        <SaveBar
          dirty={file.dirty}
          busy={file.busy}
          parseError={saveError}
          lastSavedAt={file.lastSavedAt}
          leading={file.exists ? null : <span>file will be created on save</span>}
          onSave={() => { void save() }}
          onRevert={reload}
        />
      </div>
    </div>
  )
}

/** Settings at the chosen scope, below the Epic isolation toggle shown with its own file. */
function SettingsTab({ cwd, scope }: { cwd: string; scope: ProjectScope }) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div data-testid="project-claude-config-epic-isolation" className="shrink-0">
        <div className="flex items-center gap-2 border-b border-line bg-bg-elev px-3 pt-2 pb-1.5 text-[11px] text-fg-dim">
          <span className="font-semibold text-fg">Epic isolation</span>
          <span className="truncate">Session Manager's own setting for this project, not a settings.json key</span>
          <SourceChip path={epicWorktreeConfigPath(cwd)} />
        </div>
        <SettingsEpicIsolation cwd={cwd} />
      </div>
      <div className="flex-1 min-h-0">
        <Settings scope={scope} />
      </div>
    </div>
  )
}

/** A thin strip at the top of a tab body: the Project/Local switch where the tab has one, then the real file. */
function SourceStrip({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="project-claude-config-source"
      className="shrink-0 flex items-center gap-3 min-w-0 px-7 py-1.5 border-b border-line"
    >
      {children}
    </div>
  )
}

function ProjectClaudeConfigComponent() {
  const home = useHomeDir()
  const cwd = useActiveTab()?.cwd ?? null
  const [tab, setTab] = useState<ConfigTab>('memory')
  const [mdScope, setMdScope] = useState<ProjectScope>('project')
  const [settingsScope, setSettingsScope] = useState<ProjectScope>('project')
  const [mcpAdd, setMcpAdd] = useState<McpAddContext | null>(null)
  const [learnOpen, setLearnOpen] = useState(false)
  const counts = useProjectConfigCounts(cwd)
  const memoryDir = counts.memoryDir

  const selectTab = useCallback((t: ConfigTab) => {
    setTab(t)
    setMcpAdd(null)
  }, [])
  usePanelTabHint('memory', (t) => { if (isConfigTab(t)) selectTab(t) })
  const openMcpAdd = useCallback((ctx: McpAddContext) => setMcpAdd(ctx), [])
  const closeMcpAdd = useCallback(() => setMcpAdd(null), [])
  const toggleLearn = useCallback(() => setLearnOpen((o) => !o), [])

  const bandTabs = useMemo<ConfigBandTab<ConfigTab>[]>(() => {
    const md = counts.claudeMd
    const mdTab = md == null ? {} : md === 0 ? { count: 'missing', warn: true } : { count: `${md} ${md === 1 ? 'file' : 'files'}` }
    const countOf: Record<ConfigTab, Partial<ConfigBandTab<ConfigTab>>> = {
      memory: { count: asCount(counts.memory) },
      'claude-md': mdTab,
      settings: { count: asCount(counts.settings) },
      mcp: { count: asCount(counts.mcp) },
      skills: { count: asCount(counts.skills) },
    }
    return TABS.map((t) => ({ ...t, ...countOf[t.key] }))
  }, [counts.memory, counts.claudeMd, counts.settings, counts.mcp, counts.skills])

  if (!home) return <EmptyState title="loading…" />
  if (!cwd) {
    return (
      <EmptyState
        title="no active project"
        hint="open a project tab to edit its CLAUDE.md, settings, MCP servers, skills and memory"
      />
    )
  }

  const mdPath = CLAUDE_MD_SCOPES.resolve(mdScope, home, cwd)
  const learn = LEARNING_CONTENT.memory

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg text-fg" data-testid="project-claude-config">
      <ConfigBand
        eyebrow="CLAUDE CODE · PROJECT"
        title="Claude config"
        scopePath={shortenHome(cwd, home)}
        tabs={bandTabs}
        activeKey={tab}
        onSelect={selectTab}
        onLearn={toggleLearn}
      />
      {learnOpen && learn && (
        <div className="shrink-0 border-b border-line bg-bg-elev px-7 py-4 max-h-[40vh] overflow-y-auto" data-testid="project-claude-config-learn">
          <LearningBody content={learn} />
        </div>
      )}
      <SourceStrip>
        {tab === 'claude-md' && <ViewTabs options={SCOPES} active={mdScope} onChange={setMdScope} />}
        {tab === 'settings' && <ViewTabs options={SCOPES} active={settingsScope} onChange={setSettingsScope} />}
        {tab === 'memory' && memoryDir && <SourceChip path={memoryDir} note="Open this project's memory folder" />}
        {tab === 'claude-md' && mdPath && <SourceChip path={mdPath} />}
        {/* Settings: its own body chips every view's file; the Epic isolation chip sits with its toggle. */}
        {tab === 'mcp' && <SourceChip path={`${cwd}/.mcp.json`} keyPath={['mcpServers']} />}
        {tab === 'skills' && <SourceChip path={`${cwd}/.claude/skills`} note={`Open ${cwd}/.claude/skills/`} />}
      </SourceStrip>
      <div className="flex-1 min-h-0" data-testid={`project-claude-config-panel-${tab}`}>
        {tab === 'memory' && <Memory />}
        {tab === 'claude-md' && mdPath && <ClaudeMdTab key={mdPath} path={mdPath} scope={mdScope} />}
        {tab === 'settings' && <SettingsTab cwd={cwd} scope={settingsScope} />}
        {tab === 'mcp' && <McpServers scope="project" onAdd={openMcpAdd} />}
        {tab === 'skills' && <Skills scope="project" />}
      </div>
      <HomeSessionDrawer open={mcpAdd !== null} onClose={closeMcpAdd} title="Add MCP server" keyVals={[]}>
        {mcpAdd && <McpLibrary scope={mcpAdd.scope} cwd={mcpAdd.cwd} />}
      </HomeSessionDrawer>
    </div>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const ProjectClaudeConfig = memo(ProjectClaudeConfigComponent)
