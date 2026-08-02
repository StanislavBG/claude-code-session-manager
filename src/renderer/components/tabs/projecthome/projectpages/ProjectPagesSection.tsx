/**
 * Project Home's Project Pages display (PRD 932) — the Stage 4 UI over the
 * static-HTML pipeline built by PRDs 929-931. Before any Project Pages exist
 * for the active project: an empty state with "Generate Now". Once
 * session-manager-operations/project-pages/output/*.html exists: a 3-way
 * lens toggle + sandboxed iframe display, plus "Regenerate". Both buttons
 * resume an already-active `project-home-builder` Epic for this cwd instead
 * of starting a second one, per architecture spec's concurrency note.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePromptSessions, type PromptSession } from '../../../../state/promptSessions'
import { useChat } from '../../../../state/chat'
import { composeEpicIntake } from '../../../../lib/epicIntake'
import { setPendingPromptSessionId } from '../../../../lib/promptSessionDeepLink'
import { EmptyState } from '../../../ui/EmptyState'
import { ViewTabs } from '../../../ui/ViewTabs'
import { PhBlock, PhCard } from '../ph-primitives'
import { toast } from '../../../../state/toast'
import type { ProjectPagesOutput } from '../../../../../preload/api'

const BUILDER_TAG = 'project-home-builder' as const
const BUILDER_AGENT_NAME = 'project-home-builder' as const
const GENERATE_GOAL = 'Generate this project\'s Project Pages (Home/Marketing/Feature/Architecture).'

type Lens = 'home' | 'marketing' | 'feature' | 'architecture'
type ViewKey = Lens | 'library'

const LENS_OPTIONS: Array<{ key: Lens; label: string }> = [
  { key: 'home', label: 'Home' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'feature', label: 'Feature' },
  { key: 'architecture', label: 'Architecture' },
]
// The 5th tab — not a generated template, a static explainer of the other
// four: what they are and where their source files live on disk so a human
// can find and hand-edit them.
const VIEW_OPTIONS: Array<{ key: ViewKey; label: string }> = [...LENS_OPTIONS, { key: 'library', label: 'About these templates' }]

function findActiveBuilderEpic(sessions: Record<string, PromptSession>, cwd: string): PromptSession | null {
  for (const session of Object.values(sessions)) {
    if (session.cwd === cwd && session.tag === BUILDER_TAG && session.status === 'active') return session
  }
  return null
}

function navigateToEpic(epicId: string): void {
  setPendingPromptSessionId(epicId)
  window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'terminal' }))
}

export function ProjectPagesSection({ cwd }: { cwd: string }) {
  const sessions = usePromptSessions((s) => s.sessions)
  const createPromptSession = usePromptSessions((s) => s.createPromptSession)
  const approveProposed = usePromptSessions((s) => s.approveProposed)

  const [output, setOutput] = useState<ProjectPagesOutput | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [activeView, setActiveView] = useState<ViewKey>('home')
  // The registered Agent Library persona (~/.claude/agents/project-home-builder.md,
  // overlaid by this repo's own .claude/agents/project-home-builder.md) this
  // Epic is bound to — resolved once so Generate Now names a real "who" in the
  // opening prompt instead of leaving the Epic on the unnamed default persona.
  const [builderPersona, setBuilderPersona] = useState<{ name: string; description: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.agents
      .listPersonas()
      .then((list) => {
        if (cancelled) return
        const found = list.find((a) => a.name === BUILDER_AGENT_NAME)
        setBuilderPersona(found ? { name: found.name, description: found.description } : null)
      })
      .catch(() => {
        if (!cancelled) setBuilderPersona(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    window.api.projectPages
      .get(cwd)
      .then((res) => {
        if (cancelled) return
        setOutput(res.output)
        setLoaded(true)
      })
      .catch((err) => {
        if (cancelled) return
        setLoaded(true)
        toast.error(`Could not load Project Pages: ${err instanceof Error ? err.message : String(err)}`)
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  const existingBuilderEpic = useMemo(() => findActiveBuilderEpic(sessions, cwd), [sessions, cwd])

  const handleGenerate = useCallback(() => {
    if (existingBuilderEpic) {
      navigateToEpic(existingBuilderEpic.id)
      return
    }
    // Same create-and-start path New Epic uses (NewEpicCard.tsx): goalText
    // and openingPrompt come from the one composer so the Epic's stored
    // identity and what the agent reads can't drift; createPromptSession is
    // born 'proposed' then immediately approved, matching the domain model's
    // single proposed->active transition rather than a second creation kind.
    // agentName/agentDescription bind the Epic to the registered
    // project-home-builder persona (the "who") the same way NewEpicCard binds
    // a hand-picked persona — tag stays the "what" (mission).
    const { goalText, openingPrompt } = composeEpicIntake({
      title: '',
      goal: GENERATE_GOAL,
      tag: BUILDER_TAG,
      agentName: builderPersona?.name,
      agentDescription: builderPersona?.description ?? undefined,
    })
    const session = builderPersona
      ? createPromptSession(cwd, goalText, BUILDER_TAG, 'ProjectPagesSection', builderPersona.name)
      : createPromptSession(cwd, goalText, BUILDER_TAG, 'ProjectPagesSection')
    approveProposed(session.id, 'ProjectPagesSection')
    useChat.getState().send({
      tabId: session.id,
      sessionId: session.claudeSessionId,
      cwd,
      prompt: openingPrompt,
    })
    navigateToEpic(session.id)
  }, [existingBuilderEpic, createPromptSession, approveProposed, cwd, builderPersona])

  if (!loaded) return null

  const generateButton = (
    <button
      type="button"
      onClick={handleGenerate}
      className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-bg-hi hover:bg-accent-dark"
    >
      Generate Now
    </button>
  )

  // "About these templates" is always reachable, even before the first
  // Generate — it's static explanatory content, not one of the generated
  // lenses, so it never depends on `output`.
  if (activeView === 'library') {
    return (
      <PhBlock
        kicker="pages"
        title="Project Pages"
        note="What the 4 generated templates are, and where to hand-edit them per project."
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
        note="Home, Marketing, Feature, and Architecture pages generated from this project."
        right={<ViewTabs options={VIEW_OPTIONS} active={activeView} onChange={setActiveView} />}
      >
        <EmptyState title="No Project Pages yet" hint={generateButton} />
      </PhBlock>
    )
  }

  return (
    <PhBlock
      kicker="pages"
      title="Project Pages"
      note="Static HTML generated by the project-home-builder Epic — sandboxed preview, no live app state."
      right={
        <div className="flex items-center gap-2.5">
          <ViewTabs options={VIEW_OPTIONS} active={activeView} onChange={setActiveView} />
          <button
            type="button"
            onClick={handleGenerate}
            className="rounded-md border border-line bg-bg-hi px-2.5 py-1 text-[11px] font-semibold text-fg-dim hover:text-fg"
          >
            Regenerate
          </button>
        </div>
      }
    >
      <PhCard className="overflow-hidden">
        <iframe
          title={`Project Page — ${activeView}`}
          sandbox="allow-same-origin"
          srcDoc={output[activeView]}
          style={{ width: '100%', minHeight: 600, border: 'none', display: 'block' }}
        />
      </PhCard>
    </PhBlock>
  )
}

/**
 * Static (never generated) 5th tab: what the 4 templates are and where
 * their source lives, so a human can find the files to hand-edit. Every
 * path here is real — no invented override mechanism. The actual per-
 * project override path is `picks.json`'s per-slot hand-picks, which the
 * Stage 2 selector already preserves on regenerate (select.ts's
 * `mergePicks`) unless a slot is explicitly listed in `resetSlots`.
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
        Generate Now produces 4 static HTML templates from this project's own component library. Each is a lens on
        the same computed summary — nothing here is hand-written per project, but every slot's chosen variant can be
        hand-overridden and the override survives the next Regenerate.
      </p>
      {row(
        'Home',
        'session-manager-operations/project-pages/output/home.html',
        'A dashboard-flavored overview for someone who already has the project open — identity, stats, and pillars. Source slots: src/renderer/lib/projectPages/library/homeSlots.tsx.',
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
            One slot→variant choice per lens. Hand-edit a pick here and Regenerate leaves it alone — only an
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
