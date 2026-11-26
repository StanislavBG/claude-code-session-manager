// Bundle entry for the real-Chromium Agent character-sheet screenshot spec. Mounts the real Agents
// tab (AgentLibrary) over a stub window.api shaped like the design's sample data
// (session-manager-operations/design-mocks/agent-character-sheet/): 12 personas with loadout states
// (3 undecided, 7 equipped, 1 bare, 1 unbound) and an armory with built-ins, three MCP servers
// (one failing), two packs and risk marks. Nothing touches a real disk.
import { createRoot } from 'react-dom/client'
import { AgentLibrary } from '../../src/renderer/components/tabs/AgentLibrary'
import { useSessions, type SessionTab } from '../../src/renderer/state/sessions'
import { useLayout } from '../../src/renderer/state/layout'

const HOME = '/home/user'
const CWD = `${HOME}/Projects/Self`
const now = Date.now()

type Loadout = 'undecided' | 'equipped' | 'bare' | 'unbound'
// [name, model, effort, loadout, tools, color, description]
const SPEC: Array<[string, string, string | null, Loadout, string[], string, string]> = [
  ['architect', 'opus', 'high', 'equipped', ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'], '#8a5a1f', 'Designs the shape of a change before anyone builds it.'],
  ['bilko-ceo', 'opus', 'medium', 'unbound', ['*'], '#6b4e9b', "Sets the week's priorities for Bilko."],
  ['bilko-host-publisher', 'sonnet', 'low', 'equipped', ['Read', 'Bash', 'mcp__bilko-host__publish_static_project'], '#2f7d6b', 'Publishes finished pages and checks they load.'],
  ['blender-artist', 'sonnet', 'medium', 'equipped', ['Read', 'Bash', 'mcp__blender__execute_blender_code'], '#c2562b', 'Builds and renders 3D scenes from a brief.'],
  ['builder', 'sonnet', 'medium', 'equipped', ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'], '#3a6ea5', 'Implements a design end to end, with tests.'],
  ['competitive-analyst', 'sonnet', 'medium', 'undecided', [], '#a5493a', 'Compares a product with named rivals.'],
  ['competitive-researcher', 'haiku', 'low', 'bare', [], '#5b8a3a', 'Finds who else solves the problem.'],
  ['demo-video-builder', 'sonnet', 'medium', 'equipped', ['Read', 'Write', 'Bash'], '#b0407a', 'Turns a working feature into a short demo.'],
  ['dev-lead', 'opus', 'high', 'equipped', ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'], '#2c5aa0', 'Executes one scoped PRD at a time, headless.'],
  ['validator', 'opus', 'high', 'equipped', ['Read', 'Grep', 'Glob', 'Bash'], '#7a7a2c', 'Validates a finished plan once, after its last PRD lands.'],
  ['page-history', 'sonnet', null, 'undecided', [], '#4a7f8c', 'Steward of the History page.'],
  ['kiln', 'opus', 'high', 'undecided', [], '#9a5b2e', 'Kiln idea sessions started by the Kiln runner.'],
]
const personas = SPEC.map(([name, model, effort, loadout, tools, color, description], i) => ({
  name, description, model, tools, effort, loadout, agentCli: null, agentCliModel: null, color,
  tags: [], projects: [], action: null, actionLabel: null, title: null, seedVersion: null, executorOnly: false,
  path: `${HOME}/.claude/agents/${name}.md`, body: `You are ${name}. ${description}`,
  overridingProjects: i === 4 ? ['Self'] : [],
  overrideDetails: i === 4 ? [{ project: 'Self', cwd: CWD, fields: ['model'], values: { model: 'opus' }, bodyOverridden: false, issue: null }] : [],
}))

const item = (id: string, badges: Array<'risky' | 'banned' | 'floor'> = []) => ({ id, label: id, badges })
const armory = {
  builtins: [
    item('Read', ['floor']), item('Grep', ['floor']), item('Glob', ['floor']), item('Bash', ['risky']),
    item('Edit'), item('Write'), item('WebFetch'), item('WebSearch'), item('Task', ['banned']),
  ],
  bundledSkills: [item('pdf'), item('docx')],
  mcpServers: [
    { ...item('session-manager-scheduler'), status: 'checked', scope: 'user', tools: ['project_home_write', 'project_page_write', 'scheduler_create_prd'].map((t) => item(`mcp__session-manager-scheduler__${t}`)) },
    { ...item('blender'), status: 'checked', scope: 'user', tools: ['execute_blender_code', 'get_objects_summary', 'render_thumbnail_to_path'].map((t) => item(`mcp__blender__${t}`, t === 'execute_blender_code' ? ['risky'] : [])) },
    { ...item('playwright'), status: 'failing', scope: 'user', tools: [] },
  ],
  packs: [
    { ...item('session-manager-dev'), skills: ['develop', 'builder', 'send-feedback'], source: 'plugin' },
    { ...item('apple-design'), skills: ['hig', 'sf-symbols'], source: 'plugin' },
  ],
  unpackedSkills: [],
  errors: [],
}

const ok = async () => ({ ok: true, error: null })
const api = {
  app: { homeDir: async () => HOME, cwd: async () => CWD, version: async () => '0.0.0', seedStatus: async () => null },
  agents: {
    listPersonas: async () => personas,
    armory: async () => armory,
    savePersona: async () => ({ ok: true, path: personas[0].path }),
    deletePersona: ok,
    removeOverride: ok,
    onChanged: () => () => {},
  },
  toolRisk: { read: async () => ({ ok: true, marks: {} }) },
  claudeConfig: { read: async () => ({ ok: true, data: { permissions: { allow: [], deny: [] } } }) },
  environments: {
    list: async () => ({
      ok: true,
      environments: [
        { id: 'standard', label: 'Standard sandbox', default: true },
        { id: 'network-off', label: 'Network off', default: false },
        { id: 'open', label: 'Open', default: false },
      ],
    }),
  },
  models: {
    catalog: async () => ({
      aliases: ['haiku', 'sonnet', 'opus'], models: ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5'],
      effortLevels: ['low', 'medium', 'high'], settingsEffortLevels: ['low', 'medium', 'high'], availableModels: null,
      claudeVersion: '2.0.0', probedAt: new Date(now).toISOString(),
      sources: { aliases: 'floor', models: 'floor', effortLevels: 'floor' }, degraded: false,
    }),
  },
  config: {
    listDir: async () => ({ ok: true, entries: [], error: null }),
    readText: async () => ({ exists: false, text: '', mtimeMs: 0, error: null, truncated: false }),
    readJson: async () => ({ exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: null }),
    exists: async () => false,
    canWrite: async () => ({ ok: true }),
    writeJson: ok,
    watch: () => {}, unwatch: () => {}, onChanged: () => () => {},
  },
  agentCli: { detect: async () => [] },
  voice: { getTtsEnabled: async () => false },
  clipboard: { writeText: ok },
  shell: { open: ok },
}

// Unmodelled calls resolve harmlessly and are logged ('[stub-api]') so the spec can list them.
function fallback(target: any, path: string): any {
  return new Proxy(target, {
    get(t, k) {
      if (typeof k === 'symbol' || k in t) {
        const v = t[k as any]
        return v && typeof v === 'object' ? fallback(v, `${path}.${String(k)}`) : v
      }
      console.warn(`[stub-api] unmodelled window.api${path}.${String(k)}`)
      return fallback(async () => undefined, `${path}.${String(k)}`)
    },
  })
}
;(window as any).api = fallback(api, '')

const SELF_TAB: SessionTab = {
  id: 'tab-self', sessionId: 'tab-self', label: 'Self', cwd: CWD, pid: null, status: 'dormant',
  exitCode: null, startupCommand: null, presetId: null, generation: 0,
}
useLayout.setState({ navFace: 'home' })
useSessions.setState({ tabs: [SELF_TAB], activeTabId: SELF_TAB.id })

createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh' }}>
    <AgentLibrary />
  </div>,
)
