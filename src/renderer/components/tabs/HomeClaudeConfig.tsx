/**
 * HomeClaudeConfig — Home's one "Claude config" page over `~/.claude`: the ClaudeConfigShell rail
 * plus six tabs, each mounting the existing page for that area at user scope
 * (design-mocks/claude-config/DESIGN_SPEC.md §1.2, §2). The four
 * retired Home rows (system-prompt / settings / extensions / agent-library)
 * route here through lib/navGroups.ts's NAV_KEY_ALIASES.
 *
 * Per-tab redesign is NOT here — each tab renders today's page as it is.
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
import { useLayout } from '../../state/layout'
import { useExtensionCounts } from '../../lib/useExtensionCounts'
import { useAgentPersonasState } from '../../lib/useAgentPersonas'
import { useHomeDir } from '../../lib/useHomeDir'
import { useConfigDirWatch } from '../../lib/useConfigDirWatch'
import { useMcpChecks, selectMcpCheckResults } from '../../state/mcpChecks'
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

/** One count; a failed read is `null` (no chip) — the tab body that owns the file reports the error. */
async function settle<T>(p: () => Promise<T>): Promise<T | null> {
  try { return await p() } catch { return null }
}

interface HomeFileCounts { claudeMd: number | null; settings: number | null }

/** Live CLAUDE.md file count and settings.json key count for ~/.claude, re-read when either file changes. */
function useHomeFileCounts(): HomeFileCounts {
  const home = useHomeDir()
  const [counts, setCounts] = useState<HomeFileCounts>({ claudeMd: null, settings: null })
  const reqId = useRef(0)
  const md = home ? `${home}/.claude/CLAUDE.md` : null
  const settings = home ? `${home}/.claude/settings.json` : null
  const reload = useCallback(() => {
    if (!md || !settings) return
    const id = ++reqId.current
    void Promise.all([settle(() => countClaudeMdFiles(md)), settle(() => countSettingsKeys(settings))]).then(([c, k]) => {
      if (id === reqId.current) setCounts({ claudeMd: c, settings: k })
    })
  }, [md, settings])
  useEffect(() => {
    reload()
    return () => { reqId.current++ }
  }, [reload])
  useConfigDirWatch([md, settings], reload)
  return counts
}

const loadHomeSearchItems = () => loadConfigSearchItems({ scope: 'home', cwd: null, api: window.api })

function HomeClaudeConfigComponent({ initialTab = 'claude-md' }: { initialTab?: HomeConfigTab }) {
  const [tab, setTab] = useState<HomeConfigTab>(initialTab)
  const [drawer, setDrawer] = useState(false)
  const [mcpCtx, setMcpCtx] = useState<McpAddContext>({ scope: 'user', cwd: null })

  const counts = useExtensionCounts()
  const { personas } = useAgentPersonasState()
  const files = useHomeFileCounts()
  const mcpResults = useMcpChecks(selectMcpCheckResults)
  const mcpAttention = useMemo(() => mcpNeedsAttention(mcpResults), [mcpResults])

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
  // A chosen search result opens its tab and leaves its id for that tab to select.
  const chooseResult = useCallback((item: ConfigSearchItem) => {
    if (!isHomeConfigTab(item.tab)) return
    selectTab(item.tab)
    useConfigSearchFocus.getState().set(item.tab, item.id)
  }, [selectTab])
  const search = useConfigSearch({ load: loadHomeSearchItems, loadKey: 'home', onChoose: chooseResult })

  const railTabs = useMemo<ConfigTabSpec<HomeConfigTab>[]>(() => {
    const extra: Record<HomeConfigTab, Partial<ConfigTabSpec<HomeConfigTab>>> = {
      'claude-md': claudeMdChip(files.claudeMd),
      settings: { count: asCount(files.settings) },
      mcp: { count: asCount(counts.mcp), attention: mcpAttention },
      skills: { count: asCount(counts.skills) },
      plugins: { count: asCount(counts.plugins) },
      agents: { count: asCount(personas?.length) },
    }
    return HOME_CLAUDE_CONFIG_TABS.map((t) => ({ ...t, ...extra[t.key] }))
  }, [files.claudeMd, files.settings, counts.mcp, counts.skills, counts.plugins, personas, mcpAttention])

  const learn = LEARNING_CONTENT[LEARN_KEY[tab]]
  const drawerTab: DrawerTab | null = tab === 'skills' || tab === 'mcp' || tab === 'plugins' ? tab : null

  return (
    <ClaudeConfigShell
      testId="home-claude-config"
      eyebrow="CLAUDE CODE · GLOBAL"
      title="Claude config"
      scopePath="~/.claude"
      tabs={railTabs}
      activeKey={tab}
      onSelect={selectTab}
      search={search}
      learn={learn}
      drawer={
        drawerTab && (
          <HomeSessionDrawer open={drawer} onClose={closeDrawer} title={DRAWER_TITLE[drawerTab]} keyVals={[]}>
            {drawerTab === 'skills' && <SkillsLibrary />}
            {drawerTab === 'mcp' && <McpLibrary scope={mcpCtx.scope} cwd={mcpCtx.cwd} />}
            {drawerTab === 'plugins' && <PluginsLibrary />}
          </HomeSessionDrawer>
        )
      }
    >
      {tab === 'claude-md' && <SystemPrompt />}
      {tab === 'settings' && <Settings scope="user" />}
      {tab === 'mcp' && <McpServers onAdd={addMcp} scope="user" />}
      {tab === 'skills' && <Skills onAdd={add} scope="user" />}
      {/* A plugin card's skills/MCP chip switches to the tab that lists them. */}
      {tab === 'plugins' && <Plugins onAdd={add} onJump={selectTab} />}
      {tab === 'agents' && <AgentLibrary />}
    </ClaudeConfigShell>
  )
}

export const HomeClaudeConfig = memo(HomeClaudeConfigComponent)
