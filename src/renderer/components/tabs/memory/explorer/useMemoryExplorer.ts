import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { encodeWorkspace } from '../../../../lib/encodeWorkspace'
import { toast } from '../../../../state/toast'
import type {
  MemoryAgent,
  MemoryAggregateResult,
  MemoryEntry,
  MemoryIndexHealth,
  MemoryStaleResult,
  MemoryTarget,
} from '../../../../../preload/api'
import {
  buildClusters,
  buildRows,
  slugFromTitle,
  type ClusterInfo,
  type ExplorerScope,
  type MemoryRow,
} from './model'

export interface ClustersMeta {
  generatedAt: number | null
  running: boolean
}

export interface MemoryExplorerActions {
  refresh: () => Promise<void>
  read: (name: string) => Promise<string | null>
  saveBody: (name: string, body: string) => Promise<boolean>
  create: (title: string, body: string) => Promise<string | null>
  remove: (name: string) => Promise<(() => Promise<void>) | null>
  archive: (name: string) => Promise<boolean>
  restore: (name: string) => Promise<boolean>
  verify: (name: string) => Promise<boolean>
  removeLink: (name: string, targetSlug: string) => Promise<boolean>
  regenerateClusters: () => Promise<void>
  ask: (
    question: string,
    contextName?: string,
  ) => Promise<{ ok: boolean; answer: string; citations: string[]; error?: string }>
  proposeFix: (
    name: string,
  ) => Promise<{ ok: boolean; content: string; summary: string; error?: string }>
}

export interface MemoryExplorer {
  loading: boolean
  target: MemoryTarget | null
  dir: string
  autoMemoryEnabled: boolean
  rows: MemoryRow[]
  clusters: ClusterInfo[]
  clustersMeta: ClustersMeta
  index: MemoryIndexHealth | undefined
  archived: string[]
  agents: MemoryAgent[]
  agentCounts: Record<string, number>
  actions: MemoryExplorerActions
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Split a leading `---` frontmatter block (verbatim, incl. trailing newline) from the body. */
function splitFrontmatter(content: string): { front: string; body: string } {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)
  return m ? { front: m[0], body: content.slice(m[0].length) } : { front: '', body: content }
}

function firstLine(body: string): string {
  return body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
}

export function useMemoryExplorer(scope: ExplorerScope, cwd: string | null): MemoryExplorer {
  const agent = scope.kind === 'agent' ? scope.agent : null
  const agentKey = agent ? `${agent.name}|${agent.memoryScope ?? ''}` : ''
  const noMemory = agent !== null && agent.memoryScope === null

  const target = useMemo<MemoryTarget | null>(() => {
    if (noMemory) return null
    if (agent && agent.memoryScope) {
      return { agent: { name: agent.name, scope: agent.memoryScope }, ...(cwd ? { cwd } : {}) }
    }
    return { workspace: encodeWorkspace(cwd), ...(cwd ? { cwd } : {}) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentKey, noMemory, cwd])
  const isWorkspace = agent === null

  const [loading, setLoading] = useState(true)
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [stale, setStale] = useState<MemoryStaleResult | null>(null)
  const [agg, setAgg] = useState<MemoryAggregateResult | null>(null)
  const [clustersRunning, setClustersRunning] = useState(false)
  const [dir, setDir] = useState('')
  const [autoMemoryEnabled, setAutoMemoryEnabled] = useState(true)
  const [archived, setArchived] = useState<string[]>([])
  const [agents, setAgents] = useState<MemoryAgent[]>([])
  const [agentCounts, setAgentCounts] = useState<Record<string, number>>({})
  const [now, setNow] = useState(() => Date.now())
  const targetRef = useRef(target)
  targetRef.current = target

  const refresh = useCallback(async () => {
    if (!target) {
      setEntries([]); setStale(null); setAgg(null); setArchived([]); setDir('')
      setLoading(false)
      return
    }
    try {
      const r = await window.api.memory.list(target)
      if (targetRef.current !== target) return
      setEntries(r.entries ?? [])
      setDir(r.dir ?? '')
      setAutoMemoryEnabled(r.autoMemoryEnabled !== false)
      if (r.error) toast.error(`Memory list failed: ${r.error}`)
      const [s, a] = await Promise.all([
        window.api.memory.stale(target).catch((e: unknown) => {
          toast.error(`Memory staleness check failed: ${errMsg(e)}`)
          return null
        }),
        window.api.memory.listArchived(target).catch(() => ({ names: [] as string[], error: null })),
      ])
      if (targetRef.current !== target) return
      setStale(s)
      setArchived(a.names ?? [])
      setNow(Date.now())
    } catch (e) {
      toast.error(`Memory list failed: ${errMsg(e)}`)
    } finally {
      setLoading(false)
    }
  }, [target])

  // Initial load + target switch. Clusters read the cache only (never paid on mount).
  useEffect(() => {
    setLoading(true)
    setAgg(null)
    void refresh()
    if (target && isWorkspace && target.workspace) {
      window.api.memory
        .aggregate(target.workspace, false, cwd ?? undefined)
        .then((a) => { if (targetRef.current === target) setAgg(a) })
        .catch((e: unknown) => toast.error(`Memory clusters failed: ${errMsg(e)}`))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh])

  // Agent list + per-agent entry counts (workspace-independent of the selected scope).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { agents: list } = await window.api.memory.agents(cwd ?? undefined)
        if (cancelled) return
        setAgents(list)
        const counts: Record<string, number> = {}
        await Promise.all(
          list.filter((a) => a.memoryScope).map(async (a) => {
            const r = await window.api.memory.list({
              agent: { name: a.name, scope: a.memoryScope! },
              ...(cwd ? { cwd } : {}),
            })
            counts[a.name] = (r.entries ?? []).filter((e) => e.name !== 'MEMORY.md').length
          }),
        )
        if (!cancelled) setAgentCounts(counts)
      } catch (e) {
        if (!cancelled) toast.error(`Memory agents failed: ${errMsg(e)}`)
      }
    })()
    return () => { cancelled = true }
  }, [cwd])

  // External-write watch on the memory folder.
  useEffect(() => {
    if (!dir) return
    const watchedDir = dir
    window.api.config.watch([watchedDir])
    const off = window.api.config.onChanged(({ path }) => {
      if (path === watchedDir || path.startsWith(watchedDir + '/')) void refresh()
    })
    return () => {
      off()
      window.api.config.unwatch([watchedDir])
    }
  }, [dir, refresh])

  const rows = useMemo(() => buildRows(entries, stale, agg, now), [entries, stale, agg, now])
  const clusters = useMemo(() => buildClusters(agg, rows), [agg, rows])
  const clustersMeta = useMemo<ClustersMeta>(
    () => ({ generatedAt: agg?.generatedAt ?? null, running: clustersRunning }),
    [agg, clustersRunning],
  )

  const read = useCallback(async (name: string): Promise<string | null> => {
    if (!target) return null
    try {
      const r = await window.api.memory.read(name, target)
      if (r.error) { toast.error(`Memory read failed: ${r.error}`); return null }
      return r.content
    } catch (e) {
      toast.error(`Memory read failed: ${errMsg(e)}`)
      return null
    }
  }, [target])

  const mutate = useCallback(
    async (label: string, call: () => Promise<{ ok: boolean; error?: string | null }>): Promise<boolean> => {
      try {
        const r = await call()
        if (!r.ok) { toast.error(`${label} failed: ${r.error ?? 'unknown error'}`); return false }
        await refresh()
        return true
      } catch (e) {
        toast.error(`${label} failed: ${errMsg(e)}`)
        return false
      }
    },
    [refresh],
  )

  const saveBody = useCallback(async (name: string, body: string): Promise<boolean> => {
    if (!target) return false
    const current = await read(name)
    if (current === null) return false
    const { front } = splitFrontmatter(current)
    return mutate('Memory save', () => window.api.memory.write(name, front + body, target))
  }, [target, read, mutate])

  const create = useCallback(async (title: string, body: string): Promise<string | null> => {
    if (!target) return null
    const name = slugFromTitle(title)
    const description = firstLine(body)
    const made = await mutate('Memory create', () => window.api.memory.create(name, description, target))
    if (!made) return null
    const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
    const ok = await mutate('Memory create', () => window.api.memory.write(name, content, target))
    return ok ? name : null
  }, [target, mutate])

  const remove = useCallback(async (name: string): Promise<(() => Promise<void>) | null> => {
    if (!target) return null
    const content = await read(name)
    if (content === null) return null
    const deleted = await mutate('Memory delete', () => window.api.memory.delete(name, target))
    if (!deleted) return null
    const description = splitFrontmatter(content).front.match(/^description:\s*(.*)$/m)?.[1]?.trim() ?? ''
    return async () => {
      const made = await mutate('Memory undo', () => window.api.memory.create(name, description, target))
      if (!made) return
      await mutate('Memory undo', () => window.api.memory.write(name, content, target))
    }
  }, [target, read, mutate])

  const archive = useCallback(
    (name: string) => (target ? mutate('Memory archive', () => window.api.memory.archive(name, target)) : Promise.resolve(false)),
    [target, mutate],
  )
  const restore = useCallback(
    (name: string) => (target ? mutate('Memory restore', () => window.api.memory.restore(name, target)) : Promise.resolve(false)),
    [target, mutate],
  )
  const verify = useCallback(
    (name: string) => (target ? mutate('Memory verify', () => window.api.memory.verify(name, target)) : Promise.resolve(false)),
    [target, mutate],
  )

  const removeLink = useCallback(async (name: string, targetSlug: string): Promise<boolean> => {
    if (!target) return false
    const current = await read(name)
    if (current === null) return false
    const next = current.split(`[[${targetSlug}]]`).join(targetSlug)
    return mutate('Memory link removal', () => window.api.memory.write(name, next, target))
  }, [target, read, mutate])

  const regenerateClusters = useCallback(async (): Promise<void> => {
    if (!target || !isWorkspace || !target.workspace) return
    setClustersRunning(true)
    try {
      const a = await window.api.memory.aggregate(target.workspace, true, cwd ?? undefined)
      if (a.error) toast.error(`Memory clustering failed: ${a.error}`)
      else setAgg(a)
    } catch (e) {
      toast.error(`Memory clustering failed: ${errMsg(e)}`)
    } finally {
      setClustersRunning(false)
    }
  }, [target, isWorkspace, cwd])

  const ask = useCallback(async (question: string, contextName?: string) => {
    const fail = (error: string) => ({ ok: false, answer: '', citations: [] as string[], error })
    if (!target) return fail('no memory store')
    try {
      const r = await window.api.memory.ask({ question, target, contextName })
      if (!r.ok) toast.error(`Memory ask failed: ${r.error ?? 'unknown error'}`)
      return r
    } catch (e) {
      toast.error(`Memory ask failed: ${errMsg(e)}`)
      return fail(errMsg(e))
    }
  }, [target])

  const proposeFix = useCallback(async (name: string) => {
    const fail = (error: string) => ({ ok: false, content: '', summary: '', error })
    if (!target) return fail('no memory store')
    try {
      const r = await window.api.memory.proposeFix({ name, target })
      if (!r.ok) toast.error(`Memory fix failed: ${r.error ?? 'unknown error'}`)
      return r
    } catch (e) {
      toast.error(`Memory fix failed: ${errMsg(e)}`)
      return fail(errMsg(e))
    }
  }, [target])

  const actions = useMemo<MemoryExplorerActions>(
    () => ({
      refresh, read, saveBody, create, remove, archive, restore, verify,
      removeLink, regenerateClusters, ask, proposeFix,
    }),
    [refresh, read, saveBody, create, remove, archive, restore, verify, removeLink, regenerateClusters, ask, proposeFix],
  )

  return {
    loading, target, dir, autoMemoryEnabled, rows, clusters, clustersMeta,
    index: stale?.index, archived, agents, agentCounts, actions,
  }
}
