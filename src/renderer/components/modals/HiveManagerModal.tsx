/**
 * HiveManagerModal — manage pre-baked subagent swarm templates ("Hives").
 *
 * Two-pane layout:
 *   Left  — list of hives. Defaults appear first with a "(default)" tag,
 *           user-saved hives follow. Selecting one populates the right pane.
 *   Right — editor for the selected hive: name, description, defaultPlan,
 *           and a roles list (label + prompt per role). Defaults are
 *           read-only; click "Clone to edit" to copy into a writable user hive.
 *
 * Header buttons:
 *   "+ New hive"  — creates a blank user hive locally and selects it.
 *   "Launch hive" (active panel only) — pre-fills the Orchestrator with the
 *                  selected hive's roles + defaultPlan, opens OrchestratorModal,
 *                  and closes this one.
 *
 * The Launch handoff goes through `useOrchestrator.launchHive(hive)` which
 * writes the roles into the orchestrator store's `pendingRoles` mailbox.
 * OrchestratorModal reads it on mount and seeds its local row form.
 *
 * Storage is renderer-local (zustand `useHives`) until the user clicks Save —
 * then it goes through IPC `hives:save` → `~/.claude/session-manager/hives/*.json`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { useHives, generateHiveSlug } from '../../state/hives'
import { useOrchestrator } from '../../state/orchestrator'
import { isDefaultHive } from '../../lib/defaultHives'
import { toast } from '../../state/toast'
import type { Hive, HiveRole } from '../../../preload/api'

interface HiveManagerModalProps {
  open: boolean
  onClose: () => void
  /** Called after the user clicks Launch, so the parent (App.tsx) can switch
   *  the open modal from 'hives' to 'orchestrator'. */
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

  const [draft, setDraft] = useState<Hive | null>(null)
  const [dirty, setDirty] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Hydrate the user-saved list whenever the modal opens.
  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  // Auto-select the first hive when the list becomes available and nothing is
  // selected. Saves a click on first open.
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

  // Sync the editor draft whenever the selection changes, dropping any unsaved
  // edits. The "dirty" flag exists so we can highlight the Save button.
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
    // Astronomically unlikely collision, but guard anyway.
    const taken = new Set(list.map((h) => h.slug))
    let guard = 0
    while (taken.has(slug) && guard++ < 8) slug = generateHiveSlug('hive')
    const blank: Hive = {
      slug,
      name: 'New hive',
      description: '',
      // The IPC save schema requires a non-empty prompt per role. Seed with a
      // placeholder so the first save succeeds; the user can rewrite it.
      roles: [{ label: 'Role 1', prompt: 'Describe what this subagent should do.' }],
      defaultPlan: '',
    }
    // Optimistic local insert — Save persists to disk.
    const ok = saveHive(blank)
    void ok.then((res) => {
      if (res.ok) {
        select(slug)
      }
    })
  }, [list, saveHive, select])

  const handleClone = useCallback(() => {
    if (!selectedHive) return
    const slug = generateHiveSlug(selectedHive.name)
    const clone: Hive = {
      slug,
      name: `${selectedHive.name} (copy)`,
      description: selectedHive.description,
      roles: selectedHive.roles.map((r) => ({ ...r })),
      defaultPlan: selectedHive.defaultPlan,
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
    // Drop empty roles before save; backend requires roles.length >= 1.
    const cleaned: Hive = {
      ...draft,
      roles: draft.roles
        .map((r) => ({ label: r.label.trim(), prompt: r.prompt.trim() }))
        .filter((r) => r.label.length > 0 && r.prompt.length > 0),
      description: draft.description.trim(),
      defaultPlan: draft.defaultPlan?.trim() || undefined,
      name: draft.name.trim() || 'Untitled hive',
    }
    if (cleaned.roles.length === 0) {
      toast.warn('Hive needs at least one role with a non-empty prompt.')
      return
    }
    setSaving(true)
    const res = await saveHive(cleaned)
    setSaving(false)
    if (res.ok) {
      setDirty(false)
      toast.info(`Saved hive "${cleaned.name}"`)
    }
  }, [draft, canEdit, saveHive])

  const handleDelete = useCallback(async () => {
    if (!selectedHive || isDefault) return
    const res = await deleteHive(selectedHive.slug)
    if (res.ok) {
      toast.info(`Deleted hive "${selectedHive.name}"`)
      setConfirmDelete(null)
    }
  }, [selectedHive, isDefault, deleteHive])

  const handleLaunch = useCallback(() => {
    if (!selectedHive) return
    if (selectedHive.roles.length === 0) {
      toast.warn('This hive has no roles to launch.')
      return
    }
    launchHiveOrch({
      name: selectedHive.name,
      defaultPlan: selectedHive.defaultPlan,
      roles: selectedHive.roles.map((r) => ({ label: r.label, prompt: r.prompt })),
    })
    onLaunch?.()
    onClose()
  }, [selectedHive, launchHiveOrch, onLaunch, onClose])

  const patchDraft = useCallback(
    (patch: Partial<Omit<Hive, 'slug'>>) => {
      if (!draft) return
      setDraft({ ...draft, ...patch })
      setDirty(true)
    },
    [draft],
  )

  const patchRole = useCallback(
    (i: number, role: Partial<HiveRole>) => {
      if (!draft) return
      const next = draft.roles.slice()
      next[i] = { ...next[i], ...role }
      setDraft({ ...draft, roles: next })
      setDirty(true)
    },
    [draft],
  )

  const addRole = useCallback(() => {
    if (!draft) return
    setDraft({
      ...draft,
      roles: [...draft.roles, { label: `Role ${draft.roles.length + 1}`, prompt: '' }],
    })
    setDirty(true)
  }, [draft])

  const removeRole = useCallback(
    (i: number) => {
      if (!draft) return
      const next = draft.roles.filter((_, idx) => idx !== i)
      setDraft({ ...draft, roles: next })
      setDirty(true)
    },
    [draft],
  )

  return (
    <Modal open={open} onClose={onClose} size="xl" fillHeight noPadding variant={variant}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-line shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-base">⛓</span>
          <h2 className="text-xs uppercase tracking-wider text-fg-dim">
            Hives — pre-baked subagent swarms
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="default" onClick={handleNewHive}>+ New hive</Button>
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
        {/* Left pane — hive list */}
        <div className="w-64 shrink-0 border-r border-line overflow-auto">
          {loading && list.length === 0 ? (
            <div className="px-3 py-2 text-xs text-fg-faint">Loading hives…</div>
          ) : list.length === 0 ? (
            <div className="px-3 py-2 text-xs text-fg-faint">No hives yet.</div>
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
                        {h.roles.length} role{h.roles.length !== 1 ? 's' : ''}
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
            <div className="text-xs text-fg-faint">Select a hive on the left.</div>
          ) : (
            <div className="space-y-4">
              {/* Editor toolbar */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-fg-faint">
                    {draft.slug}
                  </span>
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
                    className="w-full bg-bg border border-line rounded px-3 py-1.5 text-sm text-fg focus:outline-none focus:border-accent disabled:opacity-60"
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
                <Field label="Default plan (optional — pre-fills the Orchestrator plan box)">
                  <textarea
                    value={draft.defaultPlan ?? ''}
                    onChange={(e) => patchDraft({ defaultPlan: e.target.value })}
                    readOnly={!canEdit}
                    rows={2}
                    className="w-full bg-bg border border-line rounded px-3 py-1.5 text-xs text-fg focus:outline-none focus:border-accent resize-none font-mono"
                  />
                </Field>
              </div>

              {/* Roles */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] uppercase tracking-wider text-fg-faint">
                    Roles — one prompt per subagent
                  </label>
                  <span className="text-[10px] text-fg-faint">
                    {draft.roles.length} role{draft.roles.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="space-y-2">
                  {draft.roles.map((role, i) => (
                    <div
                      key={i}
                      className="border border-line rounded p-2 bg-bg space-y-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-accent font-mono shrink-0">
                          R{i + 1}
                        </span>
                        <input
                          type="text"
                          value={role.label}
                          onChange={(e) => patchRole(i, { label: e.target.value })}
                          readOnly={!canEdit}
                          placeholder="Role label"
                          className="flex-1 bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg focus:outline-none focus:border-accent"
                        />
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => removeRole(i)}
                            aria-label={`Remove ${role.label || `role ${i + 1}`}`}
                            className="text-fg-faint hover:text-red-400 px-1.5 py-0.5 text-sm"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                      <textarea
                        value={role.prompt}
                        onChange={(e) => patchRole(i, { prompt: e.target.value })}
                        readOnly={!canEdit}
                        rows={4}
                        placeholder="What this subagent should do…"
                        className="w-full bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent resize-none font-mono"
                      />
                    </div>
                  ))}
                  {canEdit && (
                    <Button variant="default" onClick={addRole}>+ Add role</Button>
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
              Delete hive <span className="font-mono text-accent">{confirmDelete}</span>?
              This cannot be undone.
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="default" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleDelete}>
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-fg-faint mb-1 block">
        {label}
      </label>
      {children}
    </div>
  )
}
