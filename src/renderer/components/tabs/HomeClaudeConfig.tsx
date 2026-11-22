/**
 * HomeClaudeConfig — Home's one "Claude config" page over `~/.claude`: the dark
 * ConfigBand plus six tabs, each mounting the existing page for that area at
 * user scope (design-mocks/claude-config/DESIGN_SPEC.md §1.2, §2). The four
 * retired Home rows (system-prompt / settings / extensions / agent-library)
 * route here through lib/navGroups.ts's NAV_KEY_ALIASES.
 *
 * Per-tab redesign is NOT here — each tab renders today's page as it is.
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { ConfigBand, ConfigSearchResults, useConfigSearch, type ConfigBandTab } from '../claudeConfig/ConfigBand'
import { loadConfigSearchItems, type ConfigSearchItem } from '../../lib/configSearch'
import { useConfigSearchFocus } from '../../state/configSearchFocus'
import { LearningBody } from '../LearningPanel'
import { LEARNING_CONTENT } from '../learningContent'
import { useLayout } from '../../state/layout'
import { useExtensionCounts } from '../../lib/useExtensionCounts'
import { useAgentPersonasState } from '../../lib/useAgentPersonas'
import { HOME_CLAUDE_CONFIG_TABS, isHomeConfigTab, type HomeConfigTab } from '../../lib/navGroups'
import type { NavKey } from '../../lib/navKey'
import { HomeSessionDrawer } from './home/HomeSessionDrawer'
import { SystemPrompt } from './SystemPrompt'
import { Settings } from './Settings'
import { McpServers, type McpAddContext } from './McpServers'
import { Skills } from './Skills'
import { Plugins } from './Plugins'
import { AgentLibrary } from './AgentLibrary'
import { SkillsLibrary, McpLibrary, PluginsLibrary } from './Library'

/** Learn content still lives under the retired page keys. */
const LEARN_KEY: Record<HomeConfigTab, NavKey> = {
  'claude-md': 'system-prompt',
  settings: 'settings',
  mcp: 'extensions',
  skills: 'extensions',
  plugins: 'extensions',
  agents: 'agent-library',
}

type DrawerTab = 'skills' | 'mcp' | 'plugins'
const DRAWER_TITLE: Record<DrawerTab, string> = {
  skills: 'Add skill',
  mcp: 'Add MCP server',
  plugins: 'Add plugin',
}

const asCount = (n: number | null | undefined): number | undefined => (n == null ? undefined : n)

const loadHomeSearchItems = () => loadConfigSearchItems({ scope: 'home', cwd: null, api: window.api })

function HomeClaudeConfigComponent({ initialTab = 'claude-md' }: { initialTab?: HomeConfigTab }) {
  const [tab, setTab] = useState<HomeConfigTab>(initialTab)
  const [drawer, setDrawer] = useState(false)
  const [learnOpen, setLearnOpen] = useState(false)
  const [mcpCtx, setMcpCtx] = useState<McpAddContext>({ scope: 'user', cwd: null })

  const counts = useExtensionCounts()
  const { personas } = useAgentPersonasState()

  // Tab hint: `<tab>` or `settings:<view>`. A Settings view is forwarded to the
  // Settings page's own 'settings' hint (consumed when it mounts) in one set().
  const hint = useLayout((s) => s.panelTabHint)
  useEffect(() => {
    if (!hint || hint.id !== 'claude-config') return
    const [outer, inner] = hint.tab.split(':')
    if (isHomeConfigTab(outer)) { setTab(outer); setDrawer(false) }
    useLayout.setState({ panelTabHint: outer === 'settings' && inner ? { id: 'settings', tab: inner } : null })
  }, [hint])

  const selectTab = useCallback((t: HomeConfigTab) => { setTab(t); setDrawer(false) }, [])
  const closeDrawer = useCallback(() => setDrawer(false), [])
  const add = useCallback(() => setDrawer(true), [])
  const addMcp = useCallback((ctx: McpAddContext) => { setMcpCtx(ctx); setDrawer(true) }, [])
  const toggleLearn = useCallback(() => setLearnOpen((o) => !o), [])
  // A chosen search result opens its tab and leaves its id for that tab to select.
  const chooseResult = useCallback((item: ConfigSearchItem) => {
    if (!isHomeConfigTab(item.tab)) return
    selectTab(item.tab)
    useConfigSearchFocus.getState().set(item.tab, item.id)
  }, [selectTab])
  const search = useConfigSearch({ load: loadHomeSearchItems, loadKey: 'home', onChoose: chooseResult })

  const bandTabs = useMemo<ConfigBandTab<HomeConfigTab>[]>(() => {
    const countOf: Partial<Record<HomeConfigTab, number | undefined>> = {
      mcp: asCount(counts.mcp),
      skills: asCount(counts.skills),
      plugins: asCount(counts.plugins),
      agents: asCount(personas?.length),
    }
    return HOME_CLAUDE_CONFIG_TABS.map((t) => ({ ...t, count: countOf[t.key] }))
  }, [counts.mcp, counts.skills, counts.plugins, personas])

  const learn = LEARNING_CONTENT[LEARN_KEY[tab]]
  const drawerTab: DrawerTab | null = tab === 'skills' || tab === 'mcp' || tab === 'plugins' ? tab : null

  return (
    <div className="h-full w-full flex flex-col bg-bg text-fg" data-testid="home-claude-config">
      <ConfigBand
        eyebrow="CLAUDE CODE · GLOBAL"
        title="Claude config"
        scopePath="~/.claude"
        tabs={bandTabs}
        activeKey={tab}
        onSelect={selectTab}
        onLearn={toggleLearn}
        {...search.bandProps}
        searchPanel={<ConfigSearchResults {...search.panelProps} tabs={bandTabs} />}
      />
      {learnOpen && learn && (
        <div className="shrink-0 border-b border-line bg-bg-elev px-7 py-4 max-h-[40vh] overflow-y-auto" data-testid="home-claude-config-learn">
          <LearningBody content={learn} />
        </div>
      )}
      <div className="flex-1 min-h-0 px-8 py-6" data-testid={`home-claude-config-panel-${tab}`}>
        {tab === 'claude-md' && <SystemPrompt />}
        {tab === 'settings' && <Settings scope="user" />}
        {tab === 'mcp' && <McpServers onAdd={addMcp} scope="user" />}
        {tab === 'skills' && <Skills onAdd={add} scope="user" />}
        {/* A plugin card's skills/MCP chip switches to the tab that lists them. */}
        {tab === 'plugins' && <Plugins onAdd={add} onJump={selectTab} />}
        {tab === 'agents' && <AgentLibrary />}
      </div>
      {drawerTab && (
        <HomeSessionDrawer open={drawer} onClose={closeDrawer} title={DRAWER_TITLE[drawerTab]} keyVals={[]}>
          {drawerTab === 'skills' && <SkillsLibrary />}
          {drawerTab === 'mcp' && <McpLibrary scope={mcpCtx.scope} cwd={mcpCtx.cwd} />}
          {drawerTab === 'plugins' && <PluginsLibrary />}
        </HomeSessionDrawer>
      )}
    </div>
  )
}

export const HomeClaudeConfig = memo(HomeClaudeConfigComponent)
