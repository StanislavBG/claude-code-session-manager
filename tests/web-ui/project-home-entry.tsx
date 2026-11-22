// Bundle entry for the real-Chromium Project Home screenshot specs. Mounts the real
// key buttons + ProjectPagesSection (the whole Project Home document, laid out as
// ProjectHome lays it out) with a stub window.api. `?tab=tools` opens the Tools tab
// (md-network-shots.spec.ts); the stub mdNetwork scan holds 2 duplicate pairs,
// 1 localOnly broken link and 1 orphan group.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ProjectPagesSection } from '../../src/renderer/components/tabs/projecthome/projectpages/ProjectPagesSection'
import {
  ProjectHomeKeyButtons,
  libraryKeyStats,
  type ProjectHomeTab,
} from '../../src/renderer/components/tabs/projecthome/projectpages/ProjectHomeKeyButtons'

const now = Date.now()
const iso = (agoMin: number) => new Date(now - agoMin * 60_000).toISOString()
const report = { lufs: -16.2, truePeakDb: -1.4, speechS: 24, readingGrade: 6.1, checks: [] }

const knowledge = [
  { id: 'overview', path: '/fx/knowledge/overview/index.html', mtimeMs: now - 5 * 60_000, error: null,
    meta: { id: 'overview', title: 'Project overview', topic: 'Overview', createdAt: iso(5), model: 'sonnet' } },
  { id: 'how-it-works', path: '/fx/knowledge/how-it-works/index.html', mtimeMs: now - 90 * 60_000, error: null,
    meta: { id: 'how-it-works', title: 'How it works', topic: 'How it works', createdAt: iso(90), model: 'sonnet' } },
]
const videos = [
  { id: 'demo-a', path: '/fx/videos/demo-a/index.html', mtimeMs: now - 10 * 60_000, error: null,
    meta: { id: 'demo-a', title: 'Product tour', kind: 'project-demo', style: 'Professional', lengthS: 30, createdAt: iso(10), character: null, sources: [], report } },
  { id: 'demo-b', path: '/fx/videos/demo-b/index.html', mtimeMs: now - 200 * 60_000, error: null,
    meta: { id: 'demo-b', title: 'Release notes', kind: 'blog-post', style: 'Fun', lengthS: 60, createdAt: iso(200), character: null, sources: [], report } },
]
// Review MD network fixture scan (MdNetwork in src/preload/api.d.ts).
const mdDoc = (path: string, role: string, depth: number | null, linkedFrom: number, lines: number) => ({
  path, role, depth, lines, bytes: lines * 60, lastCommitMs: now - 3 * 86_400_000, commits: 4, linkedFrom,
  codeRefs: 0, codeRefFiles: [], deadRefs: [], ambiguousRefs: [], changedSince: [], collection: null,
})
const mdNode = (path: string, depth: number, type: string, linksOut: number, linkedFrom: number) => ({ id: path, path, depth, type, linksOut, linkedFrom })
const mdNetwork = {
  ok: true,
  root: 'CLAUDE.md',
  nodes: [
    mdNode('CLAUDE.md', 0, 'hub', 4, 0),
    mdNode('src/CLAUDE.md', 1, 'owner', 1, 1),
    mdNode('docs/architecture.md', 1, 'doc', 1, 2),
    mdNode('docs/conventions.md', 1, 'doc', 1, 1),
    mdNode('tests/README.md', 1, 'owner', 0, 1),
  ],
  edges: [
    { from: 'CLAUDE.md', to: 'src/CLAUDE.md' },
    { from: 'CLAUDE.md', to: 'docs/architecture.md' },
    { from: 'CLAUDE.md', to: 'docs/conventions.md' },
    { from: 'CLAUDE.md', to: 'tests/README.md' },
    { from: 'src/CLAUDE.md', to: 'docs/architecture.md' },
    { from: 'docs/conventions.md', to: 'docs/local-notes.md', broken: true },
  ],
  findings: [
    { type: 'broken-link', file: 'docs/conventions.md', line: 12, target: 'local-notes.md', to: 'docs/local-notes.md',
      where: 'docs/conventions.md:12 → local-notes.md', detail: 'docs/local-notes.md is not tracked.', localOnly: true },
    { type: 'orphan', where: 'notes/', count: 2, paths: ['notes/old-plan.md', 'notes/ideas.md'],
      detail: '2 docs no link from CLAUDE.md reaches.' },
  ],
  docs: 5,
  links: 6,
  scopes: ['docs/', 'src/', 'tests/'],
  census: {
    docs: [
      mdDoc('CLAUDE.md', 'map', 0, 0, 120),
      mdDoc('src/CLAUDE.md', 'scoped', 1, 1, 40),
      mdDoc('docs/architecture.md', 'doc', 1, 2, 210),
      mdDoc('docs/conventions.md', 'doc', 1, 1, 95),
      mdDoc('tests/README.md', 'doc', 1, 1, 30),
      mdDoc('notes/old-plan.md', 'doc', null, 0, 60),
      mdDoc('notes/ideas.md', 'doc', null, 0, 25),
    ],
    collections: [],
    counts: { tracked: 7, network: 5, records: 0, unlinked: 2, byRole: { map: 1, scoped: 1, agent: 0, record: 0, doc: 5 } },
    gitWindow: { commits: 40, oldestMs: now - 90 * 86_400_000 },
    warnings: [],
  },
  duplicates: [
    { a: 'CLAUDE.md', b: 'docs/conventions.md', sharedRuns: 14, samples: ['Never return a freshly built value from a zustand selector'] },
    { a: 'src/CLAUDE.md', b: 'docs/architecture.md', sharedRuns: 6, samples: ['main and preload are CommonJS only'] },
  ],
}
const mdFile = (p: string) => `# ${p}\n\nStubbed doc body for the screenshot fixture.\n`

const page = (t: string, body: string) =>
  `<!doctype html><html><body style="font-family:sans-serif;padding:32px"><h1>${t}</h1><p>${body}</p><ul><li>Fixture section one</li><li>Fixture section two</li><li>Fixture section three</li></ul></body></html>`

;(window as any).api = {
  config: { readText: async (p: string) => ({ exists: true, text: p.includes('how-it-works') ? page('How it works', 'Stubbed knowledge page two.') : page('Project overview', 'Stubbed knowledge page one.') }) },
  projectPages: {
    rename: async () => ({ ok: true }),
    delete: async () => ({ ok: true }),
    mdNetwork: async () => mdNetwork,
    mdReview: async () => ({ ok: true, record: null, recordPath: null, validation: {} }),
  },
  files: { read: async (p: string) => ({ ok: true, text: mdFile(p.replace(/^\/fx\//, '')) }) },
  schedule: { listPrds: async () => [] },
  shell: { open: async () => ({ ok: true }) },
}

const macro = (id: string, label: string) => ({ id, label, agentName: 'x', tag: 'discussion', prompt: '', projects: ['*'], surface: 'project-home', builtin: true, createdAt: iso(1), updatedAt: iso(1) })
const reviewMacro = {
  ...macro('builtin-review-md-network', 'Review MD network'),
  agentName: 'architect',
  inputs: [
    { name: 'scope', label: 'Scope', default: 'the whole project', required: true },
    { name: 'mode', label: 'Mode', options: ['Full review', 'Drift check'], default: 'Full review', required: true },
  ],
}
const macros = [macro('builtin-project-home', 'Project Home'), macro('builtin-demo-video', 'Demo Video'), reviewMacro] as any
const initialTab: ProjectHomeTab = new URLSearchParams(location.search).get('tab') === 'tools' ? 'tools' : 'pages'

function Shell() {
  const [tab, setTab] = useState<ProjectHomeTab>(initialTab)
  const [findings, setFindings] = useState<number | null>(null)
  return (
    <div style={{ height: '100vh' }} className="flex min-h-0 flex-col gap-[18px] overflow-hidden px-[28px] pt-[22px] pb-[20px] text-fg">
      <ProjectHomeKeyButtons
        tab={tab}
        onTabChange={setTab}
        pages={libraryKeyStats(knowledge, undefined)}
        videos={libraryKeyStats(videos, undefined)}
        findingsCount={findings}
      />
      <ProjectPagesSection tab={tab} cwd="/fx" knowledge={knowledge as any} videos={videos as any} loaded macros={macros} launching={null} onLaunch={() => {}} onFindingsCount={(_cwd, n) => setFindings(n)} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Shell />)
