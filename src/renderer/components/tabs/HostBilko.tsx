/**
 * HostBilko — "Host on Bilko.run" tab. Cockpit over the two-stage pipeline
 * in session-manager-operations/architecture/bilko-host-integration.md:
 * Stage A (this tab's own IPC, deterministic) rebuilds a static-path bundle
 * — one root document ("the project itself") plus any number of sub-path
 * documents (bilko.run/projects/<slug>/<subpath>/) — from this app's own
 * document list; Stage B (an Epic) drives the bilko-host MCP's gated
 * publish pipeline. Removing a document here only edits the local list —
 * it stays live until the next Prepare Bundle + Publish, which is the
 * confirmed mechanism that actually takes it down (Bilko's publish tool
 * rm -rf's + rebuilds the whole slug directory on every publish).
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { useActiveTab } from '../../lib/useActiveTab'
import { usePromptSessions, type PromptSession } from '../../state/promptSessions'
import { useChat } from '../../state/chat'
import { composeEpicIntake } from '../../lib/epicIntake'
import { setPendingPromptSessionId } from '../../lib/promptSessionDeepLink'
import { computeBilkoHostReadiness, computeProjectPageLensStatus, deriveBilkoSlug, lensDocumentTitle } from '../../lib/bilkoHost'
import { EmptyState } from '../ui/EmptyState'
import { toast } from '../../state/toast'
import type { BilkoHostDocumentSource, BilkoHostGetResult } from '../../../preload/api'

const PUBLISH_TAG = 'bilko-host-publisher' as const
const PUBLISH_AGENT_NAME = 'bilko-host-publisher' as const
const LENS_OPTIONS: Array<{ value: 'home' | 'marketing' | 'feature' | 'architecture'; label: string }> = [
  { value: 'home', label: 'Home lens' },
  { value: 'marketing', label: 'Marketing lens' },
  { value: 'feature', label: 'Feature lens' },
  { value: 'architecture', label: 'Architecture lens' },
]

function findActivePublishEpic(sessions: Record<string, PromptSession>, cwd: string): PromptSession | null {
  for (const session of Object.values(sessions)) {
    if (session.cwd === cwd && session.tag === PUBLISH_TAG && session.status === 'active') return session
  }
  return null
}

function navigateToEpic(epicId: string): void {
  setPendingPromptSessionId(epicId)
  window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'terminal' }))
}

function HostBilkoComponent() {
  const activeTab = useActiveTab()
  const cwd = activeTab?.cwd ?? null

  const sessions = usePromptSessions((s) => s.sessions)
  const createPromptSession = usePromptSessions((s) => s.createPromptSession)
  const approveProposed = usePromptSessions((s) => s.approveProposed)

  const [info, setInfo] = useState<BilkoHostGetResult | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [slug, setSlug] = useState('')
  const [privateConfirmed, setPrivateConfirmed] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [publisherPersona, setPublisherPersona] = useState<{ name: string; description: string | null } | null>(null)

  // New-document form state.
  const [newSubpath, setNewSubpath] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newLens, setNewLens] = useState<'home' | 'marketing' | 'feature' | 'architecture'>('feature')

  useEffect(() => {
    let cancelled = false
    window.api.agents
      .listPersonas()
      .then((list) => {
        if (cancelled) return
        const found = list.find((a) => a.name === PUBLISH_AGENT_NAME)
        setPublisherPersona(found ? { name: found.name, description: found.description } : null)
      })
      .catch(() => {
        if (!cancelled) setPublisherPersona(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const reload = useCallback(() => {
    if (!cwd) return
    setLoaded(false)
    window.api.bilkoHost
      .get(cwd)
      .then((res) => {
        setInfo(res)
        setSlug((prev) => prev || res.bundleManifest?.slug || res.defaultSlug)
        setLoaded(true)
      })
      .catch((err) => {
        setLoaded(true)
        toast.error(`Could not load bilko-host status: ${err instanceof Error ? err.message : String(err)}`)
      })
  }, [cwd])

  useEffect(() => {
    setInfo(null)
    setSlug('')
    setPrivateConfirmed(false)
    reload()
  }, [reload])

  const existingPublishEpic = cwd ? findActivePublishEpic(sessions, cwd) : null

  const handlePrepareBundle = useCallback(() => {
    if (!cwd || !slug) return
    setPreparing(true)
    window.api.bilkoHost
      .prepareBundle(cwd, slug)
      .then(() => reload())
      .catch((err) => toast.error(`Could not prepare bundle: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setPreparing(false))
  }, [cwd, slug, reload])

  const handleAddDocument = useCallback(() => {
    if (!cwd) return
    const subpath = deriveBilkoSlug(newSubpath).replace(/^-+|-+$/g, '')
    if (!subpath || !newTitle.trim()) {
      toast.error('A sub-path and a title are required.')
      return
    }
    const source: BilkoHostDocumentSource = { kind: 'project-page-lens', lens: newLens }
    window.api.bilkoHost
      .addDocument(cwd, subpath, newTitle.trim(), source)
      .then(() => {
        setNewSubpath('')
        setNewTitle('')
        reload()
      })
      .catch((err) => toast.error(`Could not add document: ${err instanceof Error ? err.message : String(err)}`))
  }, [cwd, newSubpath, newTitle, newLens, reload])

  const handleAddLens = useCallback(
    (lens: 'home' | 'marketing' | 'feature' | 'architecture', subpath: string) => {
      if (!cwd) return
      window.api.bilkoHost
        .addDocument(cwd, subpath, lensDocumentTitle(lens), { kind: 'project-page-lens', lens })
        .then(() => reload())
        .catch((err) => toast.error(`Could not add ${lens} page: ${err instanceof Error ? err.message : String(err)}`))
    },
    [cwd, reload],
  )

  const handleAddAllLenses = useCallback(async () => {
    if (!cwd || !info) return
    const pending = computeProjectPageLensStatus(info.documents).filter((s) => s.status === 'available')
    for (const s of pending) {
      try {
        await window.api.bilkoHost.addDocument(cwd, s.subpath, lensDocumentTitle(s.lens), {
          kind: 'project-page-lens',
          lens: s.lens,
        })
      } catch (err) {
        toast.error(`Could not add ${s.lens} page: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    reload()
  }, [cwd, info, reload])

  const handleRemoveDocument = useCallback(
    (id: string) => {
      if (!cwd) return
      window.api.bilkoHost
        .removeDocument(cwd, id)
        .then(() => reload())
        .catch((err) => toast.error(`Could not remove document: ${err instanceof Error ? err.message : String(err)}`))
    },
    [cwd, reload],
  )

  const handlePublish = useCallback(async () => {
    if (!cwd || !slug) return
    if (existingPublishEpic) {
      navigateToEpic(existingPublishEpic.id)
      return
    }
    const goal =
      `Publish this project to bilko.run as a static-path listing, slug "${slug}". ` +
      `Bundle is at session-manager-operations/bilko-host/dist/ (prepare it first via ` +
      `Prepare Bundle if it's missing or stale) — it may contain multiple documents (a root ` +
      `page plus sub-paths); publish the whole dist/ tree as one static-path app.`
    const { goalText, openingPrompt } = composeEpicIntake({
      title: '',
      goal,
      tag: PUBLISH_TAG,
      agentName: publisherPersona?.name,
      agentDescription: publisherPersona?.description ?? undefined,
    })
    const session = publisherPersona
      ? await createPromptSession(cwd, goalText, PUBLISH_TAG, 'HostBilko', publisherPersona.name)
      : await createPromptSession(cwd, goalText, PUBLISH_TAG, 'HostBilko')
    approveProposed(session.id, 'HostBilko')
    useChat.getState().send({
      tabId: session.id,
      sessionId: session.claudeSessionId,
      cwd,
      prompt: openingPrompt,
    })
    navigateToEpic(session.id)
  }, [cwd, slug, existingPublishEpic, createPromptSession, approveProposed, publisherPersona])

  if (!cwd) return <EmptyState title="Open a project to host it on Bilko.run" />
  if (!loaded || !info) return null

  const readiness = computeBilkoHostReadiness(info)

  if (readiness.kind === 'no-marketing-page') {
    return (
      <EmptyState
        title="No Marketing page yet"
        hint="Generate this project's Project Pages from Project Home first — the root document publishes the Marketing lens."
      />
    )
  }

  const publishState = info.publishState
  const statusLabel = publishState?.status ?? (info.bundleManifest ? 'bundle-ready' : 'not-published')
  const canEdit = readiness.kind === 'ready' || privateConfirmed

  return (
    <div className="max-w-2xl space-y-4">
      <div className="rounded-card border border-line bg-bg-hi p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-serif text-lg text-fg">{info.projectName}</div>
            <div className="text-xs text-fg-faint mt-0.5">
              Status: <span className="font-mono">{statusLabel}</span>
              {info.bundleStale && info.bundleManifest && (
                <span className="ml-2 text-accent">bundle out of date — Prepare Bundle again</span>
              )}
            </div>
          </div>
          {publishState?.status === 'published' && publishState.url && (
            <a href={publishState.url} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">
              {publishState.url}
            </a>
          )}
        </div>

        {readiness.kind === 'private-needs-confirm' && !privateConfirmed && (
          <div className="rounded-md border border-line bg-bg p-3 text-xs text-fg-dim">
            This project's package.json is marked private with no public homepage. Confirm you want
            to publish it to bilko.run anyway.
            <button
              type="button"
              onClick={() => setPrivateConfirmed(true)}
              className="mt-2 block rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-bg-hi hover:bg-accent-dark"
            >
              Yes, this can be public
            </button>
          </div>
        )}

        {canEdit && (
          <>
            <label className="block text-xs text-fg-faint">
              Slug (bilko.run/projects/&lt;slug&gt;/)
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                className="mt-1 block w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm font-mono text-fg"
              />
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePrepareBundle}
                disabled={preparing}
                className="rounded-md border border-line bg-bg px-3.5 py-1.5 text-xs font-semibold text-fg hover:bg-bg-hi disabled:opacity-50"
              >
                {preparing ? 'Preparing…' : 'Prepare Bundle'}
              </button>
              <button
                type="button"
                onClick={() => {
                  handlePublish().catch((err: unknown) => {
                    toast.error(err instanceof Error ? err.message : String(err))
                  })
                }}
                disabled={!info.bundleManifest}
                title={!info.bundleManifest ? 'Prepare a bundle first' : undefined}
                className="rounded-md bg-accent px-3.5 py-1.5 text-xs font-semibold text-bg-hi hover:bg-accent-dark disabled:opacity-50"
              >
                {existingPublishEpic ? 'View publish in progress' : 'Publish'}
              </button>
            </div>

            {info.bundleManifest && (
              <div className="text-[11px] text-fg-faint font-mono">
                bundle: {(info.bundleManifest.bundle.sizeBytesGz / 1024).toFixed(1)} KB gz ·{' '}
                {info.bundleManifest.bundle.fileCount} document{info.bundleManifest.bundle.fileCount === 1 ? '' : 's'} · built{' '}
                {new Date(info.bundleManifest.builtAt).toLocaleString()} · {info.bundleManifest.gitSha}
              </div>
            )}

            {publishState?.status === 'publish-failed' && publishState.lastError && (
              <div className="text-xs text-accent">Last publish failed: {publishState.lastError}</div>
            )}
          </>
        )}
      </div>

      {canEdit && (() => {
        const lensStatus = computeProjectPageLensStatus(info.documents)
        const pendingCount = lensStatus.filter((s) => s.status === 'available').length
        return (
          <div className="rounded-card border border-line bg-bg-hi p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="font-serif text-base text-fg">Project Pages</div>
              {pendingCount > 1 && (
                <button
                  type="button"
                  onClick={handleAddAllLenses}
                  className="text-xs text-accent hover:underline"
                >
                  Host all {pendingCount} remaining
                </button>
              )}
            </div>
            <p className="text-xs text-fg-faint">
              This project generates 4 pages (Home / Marketing / Feature / Architecture). Marketing is
              the project's root (bilko.run/projects/{slug || '<slug>'}/); host any of the others as
              their own sub-page if you want them public too.
            </p>
            <ul className="space-y-1.5">
              {lensStatus.map((s) => (
                <li
                  key={s.lens}
                  className="flex items-center justify-between gap-2 rounded-md border border-line bg-bg px-3 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="text-fg capitalize">{s.lens}</div>
                    <div className="text-fg-faint font-mono truncate">
                      {s.status === 'root' ? '(project root)' : `/${s.subpath}/`}
                    </div>
                  </div>
                  {s.status === 'available' ? (
                    <button
                      type="button"
                      onClick={() => handleAddLens(s.lens, s.subpath)}
                      className="shrink-0 rounded-md border border-line px-2 py-1 text-fg hover:bg-bg-hi"
                    >
                      + Host as /{s.subpath}/
                    </button>
                  ) : (
                    <span className="shrink-0 text-fg-faint">{s.status === 'root' ? 'root' : 'hosted'}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      })()}

      {canEdit && (
        <div className="rounded-card border border-line bg-bg-hi p-5 space-y-3">
          <div className="font-serif text-base text-fg">Hosted documents</div>
          <p className="text-xs text-fg-faint">
            One project, one Bilko listing — add as many explanatory pages as you want under it,
            each at its own sub-path. Removing one here takes it down on the next Publish.
          </p>

          <ul className="space-y-1.5">
            {info.documents.map((doc) => (
              <li
                key={doc.id}
                className="flex items-center justify-between gap-2 rounded-md border border-line bg-bg px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="text-fg truncate">{doc.title}</div>
                  <div className="text-fg-faint font-mono truncate">
                    {doc.subpath === '' ? '(root)' : `/${doc.subpath}/`} · {doc.url}
                  </div>
                </div>
                {doc.subpath !== '' && (
                  <button
                    type="button"
                    onClick={() => handleRemoveDocument(doc.id)}
                    title="Remove — takes effect on the next Publish"
                    className="shrink-0 rounded-md border border-line px-2 py-1 text-fg-faint hover:text-accent hover:border-accent/40"
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>

          <div className="rounded-md border border-line bg-bg p-3 space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">Add a document</div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={newSubpath}
                onChange={(e) => setNewSubpath(e.target.value)}
                placeholder="sub-path, e.g. special-doc/01"
                className="rounded-md border border-line bg-bg-hi px-2.5 py-1.5 text-xs font-mono text-fg"
              />
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Title"
                className="rounded-md border border-line bg-bg-hi px-2.5 py-1.5 text-xs text-fg"
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                value={newLens}
                onChange={(e) => setNewLens(e.target.value as typeof newLens)}
                className="rounded-md border border-line bg-bg-hi px-2.5 py-1.5 text-xs text-fg"
              >
                {LENS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleAddDocument}
                className="rounded-md border border-line bg-bg-hi px-3.5 py-1.5 text-xs font-semibold text-fg hover:bg-bg"
              >
                Add document
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const HostBilko = memo(HostBilkoComponent)
