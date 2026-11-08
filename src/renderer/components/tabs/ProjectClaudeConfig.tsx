/**
 * ProjectClaudeConfig — the Project face's one home for this project's own Claude Code
 * files (NavKey `memory`, labeled "Claude config"). Home edits only ~/.claude; every file
 * the claude CLI reads from THIS project's directory is edited here, one tab per file
 * family. Each tab reuses the component Home uses, with the project scope passed in, and
 * carries a SourceChip naming the real file:
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
import { memo, useCallback, useEffect, useState } from 'react'
import { ViewTabs } from '../ui/ViewTabs'
import { SourceChip } from '../ui/SourceChip'
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

type ConfigTab = 'memory' | 'claude-md' | 'settings' | 'mcp' | 'skills'
type ProjectScope = 'project' | 'local'

const TABS: ReadonlyArray<{ key: ConfigTab; label: string }> = [
  { key: 'memory', label: 'Memory' },
  { key: 'claude-md', label: 'CLAUDE.md' },
  { key: 'settings', label: 'Settings' },
  { key: 'mcp', label: 'MCP' },
  { key: 'skills', label: 'Skills' },
]

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

/**
 * The memory folder main resolves for this project: the same memory.list target the
 * Explorer's workspace scope uses, read only for its `dir`. Keyed by cwd so a project
 * switch never shows the previous project's folder.
 */
function useProjectMemoryDir(cwd: string | null): string | null {
  const [found, setFound] = useState<{ cwd: string; dir: string } | null>(null)
  useEffect(() => {
    if (!cwd) return
    let live = true
    Promise.resolve()
      .then(() => window.api.memory.list({ workspace: encodeWorkspace(cwd), cwd }))
      .then((r) => { if (live && r.dir) setFound({ cwd, dir: r.dir }) })
      // The Explorer's own memory.list call reports this failure as a toast; the chip just stays off.
      .catch(() => {})
    return () => { live = false }
  }, [cwd])
  return found && found.cwd === cwd ? found.dir : null
}

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

function ProjectClaudeConfigComponent() {
  const home = useHomeDir()
  const cwd = useActiveTab()?.cwd ?? null
  const [tab, setTab] = useState<ConfigTab>('memory')
  const [mdScope, setMdScope] = useState<ProjectScope>('project')
  const [settingsScope, setSettingsScope] = useState<ProjectScope>('project')
  const [mcpAdd, setMcpAdd] = useState<McpAddContext | null>(null)
  const memoryDir = useProjectMemoryDir(cwd)

  const selectTab = useCallback((t: ConfigTab) => {
    setTab(t)
    setMcpAdd(null)
  }, [])
  usePanelTabHint('memory', (t) => { if (isConfigTab(t)) selectTab(t) })
  const openMcpAdd = useCallback((ctx: McpAddContext) => setMcpAdd(ctx), [])
  const closeMcpAdd = useCallback(() => setMcpAdd(null), [])

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

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="project-claude-config">
      <div
        data-testid="project-claude-config-toolbar"
        className="shrink-0 flex items-center gap-3 min-w-0 px-3 py-1.5 border-b border-line"
      >
        <ViewTabs options={TABS} active={tab} onChange={selectTab} />
        {tab === 'claude-md' && <ViewTabs options={SCOPES} active={mdScope} onChange={setMdScope} />}
        {tab === 'settings' && <ViewTabs options={SCOPES} active={settingsScope} onChange={setSettingsScope} />}
        {tab === 'memory' && memoryDir && <SourceChip path={memoryDir} note="Open this project's memory folder" />}
        {tab === 'claude-md' && mdPath && <SourceChip path={mdPath} />}
        {/* Settings: its own body chips every view's file; the Epic isolation chip sits with its toggle. */}
        {tab === 'mcp' && <SourceChip path={`${cwd}/.mcp.json`} keyPath={['mcpServers']} />}
        {tab === 'skills' && <SourceChip path={`${cwd}/.claude/skills`} note={`Open ${cwd}/.claude/skills/`} />}
      </div>
      <div className="flex-1 min-h-0">
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
