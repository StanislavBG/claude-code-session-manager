import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSessions } from '../state/sessions'
import { useVoice } from '../state/voice'
import { toast } from '../state/toast'

/**
 * CommandPalette — Cmd-K / Ctrl-K modal palette.
 *
 * Bundle B owns the App-level hotkey listener that toggles `open`. Bundle D
 * (this file) ships the component. Commands that the palette itself can't
 * execute directly (e.g. switching nav tabs, opening the broadcast popover
 * whose state lives in MainPane) are emitted to the parent via `onCommand`
 * with a stable id (`nav:<key>`, `broadcast`, `watchers`, etc.) so the parent
 * can route them.
 *
 * The fuzzy filter is a hand-rolled 20-line subsequence matcher — no Fuse.js
 * dependency. Time complexity: O(N × Q) per keystroke where N is commands
 * (~30) and Q is the query length (typically <10). Trivial for a 30-item list.
 *
 * Keyboard:
 *   ↑ / ↓        — move highlight
 *   Enter        — run highlighted command
 *   Esc          — close
 *   anything else — types into the search input (autofocused on open)
 */

export type CommandSection = 'nav' | 'scheduler' | 'voice' | 'session' | 'config'

export interface Command {
  id: string
  label: string
  section: CommandSection
  /** Stable hint / shortcut shown right-aligned. */
  hint?: string
  /** If the palette can run the command directly. Else `onCommand` is called. */
  run?: () => void | Promise<void>
  /** When true, the parent receives this via onCommand instead of palette executing. */
  emitOnly?: boolean
}

interface Props {
  open: boolean
  onClose: () => void
  onCommand: (cmd: Command) => void
}

const SECTION_LABELS: Record<CommandSection, string> = {
  nav: 'Navigate',
  scheduler: 'Scheduler',
  voice: 'Voice',
  session: 'Session',
  config: 'Config',
}

/**
 * 30 commands sourced from research-04 §1 (the data-derived top-30 list).
 * Each command either runs inline or emits to the parent via onCommand.
 * `emitOnly` ids the parent must handle:
 *   nav:*               — switch tab to NavKey
 *   new-tab-here / new-tab-pick — TabBar.addTab / createPickedSession
 *   close-tab           — TabBar.closeTab on activeTabId
 *   restart-session     — MainPane Restart Session
 *   broadcast / watchers — toggle local MainPane popovers
 *   copy-cwd / copy-transcript / open-transcript — depend on active tab
 *   test-fire-hook      — focus Hooks tab + open test-fire dialog
 *   add-allow-rule      — focus Permissions tab + open add-rule
 */
function buildCommands(): Command[] {
  const cmds: Command[] = [
    // ── session ──
    { id: 'new-tab-pick', label: 'New tab — pick directory', section: 'session', emitOnly: true },
    { id: 'new-tab-here', label: 'New tab in current cwd', section: 'session', emitOnly: true },
    { id: 'close-tab', label: 'Close active tab', section: 'session', emitOnly: true, hint: 'Ctrl+W' },
    { id: 'restart-session', label: 'Restart session', section: 'session', emitOnly: true, hint: 'Ctrl+Shift+R' },
    { id: 'reboot-app', label: 'Reboot app', section: 'session', run: () => window.api.app.rebootApp() },
    { id: 'broadcast', label: 'Broadcast prompt to all tabs', section: 'session', emitOnly: true, hint: 'Ctrl+Shift+B' },
    { id: 'watchers', label: 'Attach a watcher', section: 'session', emitOnly: true, hint: 'Ctrl+Shift+W' },
    { id: 'copy-cwd', label: 'Copy active tab cwd', section: 'session', emitOnly: true },
    { id: 'copy-transcript', label: 'Copy transcript path', section: 'session', emitOnly: true },
    { id: 'open-transcript', label: 'Open transcript JSONL', section: 'session', emitOnly: true },

    // ── voice ──
    {
      id: 'voice-toggle',
      label: 'Voice — toggle mic',
      section: 'voice',
      run: () => {
        const st = useVoice.getState()
        const activeTabId = useSessions.getState().activeTabId
        if (st.isRecording) st.stopRecording()
        else if (activeTabId) st.startRecording(activeTabId)
      },
    },
    {
      id: 'voice-tts',
      label: 'Voice — toggle TTS',
      section: 'voice',
      run: () => useVoice.getState().toggleTTS(),
    },
    {
      id: 'voice-cancel-submit',
      label: 'Voice — cancel auto-submit',
      section: 'voice',
      hint: 'Esc',
      run: () => useVoice.getState().cancelSubmit(),
    },

    // ── scheduler ──
    // Errors toast through `runCommand`'s outer catch (see ~287) so the
    // user sees feedback when Cmd-K → "Run now" fails. Bare `.catch(() => {})`
    // here would swallow the failure silently.
    {
      id: 'scheduler-run-now',
      label: 'Scheduler — Run now',
      section: 'scheduler',
      run: async () => { await window.api.schedule.runNow() },
    },
    {
      id: 'scheduler-force-tick',
      label: 'Scheduler — Force tick (bypass meter)',
      section: 'scheduler',
      run: async () => { await window.api.schedule.forceTick() },
    },
    {
      id: 'scheduler-resume',
      label: 'Scheduler — Resume from pause',
      section: 'scheduler',
      run: async () => { await window.api.schedule.resume() },
    },
    {
      id: 'scheduler-rescan',
      label: 'Scheduler — Re-scan PRDs folder',
      section: 'scheduler',
      run: async () => { await window.api.schedule.rescan() },
    },
    {
      id: 'scheduler-lint',
      label: 'Scheduler — Lint queue (find unbounded loops)',
      section: 'scheduler',
      emitOnly: true,
    },
    {
      id: 'scheduler-open-folder',
      label: 'Scheduler — Open PRDs folder',
      section: 'scheduler',
      run: async () => { await window.api.schedule.openFolder() },
    },
    {
      id: 'scheduler-supervisor-tick',
      label: 'Scheduler — Run supervisor probe now',
      section: 'scheduler',
      run: async () => { await window.api.supervisor.tickNow() },
    },

    // ── config ──
    { id: 'add-allow-rule', label: 'Permissions — Add allow rule', section: 'config', emitOnly: true },
    { id: 'test-fire-hook', label: 'Hooks — Test-fire a hook', section: 'config', emitOnly: true },
    { id: 'devtools', label: 'Toggle DevTools', section: 'config', emitOnly: true, hint: 'F12' },
    { id: 'reload-window', label: 'Reload window', section: 'config', emitOnly: true, hint: 'Ctrl+R' },

    // ── nav ── (17 tabs — same NavKey values used in LeftNav.tsx:12-29)
    { id: 'nav:overview', label: 'Go to Overview', section: 'nav', emitOnly: true },
    { id: 'nav:terminal', label: 'Go to Terminal', section: 'nav', emitOnly: true },
    { id: 'nav:settings', label: 'Go to Settings', section: 'nav', emitOnly: true },
    { id: 'nav:permissions', label: 'Go to Permissions', section: 'nav', emitOnly: true },
    { id: 'nav:skills', label: 'Go to Skills', section: 'nav', emitOnly: true },
    { id: 'nav:plugins', label: 'Go to Plugins', section: 'nav', emitOnly: true },
    { id: 'nav:mcp', label: 'Go to MCP Servers', section: 'nav', emitOnly: true },
    { id: 'nav:hooks', label: 'Go to Hooks', section: 'nav', emitOnly: true },
    { id: 'nav:subagents', label: 'Go to Subagents', section: 'nav', emitOnly: true },
    { id: 'nav:scheduler', label: 'Go to Scheduler', section: 'nav', emitOnly: true },
    { id: 'nav:memory', label: 'Go to Memory', section: 'nav', emitOnly: true },
    { id: 'nav:projects', label: 'Go to File Explorer', section: 'nav', emitOnly: true },
    { id: 'nav:history', label: 'Go to History', section: 'nav', emitOnly: true },
    { id: 'nav:keybindings', label: 'Go to Keybindings', section: 'nav', emitOnly: true },
    { id: 'nav:usage', label: 'Go to Usage', section: 'nav', emitOnly: true },
    { id: 'nav:knowledge-graph', label: 'Go to Knowledge Graph', section: 'nav', emitOnly: true },
    { id: 'nav:system-prompt', label: 'Go to System Prompt', section: 'nav', emitOnly: true },
    { id: 'nav:doc-editor', label: 'Go to Doc Editor', section: 'nav', emitOnly: true },
    { id: 'nav:prompts', label: 'Go to Prompts', section: 'nav', emitOnly: true },
  ]
  return cmds
}

/**
 * Fuzzy subsequence match. Returns null if `query` is not a subsequence of
 * `label.toLowerCase()`. Score: lower = better. Penalizes gaps between matched
 * characters and rewards matches near the start. O(L × Q) where L is label
 * length and Q is query length — trivial for our 30-item list.
 */
function fuzzyScore(label: string, query: string): number | null {
  if (!query) return 0
  const hay = label.toLowerCase()
  const q = query.toLowerCase()
  let qi = 0
  let prev = -1
  let score = 0
  for (let i = 0; i < hay.length && qi < q.length; i++) {
    if (hay[i] === q[qi]) {
      // Penalize the gap from the previous match.
      score += i - prev
      prev = i
      qi++
    }
  }
  if (qi !== q.length) return null
  // Bonus for an early first-match.
  return score
}

interface ScoredCommand extends Command {
  score: number
}

function filterAndSort(commands: Command[], query: string): ScoredCommand[] {
  if (!query) return commands.map((c) => ({ ...c, score: 0 }))
  const out: ScoredCommand[] = []
  for (const c of commands) {
    const s = fuzzyScore(c.label, query)
    if (s !== null) out.push({ ...c, score: s })
  }
  out.sort((a, b) => a.score - b.score)
  return out
}

export function CommandPalette({ open, onClose, onCommand }: Props) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const dismissRef = useRef<HTMLButtonElement | null>(null)
  // Snapshot of the element that owned focus when the palette opened, so
  // we can restore focus on close. Cleared after restore to prevent leaks.
  const restoreRef = useRef<HTMLElement | null>(null)

  // Stable command list — built once per mount.
  const commands = useMemo(() => buildCommands(), [])

  const filtered = useMemo(() => filterAndSort(commands, query), [commands, query])

  // Reset state whenever the palette opens, snapshot focus origin, and
  // restore focus on close.
  useEffect(() => {
    if (open) {
      // Snapshot focus before we steal it.
      const active = document.activeElement
      restoreRef.current = active instanceof HTMLElement ? active : null
      setQuery('')
      setHighlight(0)
      // Defer focus to after portal mounts.
      const t = setTimeout(() => inputRef.current?.focus(), 0)
      return () => {
        clearTimeout(t)
        // Restore focus on close. Use requestAnimationFrame so the portal
        // unmount completes first; otherwise focus() races the React commit.
        const target = restoreRef.current
        restoreRef.current = null
        if (target) {
          requestAnimationFrame(() => {
            try { target.focus() } catch { /* element may have unmounted */ }
          })
        }
      }
    }
    return undefined
  }, [open])

  // Clamp highlight when filter shrinks.
  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(Math.max(0, filtered.length - 1))
  }, [filtered.length, highlight])

  // Scroll the highlighted row into view.
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-cmd-idx="${highlight}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  if (!open) return null

  const runCommand = async (cmd: Command) => {
    // Close first so any side-effect (e.g. focus changes) lands on the correct
    // host. Parent receives the command id even for non-emitOnly entries —
    // lets a future analytics layer hook in without re-routing.
    onClose()
    if (cmd.emitOnly) {
      onCommand(cmd)
      return
    }
    try {
      await cmd.run?.()
    } catch (e) {
      console.error('[command-palette] run failed', cmd.id, e)
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`Command "${cmd.label}" failed: ${msg}`)
    }
    onCommand(cmd)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(filtered.length - 1, h + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(0, h - 1))
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      setHighlight(0)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      setHighlight(Math.max(0, filtered.length - 1))
      return
    }
    if (e.key === 'PageDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(filtered.length - 1, h + 5))
      return
    }
    if (e.key === 'PageUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(0, h - 5))
      return
    }
    if (e.key === 'Tab') {
      // Focus trap: cycle between input and dismiss button only. Options
      // are listbox children referenced via aria-activedescendant, so they
      // do not participate in the tab sequence.
      e.preventDefault()
      const focused = document.activeElement
      if (e.shiftKey) {
        if (focused === inputRef.current) dismissRef.current?.focus()
        else inputRef.current?.focus()
      } else {
        if (focused === inputRef.current) dismissRef.current?.focus()
        else inputRef.current?.focus()
      }
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = filtered[highlight]
      if (cmd) runCommand(cmd)
      return
    }
  }

  // Group filtered commands by section, preserving sort order.
  const grouped: { section: CommandSection; items: { cmd: ScoredCommand; absIdx: number }[] }[] = []
  const indexBySection = new Map<CommandSection, number>()
  filtered.forEach((cmd, absIdx) => {
    let bucket = indexBySection.get(cmd.section)
    if (bucket === undefined) {
      bucket = grouped.length
      indexBySection.set(cmd.section, bucket)
      grouped.push({ section: cmd.section, items: [] })
    }
    grouped[bucket].items.push({ cmd, absIdx })
  })

  const activeCmd = filtered[highlight]
  const activeOptionId = activeCmd ? `cmdk-opt-${activeCmd.id}` : undefined

  const node = (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[15vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      data-testid="command-palette-backdrop"
      onKeyDown={onKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cmdk-title"
        className="w-[600px] max-w-[90vw] bg-bg-elev border border-line rounded shadow-xl"
        data-testid="command-palette"
      >
        <div className="border-b border-line flex items-center">
          <input
            ref={inputRef}
            id="cmdk-title"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlight(0)
            }}
            placeholder="Type a command…"
            aria-label="Command palette search"
            aria-controls="cmdk-listbox"
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
            role="combobox"
            aria-expanded="true"
            className="flex-1 bg-transparent px-3 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:outline-none font-mono"
            spellCheck={false}
            autoComplete="off"
          />
          <button
            ref={dismissRef}
            type="button"
            onClick={onClose}
            aria-label="Close command palette"
            className="shrink-0 px-2 py-1 mr-1 text-fg-faint hover:text-fg text-sm"
            data-testid="command-palette-dismiss"
          >
            ×
          </button>
        </div>

        <div
          ref={listRef}
          id="cmdk-listbox"
          role="listbox"
          aria-label="Commands"
          className="max-h-[60vh] overflow-y-auto py-1"
          data-testid="command-palette-list"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-xs text-fg-faint italic">No matching commands.</div>
          ) : (
            grouped.map((g) => (
              <div key={g.section} role="group" aria-label={SECTION_LABELS[g.section]} className="py-1">
                <div className="px-3 py-0.5 text-[9px] uppercase tracking-wider text-fg-faint" aria-hidden="true">
                  {SECTION_LABELS[g.section]}
                </div>
                {g.items.map(({ cmd, absIdx }) => {
                  const isActive = absIdx === highlight
                  return (
                    <button
                      key={cmd.id}
                      id={`cmdk-opt-${cmd.id}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      data-cmd-idx={absIdx}
                      data-cmd-id={cmd.id}
                      tabIndex={-1}
                      onMouseEnter={() => setHighlight(absIdx)}
                      onClick={() => runCommand(cmd)}
                      className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${
                        isActive ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:bg-bg-hi/50'
                      }`}
                    >
                      <span className="truncate flex-1">{cmd.label}</span>
                      {cmd.hint && (
                        <span className="font-mono text-[10px] text-fg-faint shrink-0">{cmd.hint}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className="border-t border-line px-3 py-1.5 text-[10px] text-fg-faint flex gap-3 font-mono" aria-hidden="true">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
          <span className="ml-auto">
            {filtered.length} of {commands.length}
          </span>
        </div>
      </div>
    </div>
  )

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(node, document.body)
  }
  return node
}
