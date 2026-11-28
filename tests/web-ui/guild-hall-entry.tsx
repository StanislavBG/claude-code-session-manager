// Bundle entry for the real-Chromium Guild Hall screenshot spec. Mounts the real Home page over a
// stub window.api (claude-config-entry pattern). location.hash picks the world:
//   #empty      no slot holders -> the canvas draws its 'No one is out adventuring' caption.
//   #populated  8 open project tabs (rooms); 4 holders: 3 dev-lead jobs (Self x2, Bilko), 1 architect chat (Self).
// The spec spies on CanvasRenderingContext2D.fillText before this bundle loads (window.__fillTexts).
import { createRoot } from 'react-dom/client'
import { Home } from '../../src/renderer/components/tabs/Home'
import { useScheduleState } from '../../src/renderer/state/scheduleState'
import { usePromptSessions } from '../../src/renderer/state/promptSessions'
import { useChat } from '../../src/renderer/state/chat'
import { useSessions } from '../../src/renderer/state/sessions'

const populated = location.hash === '#populated'
const CWD = '/home/user/Projects/Self'
const PROJECTS = ['Self', 'session-manager', 'Bilko', 'burrow', '3PMahjong', 'starry-night-2', 'Three-Winds', 'Hatch-Day']
const EPIC = 'epic-architect-1'
const at = new Date().toISOString()

const holders = populated
  ? [
      { owner: 'scheduler:101-build-a', at },
      { owner: 'scheduler:102-build-b', at },
      { owner: 'scheduler:103-build-c', at },
      { owner: `chat:${EPIC}`, at },
    ]
  : []

const job = (slug: string, status: string, extra: Record<string, unknown> = {}) => ({
  slug, title: `PRD ${slug}`, cwd: CWD, status, error: null, agentType: 'dev-lead', ...extra,
})
const jobs = populated
  ? [
      job('101-build-a', 'running'), job('102-build-b', 'running', { cwd: '/home/user/Projects/Bilko' }), job('103-build-c', 'running'),
      job('104-broken', 'failed', { error: 'gate red: typecheck failed' }),
    ]
  : []

const snapshot = {
  config: { firePolicy: 'when-available', utilizationThreshold: 90 },
  jobs, lastRunAt: null, nextReset: null, paused: null, utilization: 42, effectiveConcurrency: { value: 5, source: 'config' },
  effectiveUtilizationThreshold: 90, utilizationHold: null,
}

const needsItems = populated
  ? [{
      app: 'kiln', id: 'q1', title: 'Pick a name for the new idea', why: 'Two candidates scored the same.', link: null,
      options: ['Ember', 'Anvil'], externalRef: null, status: 'open', answer: null, createdAt: at, updatedAt: at, answeredAt: null,
    }]
  : []

const ok = async () => ({ ok: true })
const api = {
  app: { homeDir: async () => '/home/user', cwd: async () => CWD, version: async () => '0.0.0' },
  config: {
    listDir: async () => [], readText: async () => ({ exists: false, text: '' }), exists: async () => false,
    watch: () => {}, unwatch: () => {}, onChanged: () => () => {},
  },
  schedule: {
    state: async () => snapshot,
    onState: () => () => {},
    onStall: () => () => {},
    sessionSlots: async () => ({ total: 5, inUse: holders.length, holders, min: 0, max: 10, default: 5, envOverride: false }),
    setConfig: ok,
    setSessionSlots: ok,
  },
  needsYou: { list: async () => ({ items: needsItems }), onChanged: () => () => {}, answer: ok, confirmTool: ok },
  promptSessions: { loadActiveIndex: async () => ({ ok: true, sessions: [] }) },
  billing: { fetch: async () => null },
  logs: { write: () => {} },
  transcripts: { subscribe: async () => ({ ok: true, path: null }), unsubscribe: () => {}, onEvent: () => () => {}, buffer: async () => [] },
  shell: { open: ok },
}

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

useScheduleState.setState({ snapshot: snapshot as any, loaded: true })
if (populated) {
  useSessions.setState({
    tabs: PROJECTS.map((name, i) => ({
      id: `tab-${i}`, sessionId: `sess-${i}`, label: name, cwd: `/home/user/Projects/${name}`,
      pid: null, status: 'dormant', exitCode: null, startupCommand: null,
    })) as any,
  })
  usePromptSessions.setState({
    sessions: { [EPIC]: { id: EPIC, cwd: CWD, goalText: 'Plan the next release', status: 'active', agentType: 'architect' } as any },
  })
  useChat.setState({
    chats: { [EPIC]: { turns: [], running: true, queuedPosition: 0, started: true, stream: '', liveToolUses: [], queued: [] } as any },
  })
}

createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh' }}>
    <Home />
  </div>,
)
