/**
 * HiveManagerModal — manage pre-baked subagent swarm recipes.
 *
 * Two-pane layout:
 *   Left  — list of recipes. Defaults appear first with a "(default)" tag.
 *   Right — editor: name, description, brief, and a steps list
 *           (agentName dropdown + optional note per step).
 *           Defaults are read-only; click "Clone to edit" to copy.
 *
 * Steps reference agents by name only — no prompt stored here.
 * Full resolution (agentName → .md content) is PRD 126.
 *
 * Missing-step handling:
 *   - agentName not installed + matches a CATALOG_AGENTS id → inline "Install" button
 *   - agentName not installed + not in catalog → "missing — pick another agent" label
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { useHives, generateHiveSlug } from '../../state/hives'
import { useOrchestrator } from '../../state/orchestrator'
import { useAgentNames } from '../../lib/useAgentNames'
import { useHomeDir } from '../../lib/useHomeDir'
import { isDefaultHive } from '../../lib/defaultHives'
import { toast } from '../../state/toast'
import { CATALOG_AGENTS } from '../../data/catalog'
import type { Recipe, RecipeStep } from '../../../preload/api'

const MAX_NOTE_LEN = 2048
const MAX_BRIEF_LEN = 8192
const MAX_STEPS = 32

interface HiveManagerModalProps {
  open: boolean
  onClose: () => void
  /** Called after the user clicks Launch, so the parent can switch modals. */
  onLaunch?: () => void
  variant?: 'overlay' | 'page'
}

export function HiveManagerModal({ open, onClose, onLaunch, variant = 'overlay' }: HiveManagerModalProps) {
  const list = useHives((s) => s.list)
  const selectedSlug = useHives((s) => s.selectedSlug)
  const loading = useHives((s) => s.loading)
  const load = useHives((s) => s.load)
  const select = useHives((s) => s.select)
  const saveHive = useHives((s) => s.save)
  const deleteHive = useHives((s) => s.delete)
  const launchHiveOrch = useOrchestrator((s) => s.launchHive)

  const home = useHomeDir()
  const { agents, reload: reloadAgents } = useAgentNames('user')
  const installedNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])

  const [draft, setDraft] = useState<Recipe | null>(null)
  const [dirty, setDirty] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [installBusy, setInstallBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  useEffect(() => {
    if (!open) return
    if (selectedSlug) return
    if (list.length === 0) return
    select(list[0].slug)
  }, [open, list, selectedSlug, select])

  const selectedHive = useMemo(
    () => list.find((h) => h.slug === selectedSlug) ?? null,
    [list, selectedSlug],
  )

  useEffect(() => {
    if (!selectedHive) {
      setDraft(null)
      setDirty(false)
      return
    }
    setDraft(structuredClone(selectedHive))
    setDirty(false)
  }, [selectedHive])

  const isDefault = selectedHive ? isDefaultHive(selectedHive.slug) : false
  const canEdit = !!draft && !isDefault

  const handleNewHive = useCallback(() => {
    let slug = generateHiveSlug('hive')
    const taken = new Set(list.map((h) => h.slug))
    let guard = 0
    while (taken.has(slug) && guard++ < 8) slug = generateHiveSlug('hive')
    const blank: Recipe = {
      slug,
      name: 'New recipe',
      description: '',
      steps: [{ agentName: '' }],
    }
    void saveHive(blank).then((res) => {
      if (res.ok) select(slug)
    })
  }, [list, saveHive, select])

  const handleClone = useCallback(() => {
    if (!selectedHive) return
    const slug = generateHiveSlug(selectedHive.name)
    const clone: Recipe = {
      slug,
      name: `${selectedHive.name} (copy)`,
      description: selectedHive.description,
      brief: selectedHive.brief,
      steps: selectedHive.steps.map((s) => ({ ...s })),
    }
    void saveHive(clone).then((res) => {
      if (res.ok) {
        select(slug)
        toast.info(`Cloned "${selectedHive.name}" → editable copy`)
      }
    })
  }, [selectedHive, saveHive, select])

  const handleSave = useCallback(async () => {
    if (!draft || !canEdit) return
    const cleaned: Recipe = {
      ...draft,
      name: draft.name.trim() || 'Untitled recipe',
      description: draft.description.trim(),
      brief: draft.brief?.trim() || undefined,
      steps: draft.steps.filter((s) => s.agentName.trim().length > 0),
    }
    if (cleaned.steps.length === 0) {
      toast.warn('Recipe needs at least one step with a non-empty agent name.')
      return
    }
    setSaving(true)
    const res = await saveHive(cleaned)
    setSaving(false)
    if (res.ok) {
      setDirty(false)
      toast.info(`Saved recipe "${cleaned.name}"`)
    }
  }, [draft, canEdit, saveHive])

  const handleDelete = useCallback(async () => {
    if (!selectedHive || isDefault) return
    const res = await deleteHive(selectedHive.slug)
    if (res.ok) {
      toast.info(`Deleted recipe "${selectedHive.name}"`)
      setConfirmDelete(null)
    }
  }, [selectedHive, isDefault, deleteHive])

  const handleLaunch = useCallback(() => {
    if (!selectedHive) return
    if (selectedHive.steps.length === 0) {
      toast.warn('This recipe has no steps to launch.')
      return
    }
    // PRD 126 bridge: agentName as label, brief+note as placeholder prompt.
    launchHiveOrch({
      name: selectedHive.name,
      defaultPlan: selectedHive.brief || undefined,
      roles: selectedHive.steps.map((s) => ({
        label: s.agentName,
        prompt: s.note ? `${selectedHive.brief ?? ''}\n\n${s.note}`.trim() : selectedHive.brief ?? s.agentName,
      })),
    })
    onLaunch?.()
    onClose()
  }, [selectedHive, launchHiveOrch, onLaunch, onClose])

  const patchDraft = useCallback(
    (patch: Partial<Omit<Recipe, 'slug' | 'steps'>>) => {
      if (!draft) return
      setDraft({ ...draft, ...patch })
      setDirty(true)
    },
    [draft],
  )

  const patchStep = useCallback(
    (i: number, patch: Partial<RecipeStep>) => {
      if (!draft) return
      const next = draft.steps.slice()
      next[i] = { ...next[i], ...patch }
      setDraft({ ...draft, steps: next })
      setDirty(true)
    },
    [draft],
  )

  const addStep = useCallback(() => {
    if (!draft) return
    if (draft.steps.length >= MAX_STEPS) {
      toast.warn(`Recipes support at most ${MAX_STEPS} steps.`)
      return
    }
    setDraft({ ...draft, steps: [...draft.steps, { agentName: '' }] })
    setDirty(true)
  }, [draft])

  const removeStep = useCallback(
    (i: number) => {
      if (!draft) return
      setDraft({ ...draft, steps: draft.steps.filter((_, idx) => idx !== i) })
      setDirty(true)
    },
    [draft],
  )

  const moveStep = useCallback(
    (i: number, dir: 'up' | 'down') => {
      if (!draft) return
      const next = draft.steps.slice()
      const target = dir === 'up' ? i - 1 : i + 1
      if (target < 0 || target >= next.length) return
      ;[next[i], next[target]] = [next[target], next[i]]
      setDraft({ ...draft, steps: next })
      setDirty(true)
    },
    [draft],
  )

  const installAgent = useCallback(
    async (agentId: string) => {
      if (!home) return
      const catalogEntry = CATALOG_AGENTS.find((a) => a.id === agentId)
      if (!catalogEntry) return
      setInstallBusy(agentId)
      const path = `${home}/.claude/agents/${agentId}.md`
      const r = await window.api.config.writeText(path, catalogEntry.content)
      setInstallBusy(null)
      if (!r.ok) {
        toast.error(`Install failed: ${r.error ?? 'write error'}`)
        return
      }
      toast.info(`Installed ${agentId}`)
      await reloadAgents()
    },
    [home, reloadAgents],
  )

  return (
    <Modal open={open} onClose={onClose} size="xl" fillHeight noPadding variant={variant}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-line shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-base">⛓</span>
          <h2 className="text-xs uppercase tracking-wider text-fg-dim">
            Recipes — pre-baked subagent swarms
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="default" onClick={handleNewHive}>+ New recipe</Button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="px-2 py-0.5 text-fg-dim hover:text-fg hover:bg-bg-hi rounded text-base leading-none"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Left pane — recipe list */}
        <div className="w-64 shrink-0 border-r border-line overflow-auto">
          {loading && list.length === 0 ? (
            <div className="px-3 py-2 text-xs text-fg-faint">Loading recipes…</div>
          ) : list.length === 0 ? (
            <div className="px-3 py-2 text-xs text-fg-faint">No recipes yet.</div>
          ) : (
            <ul role="listbox" className="py-1">
              {list.map((h) => {
                const isSel = h.slug === selectedSlug
                const def = isDefaultHive(h.slug)
                return (
                  <li key={h.slug}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSel}
                      onClick={() => select(h.slug)}
                      className={`w-full text-left px-3 py-2 text-xs border-l-2 transition-colors ${
                        isSel
                          ? 'bg-bg-hi border-accent text-fg'
                          : 'border-transparent text-fg-dim hover:bg-bg-hi/50 hover:text-fg'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">{h.name}</span>
                        {def && (
                          <span className="shrink-0 text-[9px] uppercase tracking-wider text-fg-faint">
                            (default)
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-fg-faint truncate">
                        {h.steps.length} step{h.steps.length !== 1 ? 's' : ''}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Right pane — editor */}
        <div className="flex-1 min-w-0 overflow-auto p-4">
          {!draft ? (
            <div className="text-xs text-fg-faint">Select a recipe on the left.</div>
          ) : (
            <div className="space-y-4">
              {/* Editor toolbar */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-fg-faint">{draft.slug}</span>
                  {isDefault && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg border border-line text-fg-faint">
                      default · read-only
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {isDefault ? (
                    <Button variant="default" onClick={handleClone}>Clone to edit</Button>
                  ) : (
                    <>
                      <Button
                        variant="default"
                        onClick={() => setConfirmDelete(draft.slug)}
                        disabled={saving}
                      >
                        Delete
                      </Button>
                      <Button
                        variant="primary"
                        onClick={handleSave}
                        disabled={!dirty || saving}
                      >
                        {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
                      </Button>
                    </>
                  )}
                  {onLaunch && (
                    <Button variant="primary" onClick={handleLaunch}>
                      Launch hive →
                    </Button>
                  )}
                </div>
              </div>

              {/* Name + description */}
              <div className="space-y-2">
                <Field label="Name">
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(e) => patchDraft({ name: e.target.value })}
                    readOnly={!canEdit}
                    className="w-full bg-bg border border-line rounded px-3 py-1.5 text-sm text-fg focus:outline-none focus:border-accent"
                  />
                </Field>
                <Field label="Description">
                  <textarea
                    value={draft.description}
                    onChange={(e) => patchDraft({ description: e.target.value })}
                    readOnly={!canEdit}
                    rows={2}
                    className="w-full bg-bg border border-line rounded px-3 py-1.5 text-xs text-fg focus:outline-none focus:border-accent resize-none"
                  />
                </Field>
                <Field label={`Brief (optional — shared goal sent to every step, max ${MAX_BRIEF_LEN} chars)`}>
                  <textarea
                    value={draft.brief ?? ''}
                    onChange={(e) => patchDraft({ brief: e.target.value.slice(0, MAX_BRIEF_LEN) || undefined })}
                    readOnly={!canEdit}
                    rows={3}
                    className="w-full bg-bg border border-line rounded px-3 py-1.5 text-xs text-fg focus:outline-none focus:border-accent resize-none font-mono"
                    placeholder="What should the swarm accomplish? Each agent receives this as context."
                  />
                </Field>
              </div>

              {/* Steps */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] uppercase tracking-wider text-fg-faint">
                    Steps — one agent per step
                  </label>
                  <span className="text-[10px] text-fg-faint">
                    {draft.steps.length}/{MAX_STEPS}
                  </span>
                </div>
                <div className="space-y-2">
                  {draft.steps.map((step, i) => (
                    <StepRow
                      key={i}
                      index={i}
                      step={step}
                      total={draft.steps.length}
                      installedNames={installedNames}
                      canEdit={canEdit}
                      installBusy={installBusy}
                      onChange={(patch) => patchStep(i, patch)}
                      onRemove={() => removeStep(i)}
                      onMove={(dir) => moveStep(i, dir)}
                      onInstall={installAgent}
                    />
                  ))}
                  {canEdit && (
                    <Button variant="default" onClick={addStep} disabled={draft.steps.length >= MAX_STEPS}>
                      + Add step
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation overlay */}
      {confirmDelete && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50">
          <div className="bg-bg-elev border border-line rounded p-4 max-w-sm space-y-3">
            <div className="text-sm text-fg">
              Delete recipe <span className="font-mono text-accent">{confirmDelete}</span>?
              This cannot be undone.
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="default" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button variant="primary" onClick={handleDelete}>Delete</Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

function StepRow({
  index,
  step,
  total,
  installedNames,
  canEdit,
  installBusy,
  onChange,
  onRemove,
  onMove,
  onInstall,
}: {
  index: number
  step: RecipeStep
  total: number
  installedNames: Set<string>
  canEdit: boolean
  installBusy: string | null
  onChange: (patch: Partial<RecipeStep>) => void
  onRemove: () => void
  onMove: (dir: 'up' | 'down') => void
  onInstall: (id: string) => Promise<void>
}) {
  const installed = !step.agentName || installedNames.has(step.agentName)
  const catalogEntry = !installed ? CATALOG_AGENTS.find((a) => a.id === step.agentName) : null
  const isMissing = step.agentName.length > 0 && !installed

  return (
    <div className={`border rounded p-2 bg-bg space-y-1.5 ${isMissing ? 'border-yellow-600/50' : 'border-line'}`}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-accent font-mono shrink-0">S{index + 1}</span>

        {/* Agent name: dropdown if agents exist, otherwise free-text input */}
        {canEdit ? (
          <AgentNameSelect
            value={step.agentName}
            installedNames={installedNames}
            onChange={(v) => onChange({ agentName: v })}
          />
        ) : (
          <span className="flex-1 font-mono text-xs text-fg px-2 py-1">{step.agentName || '(none)'}</span>
        )}

        {canEdit && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={() => onMove('up')}
              disabled={index === 0}
              className="px-1 py-0.5 text-fg-faint hover:text-fg disabled:opacity-30 text-xs"
              aria-label="Move step up"
            >
              ▲
            </button>
            <button
              type="button"
              onClick={() => onMove('down')}
              disabled={index === total - 1}
              className="px-1 py-0.5 text-fg-faint hover:text-fg disabled:opacity-30 text-xs"
              aria-label="Move step down"
            >
              ▼
            </button>
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove step ${index + 1}`}
              className="text-fg-faint hover:text-red-400 px-1.5 py-0.5 text-sm"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Note */}
      {canEdit && (
        <input
          type="text"
          value={step.note ?? ''}
          onChange={(e) => onChange({ note: e.target.value.slice(0, MAX_NOTE_LEN) || undefined })}
          placeholder="Optional step note (specific focus for this agent)…"
          className="w-full bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent font-mono"
        />
      )}
      {!canEdit && step.note && (
        <div className="text-xs text-fg-dim font-mono px-1">{step.note}</div>
      )}

      {/* Missing-step indicator */}
      {isMissing && (
        <div className="flex items-center gap-2 px-1 pt-0.5">
          <span className="text-[11px] text-yellow-400">
            {catalogEntry ? `⚠ not installed` : `⚠ missing — pick another agent`}
          </span>
          {catalogEntry && (
            <button
              type="button"
              disabled={installBusy === step.agentName}
              onClick={() => void onInstall(step.agentName)}
              className="text-[11px] font-semibold text-accent hover:underline disabled:opacity-50"
            >
              {installBusy === step.agentName ? 'Installing…' : `Install ${step.agentName}`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function AgentNameSelect({
  value,
  installedNames,
  onChange,
}: {
  value: string
  installedNames: Set<string>
  onChange: (v: string) => void
}) {
  const sortedNames = useMemo(() => Array.from(installedNames).sort(), [installedNames])

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="flex-1 bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg focus:outline-none focus:border-accent font-mono"
    >
      <option value="">(pick an agent)</option>
      {sortedNames.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
      {/* Preserve a currently-selected value that is no longer installed */}
      {value && !installedNames.has(value) && (
        <option value={value}>{value} (missing)</option>
      )}
    </select>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-fg-faint mb-1 block">{label}</label>
      {children}
    </div>
  )
}
