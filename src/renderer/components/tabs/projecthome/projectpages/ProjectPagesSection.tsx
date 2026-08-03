/**
 * Project Home's secondary lens viewer (PRD 932, reworked by Epic "Project
 * Home Layout") — marketing/feature/architecture/brief lenses plus the
 * "About these templates" explainer. `home` is no longer one of these tabs:
 * it is ProjectHome.tsx's own primary hosted document, rendered above this
 * section. `output`/`loaded` are fetched once by ProjectHome via
 * `useProjectPagesOutput` and passed down here — one IPC call, one source of
 * truth. There is exactly one "Generate My Project Home" action on the page
 * (ProjectHome.tsx's own) — this section never renders a second generate
 * button; a missing lens just says so and points at that action.
 */
import { useEffect, useState } from 'react'
import { EmptyState } from '../../../ui/EmptyState'
import { ViewTabs } from '../../../ui/ViewTabs'
import { PhBlock, PhCard } from '../ph-primitives'
import { AlmanacIcon } from '../../../layout/AlmanacIcon'
import { HtmlFrame } from './HtmlFrame'
import type { ProjectPagesOutput } from '../../../../../preload/api'

type Lens = 'marketing' | 'feature' | 'architecture' | 'brief'
type ViewKey = Lens | 'library'

const LENS_OPTIONS: Array<{ key: Lens; label: string }> = [
  { key: 'marketing', label: 'Marketing' },
  { key: 'feature', label: 'Feature' },
  { key: 'architecture', label: 'Architecture' },
  { key: 'brief', label: 'Brief' },
]
// The 5th tab — not a generated template, a static explainer of the other
// four (plus Home, shown separately above): what they are and where their
// source files live on disk so a human can find and hand-edit them.
const VIEW_OPTIONS: Array<{ key: ViewKey; label: string }> = [...LENS_OPTIONS, { key: 'library', label: 'About these templates' }]

export function ProjectPagesSection({
  output,
  loaded,
}: {
  output: ProjectPagesOutput | null
  loaded: boolean
}) {
  const [activeView, setActiveView] = useState<ViewKey>('marketing')
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    if (!fullscreen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fullscreen])

  if (!loaded) return null

  // "About these templates" is always reachable, even before the first
  // Generate — it's static explanatory content, not one of the generated
  // lenses, so it never depends on `output`.
  if (activeView === 'library') {
    return (
      <PhBlock
        kicker="pages"
        title="Project Pages"
        note="What the 5 generated templates are, and where to hand-edit them per project."
        right={<ViewTabs options={VIEW_OPTIONS} active={activeView} onChange={setActiveView} />}
      >
        <ProjectPagesLibraryExplainer />
      </PhBlock>
    )
  }

  if (!output) {
    return (
      <PhBlock
        kicker="pages"
        title="Project Pages"
        note="Marketing, Feature, Architecture, and Brief pages generated from this project."
        right={<ViewTabs options={VIEW_OPTIONS} active={activeView} onChange={setActiveView} />}
      >
        <EmptyState title="No Project Pages yet" hint="Use “Generate My Project Home” above." />
      </PhBlock>
    )
  }

  // A lens can be missing HTML for two reasons: `output.brief` is absent for
  // output generated before the 'brief' lens existed (PRD 969), or every
  // non-home lens is absent while `output.isDefault` is true (the shipped
  // default only covers `home`). Guard rather than hand `srcDoc={undefined}`
  // to the iframe. (activeView is narrowed to Lens here — the 'library' case
  // already returned above.)
  const activeHtml = output[activeView]
  const activeLensLabel = VIEW_OPTIONS.find((o) => o.key === activeView)?.label ?? activeView

  const frame = activeHtml ? (
    <HtmlFrame title={`Project Page — ${activeView}`} html={activeHtml} />
  ) : (
    <EmptyState
      title={`${activeLensLabel} page not generated yet`}
      hint={
        output.isDefault
          ? 'Use “Generate My Project Home” above — only the Home lens has a shipped default.'
          : "This project's Project Pages were generated before this lens existed. Use “Generate My Project Home” above to regenerate."
      }
    />
  )

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-50 bg-bg flex flex-col">
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-2.5 shrink-0">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-fg-faint mr-auto">
            Project Pages · {VIEW_OPTIONS.find((o) => o.key === activeView)?.label}
          </span>
          <ViewTabs options={VIEW_OPTIONS} active={activeView} onChange={setActiveView} />
          <button
            type="button"
            onClick={() => setFullscreen(false)}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-bg-hi px-2.5 py-1 text-[11px] font-semibold text-fg-dim hover:text-fg"
            title="Exit full screen (Esc)"
          >
            <AlmanacIcon name="collapse" size={13} />
            Exit full screen
          </button>
        </div>
        <div className="flex-1 min-h-0">{frame}</div>
      </div>
    )
  }

  return (
    <PhBlock
      kicker="pages"
      title="Project Pages"
      note={
        output.isDefault
          ? "Shipped default — this project hasn't generated its own Project Pages yet."
          : 'Static HTML generated by the project-home-builder Epic — sandboxed preview, no live app state.'
      }
      right={
        <div className="flex items-center gap-2.5">
          <ViewTabs options={VIEW_OPTIONS} active={activeView} onChange={setActiveView} />
          <button
            type="button"
            onClick={() => setFullscreen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-bg-hi px-2.5 py-1 text-[11px] font-semibold text-fg-dim hover:text-fg"
            title="Full screen"
          >
            <AlmanacIcon name="expand" size={13} />
            Full screen
          </button>
        </div>
      }
    >
      <PhCard className="overflow-hidden" style={{ height: 'calc(100vh - 260px)', minHeight: 520 }}>
        {frame}
      </PhCard>
    </PhBlock>
  )
}

/**
 * Static (never generated) 5th tab: what the 4 templates are and where
 * their source lives, so a human can find the files to hand-edit. Every
 * path here is real — no invented override mechanism. The actual per-
 * project override path is `picks.json`'s per-slot hand-picks: the
 * project-home-builder agent writes it directly with its Write tool and
 * preserves existing picks on regenerate, only overwriting a slot when
 * explicitly asked to start over.
 */
function ProjectPagesLibraryExplainer() {
  const row = (label: string, path: string, desc: string) => (
    <div className="grid grid-cols-[minmax(0,220px)_minmax(0,1fr)] gap-4 py-3 border-t border-rule first:border-t-0">
      <div>
        <div className="text-xs font-semibold text-fg">{label}</div>
        <code className="mt-1 block font-mono text-[10.5px] text-fg-faint break-all">{path}</code>
      </div>
      <p className="text-xs leading-relaxed text-fg-dim">{desc}</p>
    </div>
  )
  return (
    <PhCard className="px-5 py-4 grid gap-1">
      <p className="text-xs leading-relaxed text-fg-dim mb-2">
        “Generate My Project Home” produces 5 static HTML templates from this project's own component library. Each
        is a lens on the same computed summary — nothing here is hand-written per project, but every slot's chosen
        variant can be hand-overridden and the override survives the next regenerate.
      </p>
      {row(
        'Home',
        'session-manager-operations/project-pages/output/home.html',
        'The hosted document Project Home itself displays — identity, stats, and pillars. Source slots: src/renderer/lib/projectPages/library/homeSlots.tsx.',
      )}
      {row(
        'Marketing',
        'session-manager-operations/project-pages/output/marketing.html',
        'An outward-facing landing page — hero, proof, pillars, tour, FAQ, close. Source slots: src/renderer/lib/projectPages/library/marketingSlots.tsx.',
      )}
      {row(
        'Feature',
        'session-manager-operations/project-pages/output/feature.html',
        "A deep-dive on the project's single most-active feature — mechanism, rules, states, timeline. Source slots: src/renderer/lib/projectPages/library/featureSlots.tsx.",
      )}
      {row(
        'Architecture',
        'session-manager-operations/project-pages/output/architecture.html',
        'System summary, module map, control flow, and decisions of record. Source slots: src/renderer/lib/projectPages/library/architectureSlots.tsx.',
      )}
      {row(
        'Brief',
        'session-manager-operations/project-pages/output/brief.html',
        "The project's synthesized Brief — purpose, structure, scope history, and conventions — as a static read. Source slots: src/renderer/lib/projectPages/library/briefSlots.tsx.",
      )}
      <div className="mt-3 pt-3 border-t border-rule grid gap-2.5">
        <div>
          <div className="text-xs font-semibold text-fg">Computed inputs</div>
          <code className="mt-1 block font-mono text-[10.5px] text-fg-faint">
            session-manager-operations/project-pages/summary.json
          </code>
          <p className="mt-1 text-xs leading-relaxed text-fg-dim">
            The per-project data every slot renders from — never fabricated, every field traces back to brief.json,
            CLAUDE.md, or git history.
          </p>
        </div>
        <div>
          <div className="text-xs font-semibold text-fg">Project-specific overrides</div>
          <code className="mt-1 block font-mono text-[10.5px] text-fg-faint">
            session-manager-operations/project-pages/picks.json
          </code>
          <p className="mt-1 text-xs leading-relaxed text-fg-dim">
            One slot→variant choice per lens. Hand-edit a pick here and regenerating leaves it alone — only an
            explicit reset touches a pinned slot. This file, not the component library itself, is where a project
            overrides which variant it wants without forking any code.
          </p>
        </div>
        <div>
          <div className="text-xs font-semibold text-fg">Component library (shared across every project)</div>
          <code className="mt-1 block font-mono text-[10.5px] text-fg-faint">src/renderer/lib/projectPages/library/</code>
          <p className="mt-1 text-xs leading-relaxed text-fg-dim">
            The variants themselves ship with the app — adding a new variant or slot is a code change here, not a
            per-project edit.
          </p>
        </div>
      </div>
    </PhCard>
  )
}
