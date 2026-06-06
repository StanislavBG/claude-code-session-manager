import { useEffect, useState } from 'react'
import { Modal } from '../../ui/Modal'
import { Badge } from '../../ui/Badge'
import type { BadgeTone } from '../../ui/Badge'
import { toast } from '../../../state/toast'
import { parseRunLog } from '../../../lib/runLog'
import type { ParsedRunLog } from '../../../lib/runLog'

interface RunLogViewerProps {
  runId: string
  slug: string
  title: string
  onClose: () => void
}

type ViewMode = 'parsed' | 'raw'

const EVENT_TYPE_TONE: Record<string, BadgeTone> = {
  assistant: 'accent',
  user: 'default',
  system: 'dim',
  result: 'warn',
  tool_use: 'default',
  tool_result: 'default',
  raw: 'dim',
}

function eventTone(type: string): BadgeTone {
  return EVENT_TYPE_TONE[type] ?? 'default'
}

export function RunLogViewer({ runId, slug, title, onClose }: RunLogViewerProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rawText, setRawText] = useState<string>('')
  const [parsed, setParsed] = useState<ParsedRunLog | null>(null)
  const [mode, setMode] = useState<ViewMode>('parsed')

  useEffect(() => {
    setLoading(true)
    setError(null)
    window.api.schedule.readLog(runId, slug).then((r) => {
      if (!r.ok) {
        const msg = r.error ?? 'Failed to read log'
        setError(msg)
        toast.error(`Log read failed: ${msg}`)
      } else {
        const text = r.text ?? ''
        setRawText(text)
        setParsed(parseRunLog(text))
      }
    }).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      toast.error(`Log read failed: ${msg}`)
    }).finally(() => setLoading(false))
  }, [runId, slug])

  return (
    <Modal open onClose={onClose} size="xl" fillHeight noPadding title={title}>
      <div className="flex flex-col h-full min-h-0">
        {/* Toolbar */}
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-line">
          <button
            type="button"
            onClick={() => setMode('parsed')}
            className={`text-[10px] px-2 py-0.5 rounded border ${mode === 'parsed' ? 'bg-accent/20 text-accent border-accent/40' : 'text-fg-faint border-line hover:text-fg-dim hover:border-fg-faint'}`}
          >
            Parsed
          </button>
          <button
            type="button"
            onClick={() => setMode('raw')}
            className={`text-[10px] px-2 py-0.5 rounded border ${mode === 'raw' ? 'bg-accent/20 text-accent border-accent/40' : 'text-fg-faint border-line hover:text-fg-dim hover:border-fg-faint'}`}
          >
            Raw
          </button>
          <span className="ml-auto text-[10px] text-fg-faint font-mono">{slug} · {runId.slice(0, 8)}</span>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-faint hover:text-fg-dim text-sm leading-none ml-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {loading && (
            <div className="flex-1 flex items-center justify-center text-[11px] text-fg-faint">
              Loading log…
            </div>
          )}
          {!loading && error && (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-[11px] text-red-300 px-6 text-center max-w-md">
                {error}
              </div>
            </div>
          )}
          {!loading && !error && mode === 'raw' && (
            <pre className="flex-1 overflow-auto p-4 text-[10px] font-mono text-fg-dim whitespace-pre-wrap break-all leading-relaxed">
              {rawText || <span className="text-fg-faint italic">log is empty</span>}
            </pre>
          )}
          {!loading && !error && mode === 'parsed' && parsed && (
            <ParsedView parsed={parsed} onSwitchRaw={() => setMode('raw')} />
          )}
        </div>
      </div>
    </Modal>
  )
}

function ParsedView({ parsed, onSwitchRaw }: { parsed: ParsedRunLog; onSwitchRaw: () => void }) {
  const { events, errors, rawLineCount, truncated } = parsed

  if (events.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[11px] text-fg-faint italic">
        log is empty
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Error summary band */}
      <div className={`shrink-0 px-4 py-2 border-b border-line text-[11px] ${errors.count > 0 ? 'bg-red-950/20' : 'bg-bg-elev/50'}`}>
        {errors.count > 0 ? (
          <span className="text-red-300">
            <span className="font-medium">{errors.count} error{errors.count === 1 ? '' : 's'} detected</span>
            {errors.firstMessage && (
              <span className="text-red-300/70 ml-2 font-mono">{errors.firstMessage.slice(0, 120)}</span>
            )}
          </span>
        ) : (
          <span className="text-green-400/70">no errors detected</span>
        )}
      </div>

      {/* Truncation notice */}
      {truncated && (
        <div className="shrink-0 px-4 py-1.5 border-b border-line bg-yellow-950/20 text-[10px] text-yellow-400/80">
          showing first {events.length} of {rawLineCount} events —{' '}
          <button type="button" onClick={onSwitchRaw} className="underline hover:text-yellow-300">
            open Raw for full
          </button>
        </div>
      )}

      {/* Event timeline */}
      <div className="flex-1 overflow-y-auto">
        {events.map((ev, i) => (
          <EventRow key={i} event={ev} />
        ))}
      </div>
    </div>
  )
}

function EventRow({ event }: { event: { type: string; preview: string; isError: boolean; raw: string } }) {
  const [expanded, setExpanded] = useState(false)
  const isRaw = event.type === 'raw'

  return (
    <div
      className={`flex items-start gap-2 px-3 py-1 border-b border-line/30 cursor-pointer hover:bg-bg-hi ${event.isError ? 'bg-red-950/10' : ''}`}
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="shrink-0 pt-0.5 w-16">
        {isRaw ? (
          <span className="text-[9px] text-fg-faint/50 font-mono">raw</span>
        ) : (
          <Badge tone={eventTone(event.type)} className="text-[9px]">{event.type}</Badge>
        )}
      </div>
      <div className="flex-1 min-w-0">
        {expanded ? (
          <pre className="text-[10px] font-mono text-fg-dim whitespace-pre-wrap break-all">{event.raw}</pre>
        ) : (
          <span className={`text-[10px] truncate block ${isRaw ? 'text-fg-faint/60 font-mono' : 'text-fg-dim'}`}>
            {event.preview || <span className="italic text-fg-faint/40">(empty)</span>}
          </span>
        )}
      </div>
    </div>
  )
}
