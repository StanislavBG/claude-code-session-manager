/**
 * SubagentMemoryView — list+detail view over per-subagent memory entries.
 * Rendered as the "Subagent" scope of the Memory tab.
 *
 * Layout:
 *   toolbar:  Agent dropdown (user + project agents) · entries count · + New entry · Refresh
 *   sidebar:  filter input + list of entries (newest first)
 *   detail:   MarkdownEditor on the selected entry's body, with Save / Delete
 *
 * Distinct from the Workspace scope — that's keyed by cwd, this is keyed
 * by agentId (subagent name). The agent dropdown is populated by scanning
 * ~/.claude/agents/ (user scope) and <cwd>/.claude/agents/ (project scope) via
 * the existing config.listDir IPC; we don't add a new "list subagents" call.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Panel } from '../../ui/Panel'
import { ListDetail } from '../../ui/ListDetail'
import { MarkdownEditor } from '../../ui/MarkdownEditor'
import { EmptyState } from '../../ui/EmptyState'
import { useActiveTab } from '../../../lib/useActiveTab'
import { useHomeDir } from '../../../lib/useHomeDir'
import { useAgentMemory } from '../../../state/agentMemory'
import { formatBytes } from '../../../lib/formatBytes'
import { formatMtime } from '../../../lib/formatMtime'
import { toast } from '../../../state/toast'
import type { AgentMemoryCategory, AgentMemoryEntry } from '../../../../preload/api'

interface AgentOption {
  id: string
  label: string
  scope: 'user' | 'project'
}

const ENTRY_SLUG_RE = /^[A-Za-z0-9._-]{1,128}$/
const CATEGORY_LABELS: Record<AgentMemoryCategory, string> = {
  command: 'Commands',
  preference: 'Preferences',
  pattern: 'Patterns',
  failure: 'Avoid',
  workflow: 'Workflow',
}
const CATEGORY_KEYS: AgentMemoryCategory[] = ['command', 'preference', 'pattern', 'failure', 'workflow']

/** Scan ~/.claude/agents/ and <cwd>/.claude/agents/ for .md subagent files.
 *  Mirrors what Subagents.tsx does internally — kept inline so this modal is
 *  self-contained. Complexity: O(n) over the two directories, called once per
 *  agent dropdown re-render (home/cwd change). */
async function loadAgentList(home: string, cwd: string | null): Promise<AgentOption[]> {
  const dirs: { dir: string; scope: 'user' | 'project' }[] = [
    { dir: `${home}/.claude/agents`, scope: 'user' },
  ]
  if (cwd) dirs.push({ dir: `${cwd}/.claude/agents`, scope: 'project' })
  const out: AgentOption[] = []
  for (const { dir, scope } of dirs) {
    try {
      const r = await window.api.config.listDir(dir, { filesOnly: true })
      for (const e of r.entries) {
        if (!e.name.endsWith('.md')) continue
        const id = e.name.replace(/\.md$/, '')
        if (!ENTRY_SLUG_RE.test(id)) continue
        out.push({ id, label: id, scope })
      }
    } catch {
      // Directory may not exist — fine, just skip.
    }
  }
  // De-duplicate: project agents shadow user agents of the same name.
  const byId = new Map<string, AgentOption>()
  for (const a of out) {
    if (a.scope === 'project') byId.set(a.id, a)
    else if (!byId.has(a.id)) byId.set(a.id, a)
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id))
}

export function SubagentMemoryView() {
  const home = useHomeDir()
  const activeTab = useActiveTab()
  const cwd = activeTab?.cwd ?? null

  const [agents, setAgents] = useState<AgentOption[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [creatingOpen, setCreatingOpen] = useState(false)

  // Per-entry draft cache (keyed by `${agentId}::${entryId}`). Survives sidebar
  // re-renders but clears on agent switch.
  const [draftMap, setDraftMap] = useState<Record<string, string>>({})

  const entriesByAgent = useAgentMemory((s) => s.entriesByAgent)
  const loadAgent = useAgentMemory((s) => s.loadAgent)
  const setEntryAction = useAgentMemory((s) => s.setEntry)
  const deleteEntryAction = useAgentMemory((s) => s.deleteEntry)

  // Refresh agent dropdown when home/cwd changes.
  useEffect(() => {
    if (!home) return
    let cancelled = false
    loadAgentList(home, cwd).then((list) => {
      if (cancelled) return
      setAgents(list)
      setSelectedAgent((prev) => {
        if (prev && list.find((a) => a.id === prev)) return prev
        return list[0]?.id ?? null
      })
    })
    return () => {
      cancelled = true
    }
  }, [home, cwd])

  // Load entries when agent changes. Drafts are keyed `agent::entry`, so we do
  // NOT clear draftMap here — wiping it would silently discard unsaved edits on
  // the previous agent. Per-agent keying means switching away and back restores
  // any in-progress draft, like unsaved tabs.
  useEffect(() => {
    if (!selectedAgent) return
    setSelectedEntryId(null)
    loadAgent(selectedAgent)
  }, [selectedAgent, loadAgent])

  const entries = selectedAgent ? entriesByAgent.get(selectedAgent) ?? [] : []
  const filtered = useMemo(
    () =>
      entries.filter(
        (e) =>
          !filter ||
          e.id.toLowerCase().includes(filter.toLowerCase()) ||
          e.body.toLowerCase().includes(filter.toLowerCase()),
      ),
    [entries, filter],
  )

  const selectedEntry: AgentMemoryEntry | null = useMemo(
    () => entries.find((e) => e.id === selectedEntryId) ?? null,
    [entries, selectedEntryId],
  )

  // Auto-select first entry when list changes. The guard checks `filtered`
  // (the visible list), not `entries`: if the current selection is filtered out
  // by the search box, re-point to the first visible row so the detail pane
  // never shows an entry that isn't in the sidebar.
  useEffect(() => {
    if (!selectedEntryId && filtered.length > 0) {
      setSelectedEntryId(filtered[0].id)
    } else if (selectedEntryId && !filtered.find((e) => e.id === selectedEntryId)) {
      setSelectedEntryId(filtered[0]?.id ?? null)
    }
  }, [filtered, selectedEntryId])

  const draftKey = selectedAgent && selectedEntryId ? `${selectedAgent}::${selectedEntryId}` : null
  const draft = draftKey ? draftMap[draftKey] ?? (selectedEntry?.body ?? '') : ''
  const dirty = !!draftKey && selectedEntry !== null && draft !== selectedEntry.body

  const refresh = useCallback(async () => {
    if (selectedAgent) await loadAgent(selectedAgent)
  }, [selectedAgent, loadAgent])

  const onSave = async () => {
    if (!selectedAgent || !selectedEntryId || !draftKey) return
    setBusy(true)
    const r = await setEntryAction(
      selectedAgent,
      selectedEntryId,
      draft,
      selectedEntry?.category ?? undefined,
    )
    setBusy(false)
    if (!r.ok) {
      toast.error(`Save failed: ${r.error ?? 'unknown'}`)
      return
    }
    // Clear the local draft now that disk matches.
    setDraftMap((m) => {
      const n = { ...m }
      delete n[draftKey]
      return n
    })
  }

  const onDelete = async () => {
    if (!selectedAgent || !selectedEntryId) return
    if (!window.confirm(`Delete memory "${selectedEntryId}"? This cannot be undone.`)) return
    setBusy(true)
    const r = await deleteEntryAction(selectedAgent, selectedEntryId)
    setBusy(false)
    if (!r.ok) {
      toast.error(`Delete failed: ${r.error ?? 'unknown'}`)
      return
    }
    setSelectedEntryId(null)
  }

  const onCategoryChange = async (cat: AgentMemoryCategory | null) => {
    if (!selectedAgent || !selectedEntryId || !selectedEntry) return
    setBusy(true)
    const r = await setEntryAction(selectedAgent, selectedEntryId, selectedEntry.body, cat ?? undefined)
    setBusy(false)
    if (!r.ok) toast.error(`Update failed: ${r.error ?? 'unknown'}`)
  }

  if (!home) return <EmptyState title="loading…" />

  return (
    <Panel
      toolbar={
        <>
          <span className="text-fg-faint">Agent</span>
          <select
            value={selectedAgent ?? ''}
            onChange={(e) => setSelectedAgent(e.target.value || null)}
            className="bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg max-w-[16rem]"
          >
            {agents.length === 0 && <option value="">(no agents found)</option>}
            {agents.map((a) => (
              <option key={`${a.scope}:${a.id}`} value={a.id}>
                {a.label} {a.scope === 'project' ? '· project' : ''}
              </option>
            ))}
          </select>
          <span className="mx-2 text-fg-faint">·</span>
          <span className="text-fg-faint">
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => setCreatingOpen(true)}
            disabled={!selectedAgent}
            className="px-2 py-0.5 text-xs text-fg-dim hover:text-fg border border-line hover:border-fg-faint rounded transition-colors disabled:opacity-40"
          >
            + New entry
          </button>
          <button
            onClick={refresh}
            disabled={!selectedAgent}
            className="ml-2 px-2 py-0.5 text-xs text-fg-faint hover:text-fg-dim border border-line hover:border-fg-faint rounded transition-colors disabled:opacity-40"
          >
            Refresh
          </button>
        </>
      }
      footer={
        selectedEntry ? (
          <div className="px-3 py-1.5 flex items-center gap-3 text-xs">
            <button
              onClick={onSave}
              disabled={!dirty || busy}
              className="px-2 py-0.5 text-xs text-fg-dim hover:text-fg border border-line hover:border-fg-faint rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={onDelete}
              disabled={busy}
              className="px-2 py-0.5 text-xs text-red-400 hover:text-red-300 border border-line hover:border-red-400/50 rounded transition-colors disabled:opacity-40"
            >
              Delete
            </button>
            <span className="text-fg-faint">Category:</span>
            <select
              value={selectedEntry.category ?? ''}
              onChange={(e) =>
                onCategoryChange((e.target.value || null) as AgentMemoryCategory | null)
              }
              disabled={busy}
              className="bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg-dim disabled:opacity-40"
            >
              <option value="">(none)</option>
              {CATEGORY_KEYS.map((k) => (
                <option key={k} value={k}>
                  {CATEGORY_LABELS[k]}
                </option>
              ))}
            </select>
            <span className="text-fg-faint truncate flex-1">{selectedEntry.id}</span>
            {dirty && <span className="text-accent">unsaved</span>}
          </div>
        ) : null
      }
    >
      <ListDetail
        sidebar={
          <div className="py-1">
            <div className="px-2 pb-1">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="filter…"
                className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
              />
            </div>
            {!selectedAgent ? (
              <div className="px-3 py-2 text-xs text-fg-faint italic">select an agent first</div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-fg-faint italic">
                {entries.length === 0 ? 'no entries yet' : 'no matches'}
              </div>
            ) : (
              filtered.map((e) => (
                <button
                  key={e.id}
                  onClick={() => setSelectedEntryId(e.id)}
                  className={`w-full text-left px-3 py-1 text-xs flex items-center justify-between ${
                    selectedEntryId === e.id
                      ? 'bg-bg-hi text-fg'
                      : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
                  }`}
                  title={e.id}
                >
                  <span className="truncate">{e.id}</span>
                  <span className="ml-2 text-fg-faint shrink-0 text-[10px]">
                    {formatBytes(e.bytes)} · {formatMtime(e.updatedAt)}
                  </span>
                </button>
              ))
            )}
          </div>
        }
        detail={
          creatingOpen && selectedAgent ? (
            <NewEntryForm
              agentId={selectedAgent}
              existingIds={new Set(entries.map((e) => e.id))}
              onCancel={() => setCreatingOpen(false)}
              onCreated={(id) => {
                setCreatingOpen(false)
                setSelectedEntryId(id)
                loadAgent(selectedAgent)
              }}
            />
          ) : selectedEntry && selectedAgent && selectedEntryId && draftKey ? (
            <div className="h-full flex flex-col">
              <div className="shrink-0 px-3 py-2 border-b border-line text-xs">
                <div className="text-fg truncate">{selectedEntry.id}</div>
                <div className="text-fg-faint truncate">
                  {formatBytes(selectedEntry.bytes)} · modified {formatMtime(selectedEntry.updatedAt)}
                  {selectedEntry.category ? ` · ${CATEGORY_LABELS[selectedEntry.category]}` : ''}
                </div>
              </div>
              <div className="flex-1 min-h-0">
                <MarkdownEditor
                  path={`agent-memory/${selectedAgent}/${selectedEntry.id}.md`}
                  value={draft}
                  onChange={(v) => setDraftMap((m) => ({ ...m, [draftKey]: v }))}
                />
              </div>
            </div>
          ) : (
            <EmptyState
              title={
                !selectedAgent
                  ? 'no agent selected'
                  : entries.length === 0
                    ? 'no entries yet'
                    : 'select an entry'
              }
              hint={
                selectedAgent && entries.length === 0
                  ? 'Use “+ New entry” to give this subagent its first memory.'
                  : undefined
              }
            />
          )
        }
      />
    </Panel>
  )
}

function NewEntryForm({
  agentId,
  existingIds,
  onCancel,
  onCreated,
}: {
  agentId: string
  existingIds: Set<string>
  onCancel: () => void
  onCreated: (id: string) => void
}) {
  const setEntryAction = useAgentMemory((s) => s.setEntry)
  const [slug, setSlug] = useState('')
  const [body, setBody] = useState('')
  const [category, setCategory] = useState<AgentMemoryCategory | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const normalized = slug.trim()
  const valid = ENTRY_SLUG_RE.test(normalized) && !existingIds.has(normalized)
  const slugError = !slug
    ? null
    : !ENTRY_SLUG_RE.test(normalized)
      ? 'must match [A-Za-z0-9._-]+'
      : existingIds.has(normalized)
        ? 'an entry with this id already exists'
        : null

  const submit = async () => {
    if (!valid) return
    setBusy(true)
    setError(null)
    const r = await setEntryAction(agentId, normalized, body, category || undefined)
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? 'create failed')
      return
    }
    onCreated(normalized)
  }

  return (
    <div className="p-4 max-w-xl space-y-3">
      <div className="text-sm text-fg">New memory entry for <span className="font-mono text-fg-dim">{agentId}</span></div>
      <div className="space-y-1">
        <label className="block text-xs text-fg-faint">Entry id</label>
        <input
          autoFocus
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="e.g. preferred-test-runner"
          className="w-full bg-bg border border-line rounded px-2 py-1 text-xs text-fg font-mono"
        />
        {slugError && <div className="text-[10px] text-red-400">{slugError}</div>}
        <div className="text-[10px] text-fg-faint">
          Letters, digits, dots, dashes, underscores. Persists at
          <code className="ml-1 font-mono text-fg-dim">~/.claude/session-manager/agent-memory/{agentId}.json</code>.
        </div>
      </div>
      <div className="space-y-1">
        <label className="block text-xs text-fg-faint">Category (optional)</label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as AgentMemoryCategory | '')}
          className="bg-bg border border-line rounded px-2 py-1 text-xs text-fg"
        >
          <option value="">(none)</option>
          {CATEGORY_KEYS.map((k) => (
            <option key={k} value={k}>
              {CATEGORY_LABELS[k]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label className="block text-xs text-fg-faint">Body (markdown)</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder="What should this subagent remember?"
          className="w-full bg-bg border border-line rounded px-2 py-1 text-xs text-fg font-mono"
        />
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={!valid || busy}
          className="px-3 py-1 text-xs text-fg border border-line hover:bg-bg-hi rounded transition-colors disabled:opacity-40"
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-3 py-1 text-xs text-fg-faint hover:text-fg-dim rounded transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
