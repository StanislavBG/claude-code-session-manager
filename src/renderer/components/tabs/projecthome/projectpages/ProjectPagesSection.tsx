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
const GENERATE_GOAL = 'Generate this project\'s Project Pages (Marketing/Feature/Architecture).'

type Lens = 'marketing' | 'feature' | 'architecture'
const LENS_OPTIONS: Array<{ key: Lens; label: string }> = [
  { key: 'marketing', label: 'Marketing' },
  { key: 'feature', label: 'Feature' },
  { key: 'architecture', label: 'Architecture' },
]

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
  const [activeLens, setActiveLens] = useState<Lens>('marketing')
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

  if (!output) {
    return (
      <PhBlock kicker="pages" title="Project Pages" note="Marketing, Feature, and Architecture pages generated from this project.">
        <EmptyState
          title="No Project Pages yet"
          hint={
            <button
              type="button"
              onClick={handleGenerate}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-bg-hi hover:bg-accent-dark"
            >
              Generate Now
            </button>
          }
        />
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
          <ViewTabs options={LENS_OPTIONS} active={activeLens} onChange={setActiveLens} />
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
          title={`Project Page — ${activeLens}`}
          sandbox="allow-same-origin"
          srcDoc={output[activeLens]}
          style={{ width: '100%', minHeight: 600, border: 'none', display: 'block' }}
        />
      </PhCard>
    </PhBlock>
  )
}
