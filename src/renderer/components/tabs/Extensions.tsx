/**
 * Extensions — one page for Skills, MCP Servers and Plugins, in the 3a frame
 * (design-mocks/extensions-3a/DESIGN_SPEC.md §1): folder tabs carrying each tab's
 * count, the files the active tab edits (with their on-disk age) on the right, and
 * the active tab opening into a bordered panel that holds its body. Each body's
 * Add… opens that tab's catalog panel in a drawer.
 */
import { memo, useCallback, useMemo, useState } from 'react'
import { FolderTabs } from '../ui/FolderTabs'
import { shortenHome } from '../ui/SourceChip'
import { usePanelTabHint } from '../../state/layout'
import { useHomeDir } from '../../lib/useHomeDir'
import { useExtensionCounts } from '../../lib/useExtensionCounts'
import { formatSourceAge, useFileAges, type FileAge, type FileAgeSource } from '../../lib/useFileAges'
import { HomeSessionDrawer } from './home/HomeSessionDrawer'
import { Skills } from './Skills'
import { McpServers, type McpAddContext } from './McpServers'
import { Plugins } from './Plugins'
import { SkillsLibrary, McpLibrary, PluginsLibrary } from './Library'

type ExtTab = 'skills' | 'mcp' | 'plugins'

const DRAWER_TITLE: Record<ExtTab, string> = {
  skills: 'Add skill',
  mcp: 'Add MCP server',
  plugins: 'Add plugin',
}

/** A file (or folder) a tab edits; `keyPath` names the key it owns inside a shared file. */
interface ExtSource extends FileAgeSource {
  keyPath?: string
}

/** The user-scope files each tab's body reads and writes. */
function sourcesOf(home: string): Record<ExtTab, ExtSource[]> {
  return {
    skills: [{ path: `${home}/.claude/skills`, kind: 'dir' }],
    mcp: [{ path: `${home}/.claude.json`, kind: 'file', keyPath: 'mcpServers' }],
    plugins: [
      { path: `${home}/.claude/plugins/installed_plugins.json`, kind: 'file' },
      { path: `${home}/.claude/settings.json`, kind: 'file', keyPath: 'enabledPlugins' },
    ],
  }
}

const NO_SOURCES: ExtSource[] = []

/** `<mono ~path[ › key]> · <age>` per source; the age is left off while unknown (loading, or a folder that exists). */
function SourceList({ sources, ages, home }: { sources: ExtSource[]; ages: Record<string, FileAge>; home: string }) {
  return (
    <div className="flex flex-wrap justify-end gap-x-[18px] gap-y-1 text-[11.5px] text-fg-faint">
      {sources.map((s) => {
        const age: FileAge | undefined = ages[s.path]
        const label = age === undefined ? null : formatSourceAge(age)
        return (
          <span key={s.path} data-testid="extensions-source" title={s.path} className="whitespace-nowrap">
            <span className="font-mono text-fg-dim">
              {shortenHome(s.path, home)}{s.keyPath ? ` › ${s.keyPath}` : ''}
            </span>
            {label && ` · ${label}`}
          </span>
        )
      })}
    </div>
  )
}

function ExtensionsComponent() {
  const home = useHomeDir()
  const counts = useExtensionCounts()
  const [tab, setTab] = useState<ExtTab>('skills')
  const [drawer, setDrawer] = useState(false)
  const [mcpCtx, setMcpCtx] = useState<McpAddContext>({ scope: 'user', cwd: null })
  usePanelTabHint('extensions', (t) => {
    if (t === 'skills' || t === 'mcp' || t === 'plugins') { setTab(t); setDrawer(false) }
  })

  const sources = useMemo(() => (home ? sourcesOf(home) : null), [home])
  // Every tab's sources are aged up front, so switching tabs never shows a bare path first.
  const allSources = useMemo(
    () => (sources ? [...sources.skills, ...sources.mcp, ...sources.plugins] : NO_SOURCES),
    [sources],
  )
  const ages = useFileAges(allSources)

  const selectTab = useCallback((t: ExtTab) => { setTab(t); setDrawer(false) }, [])
  const closeDrawer = useCallback(() => setDrawer(false), [])
  const addMcp = useCallback((ctx: McpAddContext) => { setMcpCtx(ctx); setDrawer(true) }, [])
  const add = useCallback(() => setDrawer(true), [])

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="extensions">
      {/* 24px below the subtitle; -mb-px + z-[1] lay the active folder tab over the panel's top border. */}
      <div className="shrink-0 mt-6 -mb-px relative z-[1]" data-testid="extensions-tabs">
        <FolderTabs
          ariaLabel="Extensions"
          options={[
            { key: 'skills', label: 'Skills', count: counts.skills },
            { key: 'mcp', label: 'MCP Servers', count: counts.mcp },
            { key: 'plugins', label: 'Plugins', count: counts.plugins },
          ]}
          active={tab}
          onChange={selectTab}
          trailing={home && sources ? <SourceList sources={sources[tab]} ages={ages} home={home} /> : null}
        />
      </div>
      <div className="flex-1 min-h-0 border border-line bg-bg" data-testid="extensions-panel">
        {tab === 'skills' && <Skills onAdd={add} scope="user" />}
        {tab === 'mcp' && <McpServers onAdd={addMcp} scope="user" />}
        {tab === 'plugins' && <Plugins onAdd={add} />}
      </div>
      <HomeSessionDrawer open={drawer} onClose={closeDrawer} title={DRAWER_TITLE[tab]} keyVals={[]}>
        {tab === 'skills' && <SkillsLibrary />}
        {tab === 'mcp' && <McpLibrary scope={mcpCtx.scope} cwd={mcpCtx.cwd} />}
        {tab === 'plugins' && <PluginsLibrary />}
      </HomeSessionDrawer>
    </div>
  )
}

export const Extensions = memo(ExtensionsComponent)
