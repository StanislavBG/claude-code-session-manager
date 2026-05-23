import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Tooltip } from '../ui/Tooltip'
import { useSessions } from '../../state/sessions'
import { useSuperAgent, type SuperAgentDepth } from '../../state/superagent'
import { toast } from '../../state/toast'

/**
 * SuperAgent modal — configure + launch a "boss" run on the active tab.
 *
 * Port of ClaudeCodeUnleashed's SuperAgentModal, simplified for our MVP:
 *   - We don't pick LLM provider (boss is Claude itself, no Groq/OpenAI key).
 *   - No takeover mode, no safety levels, no time limit knob.
 *   - Two inputs: prompt + specialist count (1..8) + depth (quick/standard/deep).
 *   - Cmd/Ctrl+Enter submits.
 *
 * Lifecycle:
 *   - Form resets every time the modal opens.
 *   - Start writes the structured prompt to the active tab's PTY via main and
 *     transitions the per-tab run state. The status bar (mounted at the App
 *     level) takes over once the run is `running`.
 */
const DEPTHS: { value: SuperAgentDepth; label: string; help: string }[] = [
  { value: 'quick', label: 'Quick', help: 'One-shot specialist work, surface-level.' },
  { value: 'standard', label: 'Standard', help: 'Moderate detail, one or two iterations.' },
  { value: 'deep', label: 'Deep', help: 'Multi-step plans per specialist, recurse on findings.' },
]

export function SuperAgentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = useSessions((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null)
  const sessionRunning = activeTab?.status === 'running'

  const run = useSuperAgent((s) => (activeTabId ? s.tabs[activeTabId]?.run : null))
  const alreadyRunning = run?.status === 'running'

  const [prompt, setPrompt] = useState('')
  const [specialistCount, setSpecialistCount] = useState(3)
  const [depth, setDepth] = useState<SuperAgentDepth>('standard')
  const [starting, setStarting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  // Reset form fields when modal opens fresh.
  useEffect(() => {
    if (!open) return
    setPrompt('')
    setSpecialistCount(3)
    setDepth('standard')
    setLocalError(null)
    setStarting(false)
  }, [open])

  const startDisabled = useMemo(() => {
    return starting || !prompt.trim() || !activeTabId || !sessionRunning
  }, [starting, prompt, activeTabId, sessionRunning])

  const handleStart = async () => {
    setLocalError(null)
    if (!activeTabId) {
      setLocalError('No active session — start a terminal tab first.')
      return
    }
    if (!sessionRunning) {
      setLocalError('Active session is not running. Restart it or pick another tab.')
      return
    }
    if (!prompt.trim()) {
      setLocalError('Tell Claude what to do.')
      return
    }
    setStarting(true)
    try {
      const res = await window.api.superagent.start({
        tabId: activeTabId,
        prompt: prompt.trim(),
        specialistCount,
        depth,
      })
      if (!res.ok) {
        setLocalError(res.error ?? 'Failed to start.')
        setStarting(false)
        return
      }
      toast.info(`SuperAgent launched — ${specialistCount} specialist(s), ${depth} depth.`)
      onClose()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setLocalError(msg)
      setStarting(false)
    }
  }

  const handleStop = async () => {
    if (!activeTabId) return
    try {
      await window.api.superagent.stop(activeTabId)
      toast.info('SuperAgent stopped.')
    } catch (e: unknown) {
      toast.error(`Stop failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <Modal open={open} onClose={onClose} size="lg" title="SuperAgent">
      <div className="space-y-4">
        <div className="text-xs text-fg-dim leading-relaxed">
          Pick a task and SuperAgent will instruct Claude to act as a "boss" — choosing specialist
          subagents, dispatching them via the Task tool, and reporting progress back to the terminal.
          The run executes inside the <span className="text-fg">active tab</span>{activeTab ? ` (${activeTab.label})` : ''}.
        </div>

        {alreadyRunning && (
          <div className="px-3 py-2 rounded border border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-300">
            A SuperAgent run is already in progress on this tab. Starting a new one will replace it
            (Claude may still be working in the terminal — stop or Ctrl-C there if needed).
          </div>
        )}

        <div>
          <label className="block text-[10px] uppercase tracking-wider text-fg-faint mb-1">
            Task
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, 4000))}
            placeholder="What should Claude build, fix, or investigate?"
            rows={4}
            autoFocus
            data-testid="superagent-prompt"
            className="w-full bg-bg border border-line rounded px-3 py-2 text-fg placeholder-fg-faint focus:outline-none focus:border-accent text-xs resize-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                if (!startDisabled) void handleStart()
              }
            }}
          />
        </div>

        <div className="flex items-end gap-6">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-fg-faint mb-1">
              Specialists
            </label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={1}
                max={8}
                value={specialistCount}
                onChange={(e) => setSpecialistCount(parseInt(e.target.value, 10))}
                className="w-28"
                aria-label="Specialist count"
                data-testid="superagent-specialists"
              />
              <span className="font-mono text-xs text-fg w-4 text-right">{specialistCount}</span>
            </div>
          </div>

          <div className="flex-1">
            <label className="block text-[10px] uppercase tracking-wider text-fg-faint mb-1">
              Depth
            </label>
            <div className="flex gap-1">
              {DEPTHS.map((d) => (
                <Tooltip key={d.value} content={d.help}>
                  <button
                    type="button"
                    onClick={() => setDepth(d.value)}
                    className={`flex-1 py-1.5 px-2 text-xs rounded border transition-colors ${
                      depth === d.value
                        ? 'bg-bg-hi text-fg border-accent'
                        : 'text-fg-dim border-line hover:text-fg hover:bg-bg-hi/60'
                    }`}
                    data-testid={`superagent-depth-${d.value}`}
                  >
                    {d.label}
                  </button>
                </Tooltip>
              ))}
            </div>
          </div>
        </div>

        {localError && (
          <div
            className="px-3 py-2 rounded border border-red-500/40 bg-red-500/10 text-[11px] text-red-300"
            data-testid="superagent-error"
          >
            {localError}
          </div>
        )}

        {!sessionRunning && (
          <div className="text-[11px] text-fg-faint">
            ⚠ Active session is not running. SuperAgent needs a live PTY to write to.
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-line">
          <div className="text-[10px] text-fg-faint">
            <kbd className="px-1 py-0.5 rounded border border-line bg-bg font-mono">⌘/Ctrl</kbd> +{' '}
            <kbd className="px-1 py-0.5 rounded border border-line bg-bg font-mono">Enter</kbd> to launch
          </div>
          <div className="flex items-center gap-2">
            {alreadyRunning && (
              <Button onClick={handleStop} variant="danger">
                Stop current run
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button
              onClick={handleStart}
              disabled={startDisabled}
              variant="primary"
            >
              {starting ? 'Launching…' : 'Start'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
