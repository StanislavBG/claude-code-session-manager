/**
 * MacroEditor — inline create/edit card for one hot-key Macro (label, agent,
 * tag, initial prompt). Rendered below the strip buttons in the narrow sidebar
 * rail, so every field stacks vertically. Saves through `window.api.macros`.
 */
import { useEffect, useState } from 'react'
import type { AgentPersona, Macro } from '../../../preload/api'
import { toast } from '../../state/toast'
import { missionTagsForAgent } from '../../lib/missionTags'
import { tagLibraryEntry } from '../../lib/tagLibrary'
import { AgentPicker } from './AgentPicker'

export const MACRO_LABEL_MAX = 60
export const MACRO_PROMPT_MAX = 8000

const FIELD =
  'w-full rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent'
const LABEL = 'font-mono text-[10px] font-semibold tracking-[1px] uppercase text-fg-faint'

export interface MacroEditorProps {
  /** Active project cwd — the default (and only) project for a new macro. */
  cwd: string
  agents: AgentPersona[]
  /** Set = edit mode (prefilled, keeps `projects` unless the checkbox changes). */
  macro?: Macro | null
  /** Live library copy of `macro` (by id). Save takes `projects` from it so a
   *  manage-panel toggle made while the editor is open isn't reverted. */
  latest?: Macro | null
  onClose: () => void
}

export function MacroEditor({ cwd, agents, macro, latest, onClose }: MacroEditorProps) {
  const [label, setLabel] = useState(macro?.label ?? '')
  const [agentName, setAgentName] = useState(macro?.agentName ?? agents[0]?.name ?? '')
  const [tag, setTag] = useState<string>(macro?.tag ?? '')
  const [prompt, setPrompt] = useState(macro?.prompt ?? '')
  const initialEverywhere = macro ? macro.projects.includes('*') : false
  const [everywhere, setEverywhere] = useState(initialEverywhere)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Agents load asynchronously — adopt the first once they arrive.
  useEffect(() => {
    if (!agentName && agents[0]) setAgentName(agents[0].name)
  }, [agents, agentName])

  const agent = agents.find((a) => a.name === agentName) ?? null
  // Empty list = still loading (or no personas); never judge the agent missing then.
  const agentMissing = agents.length > 0 && agentName !== '' && !agent
  let tags: string[] = missionTagsForAgent(agent)
  // Unknown/not-yet-loaded agent: keep the macro's own tag selectable so it is never lost.
  if (!agent && tag && !tags.includes(tag)) tags = [tag, ...tags]
  const activeTag = tag && tags.includes(tag) ? tag : tags[0]

  // Snap only on an explicit user agent change (never on load / missing agent).
  const changeAgent = (name: string) => {
    setAgentName(name)
    const allowed: string[] = missionTagsForAgent(agents.find((a) => a.name === name) ?? null)
    if (!allowed.includes(activeTag)) setTag(allowed[0])
  }

  useEffect(() => {
    const esc = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])

  const trimmedLabel = label.trim()
  const trimmedPrompt = prompt.trim()
  const valid = trimmedLabel.length > 0 && trimmedPrompt.length > 0 && agentName !== ''

  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    try {
      let projects: string[]
      const base = latest ?? macro
      if (!base) projects = everywhere ? ['*'] : [cwd]
      else if (everywhere === initialEverywhere) projects = base.projects
      else if (everywhere) projects = ['*']
      else projects = base.projects.includes('*') ? [cwd] : base.projects
      await window.api.macros.save({
        ...(macro ? { id: macro.id } : {}),
        label: trimmedLabel,
        agentName,
        tag: activeTag as Macro['tag'],
        prompt: trimmedPrompt,
        projects,
      })
      toast.info(macro ? `Macro "${trimmedLabel}" updated` : `Macro "${trimmedLabel}" saved`)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      data-testid="macro-editor"
      className="flex flex-col gap-2 rounded-lg border border-line bg-bg-hi p-2.5"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="flex flex-col gap-1">
        <label className={LABEL} htmlFor="macro-label">Label</label>
        <input
          id="macro-label"
          data-testid="macro-label"
          className={FIELD}
          value={label}
          maxLength={MACRO_LABEL_MAX}
          placeholder="e.g. Sweep"
          onChange={(e) => setLabel(e.target.value)}
          autoFocus
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className={LABEL}>Agent</span>
        <AgentPicker agents={agents} value={agentName} onChange={changeAgent} />
        {agentMissing && (
          <div role="alert" data-testid="macro-agent-missing" className="text-[11.5px] text-amber-500">
            agent {agentName} not found
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className={LABEL}>Tag</span>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Tag">
          {tags.map((t) => (
            <button
              key={t}
              type="button"
              data-testid="macro-tag"
              data-tag={t}
              aria-pressed={t === activeTag}
              onClick={() => setTag(t)}
              className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                t === activeTag ? 'bg-accent text-white border-transparent' : 'bg-bg text-fg-dim border-line hover:text-fg'
              }`}
            >
              {tagLibraryEntry(t as never).label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className={LABEL} htmlFor="macro-prompt">Initial prompt</label>
        <textarea
          id="macro-prompt"
          data-testid="macro-prompt"
          className={`${FIELD} min-h-[88px] resize-y`}
          value={prompt}
          maxLength={MACRO_PROMPT_MAX}
          placeholder="What should the new session do first?"
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>

      <label className="flex items-center gap-1.5 text-[11.5px] text-fg-dim">
        <input
          type="checkbox"
          data-testid="macro-everywhere"
          checked={everywhere}
          onChange={(e) => setEverywhere(e.target.checked)}
        />
        Show in every project
      </label>

      {error && (
        <div role="alert" data-testid="macro-error" className="text-[11.5px] text-red-500">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          data-testid="macro-cancel"
          onClick={onClose}
          className="rounded-md border border-line bg-bg px-2.5 py-1 text-[11.5px] font-semibold text-fg-dim hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="submit"
          data-testid="macro-save"
          disabled={!valid || saving}
          className="rounded-md border border-transparent bg-accent px-2.5 py-1 text-[11.5px] font-semibold text-white shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}
