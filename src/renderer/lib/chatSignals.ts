/**
 * Bounded per-event "signal" summaries for JSONL transcript-feed turns
 * (PRD chat-typed-event-renderers). chat.ts's ingestTranscriptEvent calls
 * summarizeSignal(kind, data, raw) at ingest time — while the FULL event
 * payload is still in hand from IPC — and stores only this small structured
 * summary on the turn. The store deliberately never keeps the full data body
 * (a tool_use input or deferred-tools listing can be hundreds of KB; holding
 * it per-turn is the exact memory cliff the classifier's `ref` design
 * exists to avoid). Expanding a card re-reads the full untruncated line from
 * disk via the turn's ref (window.api.transcripts.readRef).
 *
 * Pure functions only — no store access, no IO — so both chat.ts and the
 * renderer tests consume the same single implementation.
 */

/** Cap on any single bounded text field kept in a signal summary. Big enough
 *  for a meaningful inline body (an MCP instructions block, a queued command),
 *  small enough that 1000 turns of signals stay trivially cheap. */
export const SIGNAL_TEXT_MAX = 2000

/** Cap on name lists (tools/skills/agents). The largest observed real list is
 *  ~110 deferred tool names; 300 leaves headroom without being unbounded. */
export const SIGNAL_NAMES_MAX = 300

export interface ChatSignal {
  /** Attachment subtype ('deferred_tools_delta', …); undefined for non-attachment kinds. */
  subtype?: string
  /** Small scalar value: mode name, queue-operation verb, snapshot id, … */
  value?: string
  /** Bounded primary text (queued command, thinking text, title, markdown body, …). */
  text?: string
  /** True when `text` was truncated at ingest — the full payload is on disk via the turn's ref. */
  textTruncated?: boolean
  /** Bounded added-name list (tools / skills / agents / MCP servers). */
  names?: string[]
  removedNames?: string[]
  /** True counts BEFORE capping — chips stay truthful even when lists are capped. */
  count?: number
  removedCount?: number
  filePath?: string
  /** tool_result only: whether the result carried is_error. */
  isError?: boolean
  /** Edit-style tool_result / edited_text_file: payload for the existing DiffCard. */
  diff?: { filePath: string; oldText?: string; newText?: string }
  /** Tool-family events (tool_use/todo_write/plan/agent_spawn): chip trace data. */
  tool?: { kind: 'skill' | 'mcp' | 'tool'; label: string }
}

function capText(s: unknown): { text?: string; textTruncated?: boolean } {
  if (typeof s !== 'string' || s.length === 0) return {}
  if (s.length <= SIGNAL_TEXT_MAX) return { text: s }
  return { text: s.slice(0, SIGNAL_TEXT_MAX) + '…', textTruncated: true }
}

function capNames(v: unknown): { names?: string[]; count?: number } {
  if (!Array.isArray(v) || v.length === 0) return {}
  const names = v.filter((n): n is string => typeof n === 'string').slice(0, SIGNAL_NAMES_MAX)
  return { names, count: v.length }
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** Tool name → the same kind/label scheme ToolUseTraceStrip's chips use
 *  (TOOL_USE_TONE/TOOL_USE_ICON key off this `kind`). */
export function toolTraceFor(name: string): { kind: 'skill' | 'mcp' | 'tool'; label: string } {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    return { kind: 'mcp', label: parts[parts.length - 1] || name }
  }
  if (name === 'Skill') return { kind: 'skill', label: 'Skill' }
  return { kind: 'tool', label: name }
}

/** First non-empty line of a tool result body — the chip's glance text. */
function firstLine(s: string): string {
  for (const line of s.split('\n')) {
    const t = line.trim()
    if (t) return t.length > 200 ? t.slice(0, 200) + '…' : t
  }
  return ''
}

/** Extract a human-scannable result body from a tool_result line's raw
 *  projection (message.content tool_result blocks and/or toolUseResult). */
function extractToolResultText(raw: Record<string, unknown>): { body: string; isError: boolean } {
  let body = ''
  let isError = false
  const msg = asObj(raw.message)
  const content = msg?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = asObj(block)
      if (!b || b.type !== 'tool_result') continue
      if (b.is_error === true) isError = true
      if (typeof b.content === 'string') body = body ? body + '\n' + b.content : b.content
      else if (Array.isArray(b.content)) {
        for (const inner of b.content) {
          const ib = asObj(inner)
          if (ib && typeof ib.text === 'string') body = body ? body + '\n' + ib.text : ib.text
        }
      }
    }
  }
  if (!body) {
    const tur = raw.toolUseResult
    if (typeof tur === 'string') body = tur
    else if (asObj(tur)) {
      const o = asObj(tur)!
      body = str(o.stdout) ?? str(o.stderr) ?? str(o.content) ?? ''
    }
  }
  return { body, isError }
}

/** Edit-style toolUseResult → DiffCard payload, when the line carries one. */
function extractToolResultDiff(
  raw: Record<string, unknown>,
): { filePath: string; oldText?: string; newText?: string } | undefined {
  const tur = asObj(raw.toolUseResult)
  if (!tur) return undefined
  const filePath = str(tur.filePath) ?? str(tur.file_path)
  const oldText = str(tur.oldString) ?? str(tur.oldText)
  const newText = str(tur.newString) ?? str(tur.newText)
  if (!filePath || (oldText === undefined && newText === undefined)) return undefined
  const cap = (s: string | undefined) => (s !== undefined && s.length > 4096 ? s.slice(0, 4096) + '…' : s)
  return { filePath, oldText: cap(oldText), newText: cap(newText) }
}

/**
 * Compute the bounded signal summary for one transcript event. Returns
 * undefined for kinds that need nothing beyond previewText (the generic
 * Signal card renders those from the turn's own text/ref). NEVER throws on
 * malformed payloads — a null/empty/garbage line yields a minimal (or no)
 * summary and the renderer shows an explicit empty state instead of blanking.
 */
export function summarizeSignal(kind: string, data: unknown, raw: unknown): ChatSignal | undefined {
  const obj = asObj(data)
  const rawObj = asObj(raw) ?? {}
  switch (kind) {
    case 'mode':
      return { value: str(obj?.mode) }
    case 'permissionMode':
      return { value: str(obj?.permissionMode) ?? str(obj?.mode) ?? str(obj?.value) }
    case 'queue-operation':
      return { value: str(obj?.operation), ...capText(obj?.content) }
    case 'ai-title':
      return { ...capText(obj?.aiTitle) }
    case 'last-prompt':
      return { ...capText(obj?.lastPrompt) }
    case 'file-history-snapshot': {
      const snap = asObj(obj?.snapshot)
      const tracked = asObj(snap?.trackedFileBackups)
      return { value: str(obj?.messageId), count: tracked ? Object.keys(tracked).length : 0 }
    }
    case 'attachment': {
      const att = asObj(obj?.attachment)
      const subtype = str(att?.type)
      if (!att || !subtype) return {}
      switch (subtype) {
        case 'deferred_tools_delta':
          return {
            subtype,
            ...capNames(att.addedNames),
            removedNames: capNames(att.removedNames).names,
            removedCount: capNames(att.removedNames).count,
          }
        case 'mcp_instructions_delta': {
          const blocks = Array.isArray(att.addedBlocks)
            ? att.addedBlocks.filter((b): b is string => typeof b === 'string').join('\n\n')
            : ''
          return { subtype, ...capNames(att.addedNames), removedNames: capNames(att.removedNames).names, ...capText(blocks) }
        }
        case 'skill_listing': {
          const content = str(att.content) ?? ''
          // "- name: description" lines → name list for the count chip/grid.
          const names = content
            .split('\n')
            .map((l) => /^-\s*([^:]+):/.exec(l)?.[1]?.trim())
            .filter((n): n is string => !!n)
          return { subtype, ...capNames(names), ...capText(content) }
        }
        case 'agent_listing_delta':
          return { subtype, ...capNames(att.addedTypes) }
        case 'task_reminder': {
          const n = typeof att.itemCount === 'number' ? att.itemCount : Array.isArray(att.content) ? att.content.length : 0
          const body = typeof att.content === 'string' ? att.content : ''
          return { subtype, count: n, ...capText(body) }
        }
        case 'command_permissions':
          return { subtype, ...capNames(att.allowedTools) }
        case 'edited_text_file': {
          const filePath = str(att.filename)
          const snippet = str(att.snippet)
          return {
            subtype,
            filePath,
            diff: filePath ? { filePath, newText: snippet !== undefined && snippet.length > 4096 ? snippet.slice(0, 4096) + '…' : snippet } : undefined,
          }
        }
        case 'queued_command':
          return { subtype, value: str(att.commandMode) ?? 'queued', ...capText(att.prompt) }
        default:
          // Unknown attachment subtype → generic Signal card; keep the subtype
          // so the card header names it.
          return { subtype }
      }
    }
    case 'content_thinking': {
      const thinking = str(obj?.thinking) ?? str(obj?.text)
      return { ...capText(thinking) }
    }
    case 'tool_result': {
      const { body, isError } = extractToolResultText(rawObj)
      return { value: firstLine(body), isError, diff: extractToolResultDiff(rawObj) }
    }
    case 'tool_use': {
      const name = str(obj?.name) ?? 'tool'
      return { tool: toolTraceFor(name) }
    }
    case 'todo_write':
      return { tool: { kind: 'tool', label: 'TodoWrite' } }
    case 'plan':
      return { tool: { kind: 'tool', label: 'Plan' } }
    case 'agent_spawn':
      return { tool: { kind: 'tool', label: str(obj?.subagent_type) ? `Agent · ${str(obj?.subagent_type)}` : 'Agent' } }
    case 'usage': {
      const input = typeof obj?.input_tokens === 'number' ? obj.input_tokens : 0
      const output = typeof obj?.output_tokens === 'number' ? obj.output_tokens : 0
      return { text: `${input} in · ${output} out` }
    }
    default:
      return undefined
  }
}

/**
 * Given the FULL untruncated JSONL line text (re-read from disk via the
 * turn's ref), extract the same primary text field the bounded summary came
 * from — so "expand" shows the real uncapped payload, not a re-truncation.
 * Falls back to the pretty-printed whole line when the field isn't found,
 * and to the raw text when the line doesn't parse. Never throws.
 */
export function fullSignalText(kind: string, subtype: string | undefined, lineText: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(lineText)
  } catch {
    return lineText
  }
  const o = asObj(parsed)
  if (!o) return lineText
  const pretty = () => JSON.stringify(parsed, null, 2)
  switch (kind) {
    case 'content_thinking': {
      const msg = asObj(o.message)
      if (Array.isArray(msg?.content)) {
        for (const b of msg.content) {
          const bb = asObj(b)
          if (bb?.type === 'thinking' && typeof bb.thinking === 'string') return bb.thinking
        }
      }
      return pretty()
    }
    case 'queue-operation':
      return str(o.content) ?? pretty()
    case 'last-prompt':
      return str(o.lastPrompt) ?? pretty()
    case 'tool_result': {
      const { body } = extractToolResultText(o)
      return body || pretty()
    }
    case 'attachment': {
      const att = asObj(o.attachment)
      if (!att) return pretty()
      switch (subtype) {
        case 'mcp_instructions_delta':
          return Array.isArray(att.addedBlocks)
            ? att.addedBlocks.filter((s): s is string => typeof s === 'string').join('\n\n')
            : pretty()
        case 'queued_command':
          return str(att.prompt) ?? pretty()
        case 'skill_listing':
          return str(att.content) ?? pretty()
        case 'edited_text_file':
          return str(att.snippet) ?? pretty()
        default:
          return pretty()
      }
    }
    default:
      return pretty()
  }
}

/** Full uncapped name list from the untruncated line — the expand path for
 *  count chips whose ingest-time list was capped at SIGNAL_NAMES_MAX. */
export function fullSignalNames(subtype: string | undefined, lineText: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(lineText)
  } catch {
    return null
  }
  const att = asObj(asObj(parsed)?.attachment)
  if (!att) return null
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : null)
  switch (subtype) {
    case 'deferred_tools_delta':
      return list(att.addedNames)
    case 'agent_listing_delta':
      return list(att.addedTypes)
    case 'command_permissions':
      return list(att.allowedTools)
    case 'skill_listing': {
      const content = str(att.content) ?? ''
      const names = content
        .split('\n')
        .map((l) => /^-\s*([^:]+):/.exec(l)?.[1]?.trim())
        .filter((n): n is string => !!n)
      return names.length ? names : null
    }
    default:
      return null
  }
}

/** Kinds rendered as tool chips — used by visibleFeedTurns to merge
 *  consecutive tool events into one strip (runs collapse via the existing
 *  collapseToolUseRuns, so counts stay truthful — nothing is dropped). */
export function isToolFamilyKind(kind: string | undefined): boolean {
  return kind === 'tool_use' || kind === 'todo_write' || kind === 'plan' || kind === 'agent_spawn'
}
