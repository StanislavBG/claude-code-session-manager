/**
 * MemoryNaturalPanel — chat-style entry to the workspace memory store.
 *
 * Inspired by Unleashed's MemoryPanelNatural (which writes to ~/.claude memory
 * files directly). Our store is workspace-scoped markdown via `memory.*` IPC,
 * and Claude (running in the active terminal) has the tool permissions to
 * write itself — so this panel never auto-mutates from a free-form prompt.
 *
 * Two action paths:
 *   - LOCAL — recognised commands (list / show / search / forget / delete /
 *     read / help) call our IPC and render results inline. `forget` and
 *     `delete` require a confirm.
 *   - SEND TO CLAUDE — anything else (or an explicit "remember …") composes a
 *     structured prompt and writes it to the active session's PTY. The user
 *     can also click "Add as new memory" to write a single entry directly via
 *     `memory.create` from the parsed intent.
 *
 * Patterns recognised locally (case-insensitive, leading verb):
 *   list | list memories | ls
 *   show <slug> | read <slug> | open <slug>
 *   search <text> | find <text> | what do you know about <text>
 *   forget <slug> | delete <slug>
 *   help | ?
 *
 * Anything else falls through to "Send to Claude" / "Add as memory".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import { encodeWorkspace } from '../../lib/encodeWorkspace'
import { formatBytes } from '../../lib/formatBytes'
import { EmptyState } from '../ui/EmptyState'
import { toast } from '../../state/toast'
import type { MemoryEntry } from '../../../preload/api'

const SLUG_RE = /^[a-z0-9-_]+$/

type MessageRole = 'user' | 'system' | 'result'

interface ChatMessage {
  id: string
  role: MessageRole
  text: string
  /** Optional structured payload rendered under the message. */
  payload?:
    | { kind: 'entries'; entries: MemoryEntry[] }
    | { kind: 'entry'; entry: MemoryEntry; content: string }
    | { kind: 'search'; query: string; hits: SearchHit[] }
    | { kind: 'suggest-send'; prompt: string; original: string }
    | { kind: 'suggest-add'; slug: string; content: string }
}

interface SearchHit {
  entry: MemoryEntry
  /** First matching line, trimmed. */
  snippet: string
}

interface ParsedCommand {
  kind: 'list' | 'show' | 'search' | 'forget' | 'help' | 'remember' | 'freeform'
  /** For show/forget: the slug. For search/remember/freeform: the body. */
  arg: string
  /** Raw original input. */
  raw: string
}

const HELP_TEXT = [
  'Commands:',
  '  list                          — show all memory entries',
  '  show <slug>                   — read one entry',
  '  search <text>                 — find entries containing <text>',
  '  forget <slug>                 — delete an entry (with confirm)',
  '  remember <free-form>          — ask Claude to save this',
  '  help                          — this message',
  '',
  'Anything else: I will offer to send it to Claude in the terminal,',
  'or add it as a new memory entry directly.',
].join('\n')

// O(1) verb match; arg is the rest.
function parseInput(raw: string): ParsedCommand {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: 'freeform', arg: '', raw }
  const lower = trimmed.toLowerCase()
  if (lower === 'help' || lower === '?') return { kind: 'help', arg: '', raw }
  if (
    lower === 'list' ||
    lower === 'ls' ||
    lower === 'list memories' ||
    lower === 'list all' ||
    lower === 'what do you remember' ||
    lower === 'what do you remember?'
  ) {
    return { kind: 'list', arg: '', raw }
  }
  // "show <slug>" / "read <slug>" / "open <slug>"
  const showMatch = trimmed.match(/^(?:show|read|open)\s+(.+)$/i)
  if (showMatch) return { kind: 'show', arg: showMatch[1].trim(), raw }
  // "forget <slug>" / "delete <slug>"
  const forgetMatch = trimmed.match(/^(?:forget|delete|remove)\s+(.+)$/i)
  if (forgetMatch) return { kind: 'forget', arg: forgetMatch[1].trim(), raw }
  // "search <text>" / "find <text>" / "what do you know about <text>"
  const searchMatch =
    trimmed.match(/^(?:search|find)\s+(.+)$/i) ||
    trimmed.match(/^what (?:do )?you know about\s+(.+?)\??$/i)
  if (searchMatch) return { kind: 'search', arg: searchMatch[1].trim(), raw }
  // "remember <text>" / "note that <text>" / "save that <text>"
  const rememberMatch =
    trimmed.match(/^remember(?:\s+that)?\s+(.+)$/i) ||
    trimmed.match(/^note(?:\s+that)?\s+(.+)$/i) ||
    trimmed.match(/^save(?:\s+that)?\s+(.+)$/i)
  if (rememberMatch) return { kind: 'remember', arg: rememberMatch[1].trim(), raw }
  return { kind: 'freeform', arg: trimmed, raw }
}

// Normalise a slug-ish token into the actual stored name (`foo` → `foo.md`).
function resolveName(arg: string, entries: MemoryEntry[]): MemoryEntry | null {
  const lower = arg.toLowerCase().replace(/\.md$/, '')
  const exact = entries.find((e) => e.name.replace(/\.md$/, '').toLowerCase() === lower)
  if (exact) return exact
  // Fall back to startsWith / includes — unique match only.
  const startsWith = entries.filter((e) =>
    e.name.replace(/\.md$/, '').toLowerCase().startsWith(lower),
  )
  if (startsWith.length === 1) return startsWith[0]
  const includes = entries.filter((e) =>
    e.name.replace(/\.md$/, '').toLowerCase().includes(lower),
  )
  if (includes.length === 1) return includes[0]
  return null
}

// Slug suggestion from free-form text. Strips leading filler words, drops
// stopwords, takes first 4 tokens.
function suggestSlug(text: string): string {
  const stop = new Set(['the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'for', 'and', 'or'])
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !stop.has(t))
    .slice(0, 4)
  const slug = tokens.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return slug || `note-${Date.now().toString(36).slice(-4)}`
}

function buildRememberPrompt(workspace: string, body: string): string {
  // Structured ask — explicit instruction so Claude uses the memory tool /
  // writes to `~/.claude/session-manager/memories/<workspace>/…` rather than
  // dropping a note in chat.
  return [
    `Please save this to my workspace memory (workspace: ${workspace}).`,
    `Use the memory tool (or write a markdown file under ~/.claude/session-manager/memories/${workspace}/).`,
    `Pick a short kebab-case filename and add a one-line title at the top.`,
    ``,
    `Memory to save:`,
    body,
  ].join('\n')
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

interface Props {
  /** Encoded workspace key for the IPC layer. */
  workspace: string
  /** Current entries — supplied by parent so it stays in sync with classic view. */
  entries: MemoryEntry[]
  /** Trigger a re-list after a local mutation (delete / add). */
  onChanged: () => void
}

export function MemoryNaturalPanel({ workspace, entries, onChanged }: Props) {
  const home = useHomeDir()
  const activeTab = useActiveTab()
  const activeTabId = activeTab?.id ?? null

  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: uid(),
      role: 'system',
      text:
        'Hi — I am the memory assistant for this workspace. Type `help` for what I understand, or just talk to me.',
    },
  ])
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll on new message. Cheap O(1).
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const push = useCallback((m: Omit<ChatMessage, 'id'>) => {
    setMessages((prev) => [...prev, { ...m, id: uid() }])
  }, [])

  const handleList = useCallback(() => {
    if (entries.length === 0) {
      push({ role: 'result', text: 'No memories saved for this workspace yet.' })
      return
    }
    push({
      role: 'result',
      text: `Found ${entries.length} ${entries.length === 1 ? 'memory' : 'memories'}:`,
      payload: { kind: 'entries', entries },
    })
  }, [entries, push])

  const handleShow = useCallback(
    async (arg: string) => {
      const match = resolveName(arg, entries)
      if (!match) {
        push({ role: 'result', text: `No memory matches "${arg}". Try \`list\` to see what is here.` })
        return
      }
      const r = await window.api.memory.read(match.name, workspace)
      if (r.error) {
        toast.error(`Memory read failed: ${r.error}`)
        push({ role: 'result', text: `Read failed: ${r.error}` })
        return
      }
      push({
        role: 'result',
        text: `${match.name}`,
        payload: { kind: 'entry', entry: match, content: r.content },
      })
    },
    [entries, workspace, push],
  )

  const handleSearch = useCallback(
    async (query: string) => {
      const lowerQuery = query.toLowerCase()
      // First pass: filename match (O(n), n = entries — small).
      const nameHits = entries.filter((e) => e.name.toLowerCase().includes(lowerQuery))
      // Second pass: read bodies for the rest. Bounded by `entries.length`,
      // each read goes through the IPC layer; OK for typical workspace size.
      // Complexity: O(n * file_bytes). Fine while n stays in the dozens.
      const bodyHits: SearchHit[] = []
      for (const e of entries) {
        if (nameHits.includes(e)) continue
        const r = await window.api.memory.read(e.name, workspace)
        if (r.error) continue
        const lines = r.content.split('\n')
        const idx = lines.findIndex((l) => l.toLowerCase().includes(lowerQuery))
        if (idx >= 0) {
          bodyHits.push({ entry: e, snippet: lines[idx].trim().slice(0, 200) })
        }
      }
      const allHits: SearchHit[] = [
        ...nameHits.map((e) => ({ entry: e, snippet: '(filename match)' })),
        ...bodyHits,
      ]
      if (allHits.length === 0) {
        push({ role: 'result', text: `No matches for "${query}".` })
        return
      }
      push({
        role: 'result',
        text: `Found ${allHits.length} ${allHits.length === 1 ? 'match' : 'matches'} for "${query}":`,
        payload: { kind: 'search', query, hits: allHits },
      })
    },
    [entries, workspace, push],
  )

  const handleForget = useCallback(
    async (arg: string) => {
      const match = resolveName(arg, entries)
      if (!match) {
        push({ role: 'result', text: `No memory matches "${arg}". Try \`list\` to see what is here.` })
        return
      }
      if (!window.confirm(`Delete memory "${match.name}"? This cannot be undone.`)) return
      const r = await window.api.memory.delete(match.name, workspace)
      if (!r.ok) {
        toast.error(`Memory delete failed: ${r.error ?? 'unknown error'}`)
        push({ role: 'result', text: `Delete failed: ${r.error ?? 'unknown error'}` })
        return
      }
      push({ role: 'result', text: `Deleted ${match.name}.` })
      onChanged()
    },
    [entries, workspace, push, onChanged],
  )

  const handleRemember = useCallback(
    (body: string) => {
      const slug = suggestSlug(body)
      const prompt = buildRememberPrompt(workspace, body)
      push({
        role: 'result',
        text:
          'I do not write to memory from this panel. Send the request to Claude in the active terminal, or add it directly as a new memory entry below.',
        payload: { kind: 'suggest-send', prompt, original: body },
      })
      push({
        role: 'result',
        text: `Add it directly as \`${slug}.md\` instead?`,
        payload: { kind: 'suggest-add', slug, content: body },
      })
    },
    [workspace, push],
  )

  const handleFreeform = useCallback(
    (raw: string) => {
      const slug = suggestSlug(raw)
      const prompt = buildRememberPrompt(workspace, raw)
      push({
        role: 'result',
        text: 'Not a recognised command. Options:',
        payload: { kind: 'suggest-send', prompt, original: raw },
      })
      push({
        role: 'result',
        text: `…or save it directly as \`${slug}.md\`.`,
        payload: { kind: 'suggest-add', slug, content: raw },
      })
    },
    [workspace, push],
  )

  const dispatch = useCallback(
    async (cmd: ParsedCommand) => {
      setBusy(true)
      try {
        switch (cmd.kind) {
          case 'list':
            handleList()
            break
          case 'show':
            await handleShow(cmd.arg)
            break
          case 'search':
            await handleSearch(cmd.arg)
            break
          case 'forget':
            await handleForget(cmd.arg)
            break
          case 'help':
            push({ role: 'result', text: HELP_TEXT })
            break
          case 'remember':
            handleRemember(cmd.arg)
            break
          case 'freeform':
            handleFreeform(cmd.arg)
            break
        }
      } finally {
        setBusy(false)
      }
    },
    [handleList, handleShow, handleSearch, handleForget, handleRemember, handleFreeform, push],
  )

  const onSubmit = useCallback(async () => {
    const raw = input.trim()
    if (!raw || busy) return
    setInput('')
    push({ role: 'user', text: raw })
    await dispatch(parseInput(raw))
  }, [input, busy, dispatch, push])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSubmit()
    }
  }

  // Send a structured prompt to the active terminal. Does NOT submit (no \r);
  // the user reviews and presses Enter in the terminal themselves.
  const sendToClaude = useCallback(
    (prompt: string) => {
      if (!activeTabId) {
        toast.error('No active terminal session — open or focus a tab first.')
        return
      }
      window.api.pty.write({ tabId: activeTabId, data: prompt })
      toast.info('Prompt sent to active terminal (not submitted)')
    },
    [activeTabId],
  )

  // Direct write via memory.create — only fires from an explicit user click.
  const addDirect = useCallback(
    async (slug: string, content: string) => {
      if (!SLUG_RE.test(slug)) {
        toast.error(`Invalid slug "${slug}" — must be [a-z0-9-_]+`)
        return
      }
      const name = `${slug}.md`
      // Use `create` so we never overwrite an existing entry without intent.
      const created = await window.api.memory.create(name, undefined, workspace)
      if (!created.ok) {
        toast.error(`Create failed: ${created.error ?? 'unknown error'}`)
        return
      }
      // Append the body via `write` — `create` only seeds frontmatter.
      const existing = await window.api.memory.read(name, workspace)
      const body = existing.error ? content : `${existing.content.trimEnd()}\n\n${content}\n`
      const written = await window.api.memory.write(name, body, workspace)
      if (!written.ok) {
        toast.error(`Write failed: ${written.error ?? 'unknown error'}`)
        return
      }
      push({ role: 'result', text: `Saved as ${name}.` })
      onChanged()
    },
    [workspace, push, onChanged],
  )

  // Quick-action chips that prefill the input.
  const quick = useMemo(
    () => [
      { label: 'List memories', value: 'list' },
      { label: 'Help', value: 'help' },
      { label: 'Search…', value: 'search ' },
      { label: 'Remember…', value: 'remember ' },
    ],
    [],
  )

  if (!home) return <EmptyState title="loading…" />

  return (
    <div className="h-full flex flex-col">
      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
        {messages.map((m) => (
          <MessageRow
            key={m.id}
            message={m}
            entries={entries}
            onShow={(name) => {
              setInput(`show ${name.replace(/\.md$/, '')}`)
              inputRef.current?.focus()
            }}
            onSendToClaude={sendToClaude}
            onAddDirect={addDirect}
          />
        ))}
        {busy && <div className="text-xs text-fg-faint italic">working…</div>}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-line px-3 py-2 space-y-2">
        <div className="flex gap-1 flex-wrap">
          {quick.map((q) => (
            <button
              key={q.label}
              onClick={() => {
                setInput(q.value)
                inputRef.current?.focus()
              }}
              className="px-2 py-0.5 text-[11px] text-fg-faint hover:text-fg-dim border border-line hover:border-fg-faint rounded transition-colors"
            >
              {q.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type `list`, `show <slug>`, `search <text>`, `remember …`, or talk freely. Enter to send, Shift+Enter for newline."
            rows={2}
            className="flex-1 bg-bg border border-line rounded px-2 py-1 text-xs text-fg resize-none focus:outline-none focus:border-fg-faint"
          />
          <button
            onClick={onSubmit}
            disabled={!input.trim() || busy}
            className="px-3 py-1 text-xs text-fg border border-line hover:bg-bg-hi rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
        <div className="text-[10px] text-fg-faint">
          Workspace: <span className="font-mono">{workspace}</span>
          {!activeTabId && (
            <span className="ml-2 text-amber-400">(no active terminal — Send-to-Claude disabled)</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────── message row

interface MessageRowProps {
  message: ChatMessage
  entries: MemoryEntry[]
  onShow: (name: string) => void
  onSendToClaude: (prompt: string) => void
  onAddDirect: (slug: string, content: string) => void
}

function MessageRow({ message, entries: _entries, onShow, onSendToClaude, onAddDirect }: MessageRowProps) {
  const bubbleClass =
    message.role === 'user'
      ? 'bg-bg-hi text-fg ml-8'
      : message.role === 'system'
      ? 'bg-bg text-fg-dim italic'
      : 'bg-bg text-fg-dim'

  return (
    <div className={`text-xs rounded border border-line px-3 py-2 ${bubbleClass}`}>
      <div className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">{message.text}</div>
      {message.payload?.kind === 'entries' && (
        <div className="mt-2 space-y-0.5">
          {message.payload.entries.map((e) => (
            <button
              key={e.name}
              onClick={() => onShow(e.name)}
              className="block w-full text-left px-2 py-0.5 text-[11px] text-fg-dim hover:text-fg hover:bg-bg-hi rounded font-mono"
            >
              {e.name} <span className="text-fg-faint">({formatBytes(e.bytes)})</span>
            </button>
          ))}
        </div>
      )}
      {message.payload?.kind === 'entry' && (
        <pre className="mt-2 max-h-64 overflow-auto px-2 py-1 bg-bg-hi rounded text-[11px] whitespace-pre-wrap text-fg">
          {message.payload.content}
        </pre>
      )}
      {message.payload?.kind === 'search' && (
        <div className="mt-2 space-y-1">
          {message.payload.hits.map((h, i) => (
            <button
              key={`${h.entry.name}-${i}`}
              onClick={() => onShow(h.entry.name)}
              className="block w-full text-left px-2 py-1 hover:bg-bg-hi rounded"
            >
              <div className="font-mono text-[11px] text-fg-dim">{h.entry.name}</div>
              <div className="text-[10px] text-fg-faint truncate">{h.snippet}</div>
            </button>
          ))}
        </div>
      )}
      {message.payload?.kind === 'suggest-send' && (
        <div className="mt-2 flex gap-2 items-center">
          <button
            onClick={() => onSendToClaude(message.payload!.kind === 'suggest-send' ? message.payload!.prompt : '')}
            className="px-2 py-0.5 text-[11px] text-fg-dim hover:text-fg border border-line hover:border-fg-faint rounded transition-colors"
          >
            Send to Claude in terminal
          </button>
          <span className="text-[10px] text-fg-faint">paste-only — you press Enter</span>
        </div>
      )}
      {message.payload?.kind === 'suggest-add' && (
        <div className="mt-2 flex gap-2 items-center">
          <button
            onClick={() =>
              message.payload?.kind === 'suggest-add' &&
              onAddDirect(message.payload.slug, message.payload.content)
            }
            className="px-2 py-0.5 text-[11px] text-fg-dim hover:text-fg border border-line hover:border-fg-faint rounded transition-colors"
          >
            Add as new memory
          </button>
          <span className="text-[10px] text-fg-faint font-mono">{message.payload.slug}.md</span>
        </div>
      )}
    </div>
  )
}
