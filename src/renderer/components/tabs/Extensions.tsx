/**
 * Extensions — one page for Skills, MCP Servers and Plugins. Each tab mounts the
 * existing body, shows a SourceChip for the file it edits, and an Add… button
 * that opens that tab's catalog panel in a drawer.
 */
import { memo, useCallback, useState } from 'react'
import { ViewTabs } from '../ui/ViewTabs'
import { SourceChip } from '../ui/SourceChip'
import { usePanelTabHint } from '../../state/layout'
import { useHomeDir } from '../../lib/useHomeDir'
import { HomeSessionDrawer } from './home/HomeSessionDrawer'
import { Skills } from './Skills'
import { McpServers, type McpAddContext } from './McpServers'
import { Plugins } from './Plugins'
import { SkillsLibrary, McpLibrary, PluginsLibrary } from './Library'

type ExtTab = 'skills' | 'mcp' | 'plugins'

const OPTIONS: ReadonlyArray<{ key: ExtTab; label: string }> = [
  { key: 'skills', label: 'Skills' },
  { key: 'mcp', label: 'MCP Servers' },
  { key: 'plugins', label: 'Plugins' },
]

const DRAWER_TITLE: Record<ExtTab, string> = {
  skills: 'Add skill',
  mcp: 'Add MCP server',
  plugins: 'Add plugin',
}

function ExtensionsComponent() {
  const home = useHomeDir()
  const [tab, setTab] = useState<ExtTab>('skills')
  usePanelTabHint('extensions', (t) => {
    if (t === 'skills' || t === 'mcp' || t === 'plugins') { setTab(t); setDrawer(false) }
  })
  const [drawer, setDrawer] = useState(false)
  const [mcpCtx, setMcpCtx] = useState<McpAddContext>({ scope: 'user', cwd: null })

  const closeDrawer = useCallback(() => setDrawer(false), [])
  const addMcp = useCallback((ctx: McpAddContext) => { setMcpCtx(ctx); setDrawer(true) }, [])
  const add = useCallback(() => setDrawer(true), [])

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="extensions">
      <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-b border-line">
        <ViewTabs options={OPTIONS} active={tab} onChange={(t) => { setTab(t); setDrawer(false) }} />
        {home && tab === 'skills' && <SourceChip path={`${home}/.claude/skills`} note="Open ~/.claude/skills/" />}
        {home && tab === 'mcp' && <SourceChip path={`${home}/.claude.json`} keyPath={['mcpServers']} />}
        {home && tab === 'plugins' && (
          <>
            <SourceChip path={`${home}/.claude/plugins/installed_plugins.json`} />
            <SourceChip path={`${home}/.claude/settings.json`} keyPath={['enabledPlugins']} />
          </>
        )}
      </div>
      <div className="flex-1 min-h-0">
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
