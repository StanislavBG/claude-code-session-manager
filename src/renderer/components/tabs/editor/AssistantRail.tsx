/**
 * AssistantRail — collapsible ~300px pane on the right of the Editor's
 * markdown preview/split area that mirrors the whole useDocEdit lifecycle
 * (Document Experience). A pane in the modular-pane sense: it owns no global
 * state, receives the hook's state + actions via props from EditorView, and
 * renders a read-mostly mirror of it alongside the inline SelectionPopover.
 */

import { prettyModel } from '../../../lib/prettyModel'
import { DOCEDIT_MODEL, type DocEditPhase } from './useDocEdit'

interface Props {
  phase: DocEditPhase
  transcript: string
  diff: { before: string; after: string } | null
  editCount: number
  onListen: () => void
  onSendHeard: () => void
  onCancel: () => void
  onAccept: () => void
  onReject: () => void
  onRetry: () => void
}

function PulsingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      <span className="w-1 h-1 rounded-full bg-red-400 animate-pulse [animation-delay:0ms]" />
      <span className="w-1 h-1 rounded-full bg-red-400 animate-pulse [animation-delay:150ms]" />
      <span className="w-1 h-1 rounded-full bg-red-400 animate-pulse [animation-delay:300ms]" />
    </span>
  )
}

export function AssistantRail({ phase, transcript, diff, editCount, onListen, onSendHeard, onCancel, onAccept, onReject, onRetry }: Props) {
  return (
    <div
      data-testid="assistant-rail"
      className="w-[300px] shrink-0 border-l border-line bg-bg-elev flex flex-col text-xs"
    >
      <div className="flex items-center justify-between px-3 h-8 border-b border-line shrink-0">
        <span className="font-medium text-fg">Assistant</span>
        <span className="text-[10px] text-fg-faint" title="Model used for Document Experience edits">
          {prettyModel(DOCEDIT_MODEL)}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3">
        {phase === 'idle' && (
          <div className="text-fg-faint">
            <p>Select text in the doc…</p>
            <p className="mt-2 text-[10px]">{editCount} edit{editCount === 1 ? '' : 's'} this session</p>
          </div>
        )}

        {phase === 'popover' && (
          <p className="text-fg-faint">Choose a quick action or speak an instruction from the popover.</p>
        )}

        {phase === 'listening' && (
          <div>
            <p className="flex items-center gap-2 text-fg-dim mb-3">
              <PulsingDots />
              Listening…
            </p>
            <button onClick={onCancel} className="px-2 py-0.5 text-[11px] text-fg-faint hover:text-fg border border-line rounded">
              Cancel
            </button>
          </div>
        )}

        {phase === 'review' && (
          <div>
            <p className="italic text-fg mb-3">«{transcript}»</p>
            <div className="flex gap-1.5">
              <button onClick={onCancel} className="px-2 py-1 text-[11px] text-fg-faint hover:text-fg border border-line rounded">
                Cancel
              </button>
              <button onClick={onListen} className="px-2 py-1 text-[11px] text-fg-dim hover:text-fg border border-line rounded">
                Re-record
              </button>
              <button onClick={onSendHeard} className="px-2 py-1 text-[11px] text-white rounded bg-accent hover:opacity-90">
                Send
              </button>
            </div>
          </div>
        )}

        {phase === 'thinking' && (
          <p className="text-fg-dim animate-pulse">Claude is editing…</p>
        )}

        {phase === 'diff' && diff && (
          <div>
            <div className="mb-3 space-y-2">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-fg-faint mb-1">Before</div>
                <div className="text-red-400 line-through whitespace-pre-wrap">{diff.before}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-fg-faint mb-1">After</div>
                <div className="text-green-400 whitespace-pre-wrap">{diff.after}</div>
              </div>
            </div>
            <div className="flex gap-1.5">
              <button onClick={onReject} className="px-2 py-1 text-[11px] text-fg-faint hover:text-fg border border-line rounded">
                Reject
              </button>
              <button onClick={onRetry} className="px-2 py-1 text-[11px] text-fg-dim hover:text-fg border border-line rounded">
                Retry
              </button>
              <button onClick={onAccept} className="px-2 py-1 text-[11px] text-white rounded bg-green-600 hover:bg-green-500">
                Accept
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
