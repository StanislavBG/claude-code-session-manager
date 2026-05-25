/**
 * TweakModal — pre-edit a prompt before sending it to the active terminal.
 *
 * Send modes:
 *   paste     — writes the text as-is (no trailing \n). User reviews on the
 *               prompt line and hits Enter themselves.
 *   auto-fire — appends \n so Claude submits immediately.
 *
 * If no activeTabId is available the Send button is disabled.
 */

import { useState } from 'react'
import { Modal } from '../../ui/Modal'
import type { Prompt, SendMode } from '../../../lib/promptFrontmatter'
import { toast } from '../../../state/toast'

interface TweakModalProps {
  prompt: Prompt
  open: boolean
  activeTabId: string | null
  onClose: () => void
}

export function TweakModal({ prompt, open, activeTabId, onClose }: TweakModalProps) {
  const [draft, setDraft] = useState(prompt.body)
  const [sendMode, setSendMode] = useState<SendMode>(prompt.sendMode)

  // Reset local state whenever the parent swaps the prompt.
  // (using key on the modal caller is cleaner, but this works too)
  const [lastId, setLastId] = useState(prompt.id)
  if (prompt.id !== lastId) {
    setLastId(prompt.id)
    setDraft(prompt.body)
    setSendMode(prompt.sendMode)
  }

  function handleSend() {
    if (!activeTabId) return
    const data = sendMode === 'auto-fire' ? draft + '\n' : draft
    window.api.pty.write({ tabId: activeTabId, data })
    onClose()
    toast.info(`Sent to terminal (${sendMode})`)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Tweak: ${prompt.title}`}
      size="lg"
    >
      {/* Body textarea */}
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={12}
        className="w-full bg-bg border border-line rounded px-3 py-2 text-xs font-mono text-fg resize-y focus:outline-none focus:border-accent/60"
        aria-label="Prompt body"
      />

      {/* Send-mode radio */}
      <div className="mt-3 flex items-center gap-4 text-xs text-fg-dim">
        <span className="font-medium text-fg">Send mode:</span>
        {(['paste', 'auto-fire'] as SendMode[]).map((m) => (
          <label key={m} className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="radio"
              name="sendMode"
              value={m}
              checked={sendMode === m}
              onChange={() => setSendMode(m)}
              className="accent-accent"
            />
            <span className={sendMode === m ? 'text-fg' : ''}>{m}</span>
          </label>
        ))}
        {sendMode === 'paste' && (
          <span className="text-fg-faint italic">— you hit Enter to submit</span>
        )}
        {sendMode === 'auto-fire' && (
          <span className="text-fg-faint italic">— submits immediately</span>
        )}
      </div>

      {/* Footer */}
      <div className="mt-4 flex items-center justify-end gap-3">
        <button
          onClick={onClose}
          className="text-xs text-fg-dim hover:text-fg transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSend}
          disabled={!activeTabId}
          title={activeTabId ? undefined : 'Open a terminal session first'}
          className="px-4 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Send to terminal
        </button>
      </div>
    </Modal>
  )
}
