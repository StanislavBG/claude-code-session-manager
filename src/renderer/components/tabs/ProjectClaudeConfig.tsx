/**
 * ProjectClaudeConfig — the Project face's one home for this project's own Claude Code
 * files (NavKey `memory`, labeled "Claude config"). Home edits only ~/.claude; every file
 * the claude CLI reads from THIS project's directory is edited here. The page frame is the
 * shared ClaudeConfigShell left rail (design-mocks/claude-config/DESIGN_SPEC.md §1.3, §2) with five
 * tabs and live counts; Plugins and Agents are machine-wide and live on Home only. Each tab
 * reuses the component Home uses, with the project scope passed in; each tab's own left-column
 * file card names its real file and, where the tab has one, owns the Project/Local choice:
 *
 * - Memory    — today's MemoryExplorer (Memory.tsx) over the folder main resolves for this
 *               project (memory.list's `dir`), never a renderer-side guess.
 * - CLAUDE.md — ClaudeMdWorkbench over <cwd>/CLAUDE.md (Project) and <cwd>/CLAUDE.local.md
 *               (Local) as radio rows, loaded and saved through useConfig loadText/saveText. Save never forces, so the store's mtime
 *               conflict check still refuses to overwrite a copy that changed on disk.
 * - Settings  — Settings.tsx at project or local scope; its rail's 'Epic isolation' entry holds
 *               Session Manager's per-project worktree toggle (not a settings.json key).
 * - MCP       — McpServers at project scope (<cwd>/.mcp.json); Add… opens the catalog drawer
 *               at that same scope.
 * - Skills    — Skills at project scope (<cwd>/.claude/skills/).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClaudeConfigShell } from '../claudeConfig/ClaudeConfigShell'
import {
  useConfigSearch,
  claudeMdChip,
  countClaudeMdFiles,
  countSettingsKeys,
  mcpNeedsAttention,
  type ConfigTabSpec,
} from '../claudeConfig/configShared'
import { loadConfigSearchItems, type ConfigSearchItem } from '../../lib/configSearch'
import { useConfigSearchFocus } from '../../state/configSearchFocus'
import { LEARNING_CONTENT } from '../learningContent'
import { shortenHome } from '../ui/SourceChip'
import { EmptyState } from '../ui/EmptyState'
import { ClaudeMdWorkbench, type ClaudeMdRoot } from '../claudeConfig/ClaudeMdWorkbench'
import { HomeSessionDrawer } from './home/HomeSessionDrawer'
import { Memory } from './Memory'
import { Settings } from './Settings'
import { McpServers, type McpAddContext } from './McpServers'
import { Skills } from './Skills'
import { McpLibrary, InsertPresetMenu } from './Library'
import { useConfig } from '../../state/config'
import { usePanelTabHint } from '../../state/layout'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import { encodeWorkspace } from '../../lib/encodeWorkspace'
import { CLAUDE_MD_SCOPES } from '../../lib/scopes'
import { basename } from '../../lib/basename'
import { listSkillEntries } from '../../lib/listSkills'
import { useConfigDirWatch } from '../../lib/useConfigDirWatch'
import { useMcpChecks, selectMcpCheckResults } from '../../state/mcpChecks'
import { buildRows } from './memory/explorer/model'
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

const isConfigTab = (t: string): t is ConfigTab => TABS.some((o) => o.key === t)

/** The files and folders each tab's count reads — also the paths whose changes re-count. */
function countSources(cwd: string, memoryDir: string | null) {
  return {
    claudeMd: [`${cwd}/CLAUDE.md`, `${cwd}/CLAUDE.local.md`],
    settings: { project: `${cwd}/.claude/settings.json`, local: `${cwd}/.claude/settings.local.json` },
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
  /** Any memory the Memory tab would flag stale or broken. */
  memoryAttention: boolean
  /** CLAUDE.md / CLAUDE.local.md that exist, plus each one's resolved @-imports. */
  claudeMd: number | null
  /** Top-level keys set in each scope's settings file. */
  settings: Record<ProjectScope, number | null>
  mcp: number | null
  skills: number | null
}

const NO_COUNTS: ProjectCounts = {
  memoryDir: null, memory: null, memoryAttention: false, claudeMd: null, settings: { project: null, local: null }, mcp: null, skills: null,
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** One count; a failed read is `null` (no chip) — the tab body that owns the file reports the error itself. */
async function settle<T>(p: () => Promise<T>): Promise<T | null> {
  try { return await p() } catch { return null }
}

async function readProjectCounts(cwd: string): Promise<ProjectCounts> {
  const target = { workspace: encodeWorkspace(cwd), cwd }
  const memList = await settle(() => window.api.memory.list(target))
  const src = countSources(cwd, memList?.dir ?? null)
  const [claudeMd, settingsProject, settingsLocal, mcp, skills, memoryAttention] = await Promise.all([
    settle(async () => (await Promise.all(src.claudeMd.map(countClaudeMdFiles))).reduce((a, b) => a + b, 0)),
    settle(() => countSettingsKeys(src.settings.project)),
    settle(() => countSettingsKeys(src.settings.local)),
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
    // The same stale/broken rule the Memory tab's Stale and Broken views use.
    settle(async () => {
      if (!memList || memList.error) return false
      const stale = await window.api.memory.stale(target)
      return buildRows(memList.entries ?? [], stale, null, Date.now()).some((r) => r.stale || r.broken)
    }),
  ])
  return {
    memoryDir: memList?.dir ?? null,
    memory: memList && !memList.error ? memList.entries.length : null,
    memoryAttention: memoryAttention ?? false,
    claudeMd,
    settings: { project: settingsProject, local: settingsLocal },
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
    src ? [...src.claudeMd, src.settings.project, src.settings.local, src.mcp, src.skillsDir, src.commandsDir, src.memoryDir] : [],
    reload,
    { depth: 1 },
  )
  return counts
}

const asCount = (n: number | null): number | undefined => (n == null ? undefined : n)

/**
 * The project's CLAUDE.md / CLAUDE.local.md in the shared ClaudeMdWorkbench (design render 06):
 * the two files are radio rows that own the Project / Local choice, each file's @imports follow,
 * and the selected one is edited through the config store (dirty draft, watch, mtime-checked save).
 */
function ClaudeMdTab({ home, cwd, scope, onScopeChange }: {
  home: string
  cwd: string
  scope: ProjectScope
  onScopeChange: (scope: ProjectScope) => void
}) {
  const paths = useMemo(
    () => ({ project: CLAUDE_MD_SCOPES.resolve('project', home, cwd), local: CLAUDE_MD_SCOPES.resolve('local', home, cwd) }),
    [home, cwd],
  )
  const roots = useMemo(() => {
    const out: ClaudeMdRoot[] = []
    if (paths.project) out.push({ path: paths.project, label: 'Project · shared via git', eyebrow: 'PROJECT INSTRUCTIONS' })
    if (paths.local) out.push({ path: paths.local, label: 'Local · this machine only', eyebrow: 'LOCAL INSTRUCTIONS' })
    return out
  }, [paths])
  const onSelectRoot = useCallback(
    (p: string) => onScopeChange(p === paths.local ? 'local' : 'project'),
    [paths.local, onScopeChange],
  )
  const empty = useMemo(() => ({
    title: scope === 'local' ? 'No private notes for this project yet.' : 'Nothing tells Claude how this repo works yet.',
    body: scope === 'local'
      ? `Claude loads this file into every session started in ${basename(cwd)} on this machine. It stays out of git.`
      : `It loads this file into every session started in ${basename(cwd)} — and so does anyone who clones the repo.`,
  }), [scope, cwd])

  const active = paths[scope]
  if (!active) return <EmptyState title="loading…" />

  return (
    <div data-testid="project-claude-md" className="flex flex-col h-full min-h-0">
      <ClaudeMdWorkbench
        home={home}
        scope="project"
        roots={roots}
        activeRoot={active}
        onSelectRoot={onSelectRoot}
        empty={empty}
        moreMenu={({ importSelected }) => <InsertPresetMenu path={active} disabled={importSelected} />}
      />
    </div>
  )
}

/** Settings at the chosen scope (its file card's radio rows own the Project / Local choice; Epic isolation is a rail entry). */
function SettingsTab({ scope, onScopeChange }: { scope: ProjectScope; onScopeChange: (scope: ProjectScope) => void }) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <Settings scope={scope} onScopeChange={onScopeChange} />
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
  const counts = useProjectConfigCounts(cwd)
  const mcpResults = useMcpChecks(selectMcpCheckResults)
  const mcpAttention = useMemo(() => mcpNeedsAttention(mcpResults), [mcpResults])

  const selectTab = useCallback((t: ConfigTab) => {
    setTab(t)
    setMcpAdd(null)
  }, [])
  usePanelTabHint('memory', (t) => { if (isConfigTab(t)) selectTab(t) })
  const openMcpAdd = useCallback((ctx: McpAddContext) => setMcpAdd(ctx), [])
  const closeMcpAdd = useCallback(() => setMcpAdd(null), [])
  // A chosen search result opens its tab and leaves its id for that tab to select.
  const chooseResult = useCallback((item: ConfigSearchItem) => {
    if (!isConfigTab(item.tab)) return
    selectTab(item.tab)
    useConfigSearchFocus.getState().set(item.tab, item.id)
  }, [selectTab])
  const loadSearchItems = useCallback(
    () => loadConfigSearchItems({ scope: 'project', cwd, api: window.api }),
    [cwd],
  )
  const search = useConfigSearch({ load: loadSearchItems, loadKey: cwd ?? '', onChoose: chooseResult })

  const bandTabs = useMemo<ConfigTabSpec<ConfigTab>[]>(() => {
    const countOf: Record<ConfigTab, Partial<ConfigTabSpec<ConfigTab>>> = {
      memory: { count: asCount(counts.memory), attention: counts.memoryAttention },
      'claude-md': claudeMdChip(counts.claudeMd),
      settings: { count: asCount(counts.settings[settingsScope]) },
      mcp: { count: asCount(counts.mcp), attention: mcpAttention },
      skills: { count: asCount(counts.skills) },
    }
    return TABS.map((t) => ({ ...t, ...countOf[t.key] }))
  }, [counts, settingsScope, mcpAttention])

  if (!home) return <EmptyState title="loading…" />
  if (!cwd) {
    return (
      <EmptyState
        title="no active project"
        hint="open a project tab to edit its CLAUDE.md, settings, MCP servers, skills and memory"
      />
    )
  }

  const learn = LEARNING_CONTENT.memory

  return (
    <ClaudeConfigShell
      testId="project-claude-config"
      eyebrow="CLAUDE CODE · PROJECT"
      title="Claude config"
      scopePath={shortenHome(cwd, home)}
      tabs={bandTabs}
      activeKey={tab}
      onSelect={selectTab}
      search={search}
      learn={learn}
      drawer={
        <HomeSessionDrawer open={mcpAdd !== null} onClose={closeMcpAdd} title="Add MCP server" keyVals={[]}>
          {mcpAdd && <McpLibrary scope={mcpAdd.scope} cwd={mcpAdd.cwd} />}
        </HomeSessionDrawer>
      }
    >
      {tab === 'memory' && <Memory />}
      {tab === 'claude-md' && <ClaudeMdTab home={home} cwd={cwd} scope={mdScope} onScopeChange={setMdScope} />}
      {tab === 'settings' && <SettingsTab scope={settingsScope} onScopeChange={setSettingsScope} />}
      {tab === 'mcp' && <McpServers scope="project" onAdd={openMcpAdd} />}
      {tab === 'skills' && <Skills scope="project" />}
    </ClaudeConfigShell>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const ProjectClaudeConfig = memo(ProjectClaudeConfigComponent)
