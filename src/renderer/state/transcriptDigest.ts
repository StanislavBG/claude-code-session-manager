import type { TranscriptEvent } from '../../preload/api'

/**
 * Shared transcript→digest logic for the dispatch stores (orchestrator.ts,
 * race.ts). Both fan a prompt out to N existing tabs and want the same
 * readable one-line snippet per transcript event, and the same "has this
 * tab produced a final assistant turn yet" done-detector. Previously each
 * store carried its own verbatim copy; consolidated here so a fix to one
 * (e.g. a new event kind) reaches both.
 */

const DIGEST_LINE_MAX = 200

/** Pull a readable snippet out of a transcript event for a run-grid panel preview. */
export function digestFor(ev: TranscriptEvent): string | null {
  if (ev.kind === 'tool_use') {
    const d = ev.data as { name?: string; input?: unknown } | null
    if (!d?.name) return null
    const input = d.input as Record<string, unknown> | null | undefined
    const filePath = typeof input?.file_path === 'string' ? input.file_path : undefined
    const command = typeof input?.command === 'string' ? input.command : undefined
    const detail = filePath ? filePath.split('/').pop() ?? filePath : command ?? ''
    return detail ? `${d.name} · ${detail}` : d.name
  }
  if (ev.kind === 'todo_write') {
    const arr = Array.isArray(ev.data) ? (ev.data as { content?: string }[]) : []
    return `Todos · ${arr.length} item${arr.length !== 1 ? 's' : ''}`
  }
  if (ev.kind === 'plan') {
    return 'Plan revised'
  }
  if (ev.kind === 'agent_spawn') {
    const d = ev.data as { subagent_type?: string } | null
    return d?.subagent_type ? `Agent: ${d.subagent_type}` : 'Agent spawned'
  }
  if (ev.kind === 'assistant') {
    const raw = ev.raw as { message?: { content?: unknown } } | null
    const content = raw?.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
          const text = (block as { text?: string }).text
          if (typeof text === 'string') return text.slice(0, DIGEST_LINE_MAX)
        }
      }
    }
    return 'assistant: (response)'
  }
  return null
}

/** "Done" detector: an assistant message arriving after a task/participant is in flight. */
export function isDoneSignal(ev: TranscriptEvent): boolean {
  return ev.kind === 'assistant'
}
