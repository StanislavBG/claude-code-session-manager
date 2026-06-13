/**
 * Prompts — Workspace tab for the bundled seed prompts.
 *
 * Layout: list+detail (mirrors Skills.tsx).
 *   Left sidebar  — prompts grouped by category, filter input at top.
 *   Right detail  — title, category chip, sendMode chip, description,
 *                   body in a monospace read-only block, and three action
 *                   buttons: "Use prompt", "Edit root template", "Reset to
 *                   default" (only when user has a custom override).
 *
 * Overrides are written to:
 *   ~/.claude/session-manager/prompts/<category>/<slug>.md
 * via promptsStore.ts. Seed files under src/seed/prompts/ are never modified.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { EmptyState } from '../ui/EmptyState'
import { SaveBar } from '../ui/SaveBar'
import { seedPrompts } from '../../lib/promptsSeed'
import { loadEffective, saveOverride, resetToDefault } from '../../lib/promptsStore'
import type { Prompt, SendMode } from '../../lib/promptFrontmatter'
import { TweakModal } from './prompts/TweakModal'
import { useSessions } from '../../state/sessions'
import { toast } from '../../state/toast'

// Fixed display order for category groups. Categories found in the seed set
// but missing here are appended after, so new seed categories never vanish.
const CATEGORY_ORDER: string[] = [
  'Security',
  'QA',
  'Performance',
  'Code Review',
  'Debugging',
  'Refactoring',
  'Documentation',
  'Git / PR',
]

const ALL_CATEGORIES: string[] = [
  ...CATEGORY_ORDER,
  ...[...new Set(seedPrompts.map((p) => p.category))].filter((c) => !CATEGORY_ORDER.includes(c)),
]

// Category → colour chip classes (accent tints for visual differentiation).
const CATEGORY_CHIP: Record<string, string> = {
  'Security':      'bg-red-500/10 text-red-400 border-red-500/20',
  'QA':            'bg-green-500/10 text-green-400 border-green-500/20',
  'Performance':   'bg-orange-500/10 text-orange-400 border-orange-500/20',
  'Code Review':   'bg-blue-500/10 text-blue-400 border-blue-500/20',
  'Debugging':     'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  'Refactoring':   'bg-purple-500/10 text-purple-400 border-purple-500/20',
  'Documentation': 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  'Git / PR':      'bg-pink-500/10 text-pink-400 border-pink-500/20',
}

const SEND_MODE_CHIP: Record<SendMode, string> = {
  'paste':     'bg-fg-faint/10 text-fg-faint border-fg-faint/20',
  'auto-fire': 'bg-accent/10 text-accent border-accent/20',
}

export function Prompts() {
  const [filter, setFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(
    () => seedPrompts[0]?.id ?? null,
  )
  const [tweakOpen, setTweakOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)

  // The "effective" prompt — seed or user override.
  const [effective, setEffective] = useState<Prompt | null>(null)
  const [loadingEffective, setLoadingEffective] = useState(false)

  // Edit draft for "Edit root template" mode. Dirty is derived: the draft
  // diverged from the effective body.
  const [editDraft, setEditDraft] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const activeTabId = useSessions((s) => s.activeTabId)

  // Latest selection — lets in-flight async work detect a stale selection.
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId

  // Load effective prompt whenever selection changes.
  useEffect(() => {
    if (!selectedId) { setEffective(null); return }
    let cancelled = false
    setLoadingEffective(true)
    loadEffective(selectedId)
      .then((p) => { if (!cancelled) { setEffective(p); setLoadingEffective(false) } })
      .catch(() => {
        if (!cancelled) {
          const seed = seedPrompts.find((s) => s.id === selectedId) ?? null
          setEffective(seed)
          setLoadingEffective(false)
        }
      })
    return () => { cancelled = true }
  }, [selectedId])

  // When we enter edit mode, seed the draft from the current effective body.
  useEffect(() => {
    if (editMode && effective) {
      setEditDraft(effective.body)
      setEditError(null)
    }
  }, [editMode, effective])

  const editDirty = editMode && effective !== null && editDraft !== effective.body

  // Is the effective body different from the seed? Show "Reset to default" if so.
  const seedBody = useMemo(
    () => seedPrompts.find((s) => s.id === selectedId)?.body ?? null,
    [selectedId],
  )
  const isCustomized = effective !== null && seedBody !== null && effective.body !== seedBody

  // Filtered + grouped prompts for the sidebar.
  const grouped = useMemo(() => {
    const needle = filter.toLowerCase()
    return ALL_CATEGORIES.map((cat) => ({
      category: cat,
      items: seedPrompts.filter(
        (p) =>
          p.category === cat &&
          (!needle ||
            p.title.toLowerCase().includes(needle) ||
            p.description.toLowerCase().includes(needle)),
      ),
    })).filter((g) => g.items.length > 0)
  }, [filter])

  const handleSelect = useCallback((id: string) => {
    if (id === selectedId) return
    setSelectedId(id)
    setEditMode(false)
    setEditError(null)
  }, [selectedId])

  // Shared shell for save/reset: run the mutation, reload the effective
  // prompt so the detail panel reflects it, and leave edit mode.
  async function mutate(action: (id: string) => Promise<void>, failLabel: string) {
    if (!selectedId) return
    const id = selectedId
    setEditBusy(true)
    setEditError(null)
    try {
      await action(id)
      const next = await loadEffective(id)
      if (selectedIdRef.current !== id) return // selection changed mid-flight
      setEffective(next)
      setEditMode(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : failLabel
      toast.error(msg)
      if (selectedIdRef.current === id) setEditError(msg)
    } finally {
      setEditBusy(false)
    }
  }

  const handleSave = () => mutate((id) => saveOverride(id, editDraft), 'save failed')
  const handleReset = () => mutate(resetToDefault, 'reset failed')

  return (
    <Panel
      toolbar={
        <span className="text-fg-faint">
          {seedPrompts.length} prompts across {ALL_CATEGORIES.length} categories
        </span>
      }
      footer={
        editMode && selectedId ? (
          <SaveBar
            dirty={editDirty}
            busy={editBusy}
            parseError={editError}
            lastSavedAt={null}
            onSave={handleSave}
            onRevert={() => {
              setEditDraft(effective?.body ?? '')
              setEditError(null)
            }}
          />
        ) : null
      }
    >
      <ListDetail
        sidebarWidth="17rem"
        sidebar={
          <div className="py-1">
            <div className="px-2 pb-2 pt-1">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="filter…"
                className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
              />
            </div>
            {grouped.length === 0 ? (
              <div className="px-3 py-2 text-xs text-fg-faint italic">no matches</div>
            ) : (
              grouped.map(({ category, items }) => (
                <div key={category} className="mb-2">
                  <div className="px-3 py-1 text-[10.5px] uppercase tracking-wider text-fg-faint font-semibold">
                    {category}
                  </div>
                  {items.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => handleSelect(p.id)}
                      title={p.description}
                      className={`w-full px-3 py-1.5 text-xs text-left truncate transition-colors ${
                        selectedId === p.id
                          ? 'bg-bg-hi text-fg'
                          : 'text-fg-dim hover:text-fg hover:bg-bg-hi/50'
                      }`}
                    >
                      {p.title}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        }
        detail={
          loadingEffective || !effective ? (
            <EmptyState title={loadingEffective ? 'loading…' : 'select a prompt'} />
          ) : editMode ? (
            <EditPane
              draft={editDraft}
              onChange={setEditDraft}
              onCancel={() => setEditMode(false)}
            />
          ) : (
            <DetailPane
              effective={effective}
              isCustomized={isCustomized}
              activeTabId={activeTabId}
              onUsePrompt={() => setTweakOpen(true)}
              onEdit={() => setEditMode(true)}
              onReset={handleReset}
            />
          )
        }
      />

      {tweakOpen && effective && (
        <TweakModal
          key={effective.id}
          prompt={effective}
          open={tweakOpen}
          activeTabId={activeTabId}
          onClose={() => setTweakOpen(false)}
        />
      )}
    </Panel>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface DetailPaneProps {
  effective: Prompt
  isCustomized: boolean
  activeTabId: string | null
  onUsePrompt: () => void
  onEdit: () => void
  onReset: () => void
}

function DetailPane({
  effective,
  isCustomized,
  activeTabId,
  onUsePrompt,
  onEdit,
  onReset,
}: DetailPaneProps) {
  const catChip = CATEGORY_CHIP[effective.category] ?? 'bg-fg-faint/10 text-fg-faint border-fg-faint/20'
  const modeChip = SEND_MODE_CHIP[effective.sendMode]

  return (
    <div className="p-4 flex flex-col gap-3">
      {/* Header row */}
      <div className="flex items-start gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-fg flex-1 min-w-0">{effective.title}</h2>
        <span className={`shrink-0 text-[10.5px] px-1.5 py-0.5 rounded border font-mono ${catChip}`}>
          {effective.category}
        </span>
        <span className={`shrink-0 text-[10.5px] px-1.5 py-0.5 rounded border font-mono ${modeChip}`}>
          {effective.sendMode}
        </span>
      </div>

      {/* Description */}
      <p className="text-xs text-fg-dim">{effective.description}</p>

      {/* Body */}
      <pre className="whitespace-pre-wrap font-mono text-[12.5px] bg-bg-elev border border-line rounded p-3 text-fg overflow-x-auto">
        {effective.body}
      </pre>

      {/* Action buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={onUsePrompt}
          className="px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/80 transition-colors"
        >
          Use prompt
          {!activeTabId && (
            <span className="ml-1 opacity-60 font-normal">(no session)</span>
          )}
        </button>
        <button
          onClick={onEdit}
          className="px-3 py-1.5 rounded bg-bg-hi border border-line text-fg text-xs hover:bg-bg-hi/70 transition-colors"
        >
          Edit root template
        </button>
        {isCustomized && (
          <button
            onClick={onReset}
            className="ml-auto px-3 py-1.5 rounded border border-line text-xs text-fg-dim hover:text-fg hover:border-accent/40 transition-colors"
          >
            Reset to default
          </button>
        )}
      </div>
    </div>
  )
}

interface EditPaneProps {
  draft: string
  onChange: (v: string) => void
  onCancel: () => void
}

function EditPane({ draft, onChange, onCancel }: EditPaneProps) {
  return (
    <div className="p-4 flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-fg">Edit root template</span>
        <button
          onClick={onCancel}
          className="text-xs text-fg-dim hover:text-fg transition-colors"
        >
          Cancel
        </button>
      </div>
      <textarea
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 min-h-[16rem] w-full bg-bg border border-line rounded px-3 py-2 text-xs font-mono text-fg resize-y focus:outline-none focus:border-accent/60"
        aria-label="Edit prompt body"
      />
      <p className="text-[11px] text-fg-faint">
        Saves to <code>~/.claude/session-manager/prompts/…</code> — overrides the seed on future opens.
      </p>
    </div>
  )
}
