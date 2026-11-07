// Bundle entry for the real-Chromium Project Home screenshot spec. Mounts the real
// key buttons + ProjectPagesSection (the whole Project Home document, laid out as
// ProjectHome lays it out) with a stub window.api.
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
const page = (t: string, body: string) =>
  `<!doctype html><html><body style="font-family:sans-serif;padding:32px"><h1>${t}</h1><p>${body}</p><ul><li>Fixture section one</li><li>Fixture section two</li><li>Fixture section three</li></ul></body></html>`

;(window as any).api = {
  config: { readText: async (p: string) => ({ exists: true, text: p.includes('how-it-works') ? page('How it works', 'Stubbed knowledge page two.') : page('Project overview', 'Stubbed knowledge page one.') }) },
  projectPages: { rename: async () => ({ ok: true }), delete: async () => ({ ok: true }) },
}

const macro = (id: string, label: string) => ({ id, label, agentName: 'x', tag: 'discussion', prompt: '', projects: ['*'], surface: 'project-home', builtin: true, createdAt: iso(1), updatedAt: iso(1) })
const macros = [macro('builtin-project-home', 'Project Home'), macro('builtin-demo-video', 'Demo Video')] as any

function Shell() {
  const [tab, setTab] = useState<ProjectHomeTab>('pages')
  return (
    <div style={{ height: '100vh' }} className="flex min-h-0 flex-col gap-[18px] overflow-hidden px-[28px] pt-[22px] pb-[20px] text-fg">
      <ProjectHomeKeyButtons
        tab={tab}
        onTabChange={setTab}
        pages={libraryKeyStats(knowledge, undefined)}
        videos={libraryKeyStats(videos, undefined)}
        findingsCount={null}
      />
      <ProjectPagesSection tab={tab} cwd="/fx" knowledge={knowledge as any} videos={videos as any} loaded macros={macros} launching={null} onLaunch={() => {}} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Shell />)
