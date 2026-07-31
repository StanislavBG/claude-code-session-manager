/**
 * Keybindings — game-style controls screen over ~/.claude/keybindings.json.
 *
 * Layout:
 *   Preset strip   — Claude defaults / Vim motion / Emacs flow cards; clicking
 *                    one replaces the draft with that preset (Save to commit).
 *   Context list   — left sidebar, one row per UI context (Global, Chat, …)
 *                    with a count of customized keys.
 *   Action rows    — right pane: every built-in action for the selected
 *                    context with its bound keycaps. Click "+ bind", press the
 *                    keys, done. Esc cancels a capture. Removing a keycap
 *                    reverts that key to the Claude Code default.
 *
 * All visual edits round-trip through the same config-store draft as the raw
 * editor (setDraft(serializeDoc(...))), so SaveBar dirty/save/revert and the
 * file watcher behave identically in both views. The JSON view stays available
 * for chords, command: bindings, and anything the visual editor doesn't cover.
 */

import { useEffect, useMemo, useState } from 'react'
import { Panel } from '../ui/Panel'
import { SaveBar } from '../ui/SaveBar'
import { JsonEditor } from '../ui/JsonEditor'
import { EmptyState } from '../ui/EmptyState'
import { ListDetail } from '../ui/ListDetail'
import { ViewTabs } from '../ui/ViewTabs'
import { useConfig } from '../../state/config'
import { KEYBINDINGS_SCOPES } from '../../lib/scopes'
import { useHomeDir } from '../../lib/useHomeDir'
import { toast } from '../../state/toast'
import { usePanelFocus } from '../../lib/panelFocus'
import {
  CONTEXTS, CONTEXT_HINT, PRESETS, RESERVED_PATTERNS, SCHEMA_URL,
  actionLabel, actionsForContext, blockFor, detectPreset, eventToPattern,
  parseDoc, prettyPattern, serializeDoc, withBinding,
  type KeybindingsDoc,
} from '../../lib/keybindings'

const DEFAULT_TEMPLATE = `{
  "$schema": "${SCHEMA_URL}",
  "bindings": []
}
`

type View = 'controls' | 'json'

/** What the key-capture overlay is currently rebinding. */
type Capture =
  | { kind: 'bind'; action: string }
  | { kind: 'disable' } // capture a key to disable its Claude default
  | null

export function Keybindings() {
  const home = useHomeDir()
  const files = useConfig((s) => s.files)
  const loadJson = useConfig((s) => s.loadJson)
  const setDraft = useConfig((s) => s.setDraft)
  const saveJson = useConfig((s) => s.saveJson)
  const revert = useConfig((s) => s.revert)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  const path = home ? KEYBINDINGS_SCOPES.resolve('user', home, null) : null

  useEffect(() => {
    if (!path) return
    if (!files[path]) loadJson(path)
    watchFile(path)
    return () => unwatchFile(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  const [view, setView] = useState<View>('controls')
  const [context, setContext] = useState<string>('Global')
  const [capture, setCapture] = useState<Capture>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const focused = usePanelFocus()

  const file = path ? files[path] : undefined
  const raw = file?.draftRaw ?? ''

  // Parsed doc, or null when the draft has malformed JSON (JSON view only).
  const doc: KeybindingsDoc | null = useMemo(() => {
    try { return parseDoc(raw) } catch { return null }
  }, [raw])

  const activePreset = useMemo(() => (doc ? detectPreset(doc) : null), [doc])

  const applyDoc = (next: KeybindingsDoc) => {
    if (!path) return
    setSaveError(null)
    setDraft(path, serializeDoc(next))
  }

  // ── Key capture: one global keydown listener while a capture is armed ──────
  // Gated at attach site (not just an in-handler check): an unfocused
  // mounted Keybindings panel — now possible since dockview keeps
  // background panels mounted — must swallow zero keys, and this capture
  // handler preventDefault+stopPropagation()s on EVERY keydown while armed.
  // Deriving `focused` skips attaching entirely, and detaches immediately
  // if focus moves away mid-capture.
  useEffect(() => {
    if (!capture || !doc || !focused) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      // Only an unmodified Escape cancels — ctrl+escape etc. are capturable.
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setCapture(null)
        return
      }
      const pattern = eventToPattern(e)
      if (!pattern) {
        if (e.metaKey && !['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
          toast.info("Cmd/meta combos can't be bound — Claude Code runs in a terminal.")
        }
        return // modifier-only or meta — keep listening
      }
      if (RESERVED_PATTERNS.has(pattern)) {
        toast.warn(`${pattern} is reserved by Claude Code and cannot be rebound.`)
        return
      }
      const block = blockFor(doc, context)
      const prev = block[pattern]
      const value = capture.kind === 'bind' ? capture.action : null
      if (prev !== undefined && prev !== value) {
        toast.info(`${pattern} was bound to ${prev ?? 'disabled'} — replaced.`)
      }
      applyDoc(withBinding(doc, context, pattern, value))
      setCapture(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture, doc, context, path, focused])

  if (!home || !path) return <EmptyState title="loading…" />

  return (
    <Panel
      toolbar={
        <>
          <span className="text-fg-faint truncate">{path}</span>
          <div className="flex-1" />
          <ViewTabs
            options={[{ key: 'controls', label: 'Controls' }, { key: 'json', label: 'JSON' }]}
            active={view}
            onChange={(v) => { setCapture(null); setView(v) }}
          />
          <a
            href="https://code.claude.com/docs/en/keybindings"
            target="_blank"
            rel="noreferrer"
            className="ml-3 text-fg-faint hover:text-fg-dim underline-offset-2 hover:underline"
          >
            reference ↗
          </a>
        </>
      }
      footer={
        file ? (
          <SaveBar
            dirty={file.dirty}
            busy={file.busy}
            parseError={saveError || file.parseError}
            lastSavedAt={file.lastSavedAt}
            leading={
              file.exists ? (
                <span>restart Claude Code to apply changes</span>
              ) : (
                <span>file will be created on save</span>
              )
            }
            onSave={async () => {
              setSaveError(null)
              const res = await saveJson(path)
              if (!res.ok) setSaveError(res.error ?? 'save failed')
            }}
            onRevert={() => { setSaveError(null); setCapture(null); revert(path) }}
          />
        ) : null
      }
    >
      {!file ? (
        <EmptyState title="loading…" />
      ) : view === 'json' ? (
        <JsonEditor
          path={path}
          value={file.draftRaw === '' && !file.exists ? DEFAULT_TEMPLATE : file.draftRaw}
          onChange={(v) => { setSaveError(null); setDraft(path, v) }}
        />
      ) : doc === null ? (
        <EmptyState
          title="keybindings.json has invalid JSON"
          hint="Fix it in the JSON view, then come back to the visual editor."
        />
      ) : (
        <div className="h-full flex flex-col">
          <PresetStrip activePreset={activePreset} onApply={(d) => { setCapture(null); applyDoc(d) }} />
          <div className="flex-1 min-h-0">
            <ListDetail
              sidebarWidth="15rem"
              sidebar={
                <ContextList
                  doc={doc}
                  selected={context}
                  onSelect={(c) => { setCapture(null); setContext(c) }}
                />
              }
              detail={
                <ContextPane
                  doc={doc}
                  context={context}
                  capture={capture}
                  onCapture={setCapture}
                  onRemove={(pattern) => applyDoc(withBinding(doc, context, pattern, undefined))}
                />
              }
            />
          </div>
        </div>
      )}
    </Panel>
  )
}

// ─── Preset strip ─────────────────────────────────────────────────────────────

function PresetStrip({
  activePreset,
  onApply,
}: {
  activePreset: string | null
  onApply: (doc: KeybindingsDoc) => void
}) {
  return (
    <div className="shrink-0 border-b border-line px-4 py-3">
      <div className="text-[10.5px] uppercase tracking-wider text-fg-faint font-semibold mb-2">
        Presets
        {activePreset === null && (
          <span className="ml-2 normal-case tracking-normal font-normal italic">— custom layout</span>
        )}
      </div>
      <div className="flex gap-2.5 flex-wrap">
        {PRESETS.map((p) => {
          const active = activePreset === p.id
          return (
            <button
              key={p.id}
              onClick={() => onApply(structuredClone(p.doc))}
              className={`text-left rounded-md border px-3 py-2 w-60 transition-colors ${
                active
                  ? 'border-accent/60 bg-accent/10'
                  : 'border-line bg-bg-elev hover:border-accent/30 hover:bg-bg-hi'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`text-xs font-semibold ${active ? 'text-accent' : 'text-fg'}`}>
                  {p.name}
                </span>
                {active && (
                  <span className="text-[10px] px-1.5 py-px rounded-full border border-accent/40 text-accent">
                    active
                  </span>
                )}
              </div>
              <div className="text-[11px] text-fg-dim mt-0.5 leading-snug">{p.tagline}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── Context sidebar ──────────────────────────────────────────────────────────

function ContextList({
  doc,
  selected,
  onSelect,
}: {
  doc: KeybindingsDoc
  selected: string
  onSelect: (c: string) => void
}) {
  // Schema contexts first; any unknown context found in the file appended so
  // nothing in the file is invisible.
  const extras = doc.bindings.map((b) => b.context).filter((c) => !CONTEXTS.includes(c))
  const all = [...CONTEXTS, ...new Set(extras)]
  return (
    <div className="py-1">
      {all.map((c) => {
        const count = Object.keys(blockFor(doc, c)).length
        return (
          <button
            key={c}
            onClick={() => onSelect(c)}
            className={`w-full px-3 py-1.5 text-left transition-colors ${
              selected === c ? 'bg-bg-hi' : 'hover:bg-bg-hi/50'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`text-xs ${selected === c ? 'text-fg' : 'text-fg-dim'}`}>{c}</span>
              {count > 0 && (
                <span className="ml-auto text-[10px] px-1.5 rounded-full bg-accent/15 text-accent font-mono">
                  {count}
                </span>
              )}
            </div>
            <div className="text-[10.5px] text-fg-faint truncate">{CONTEXT_HINT[c] ?? ''}</div>
          </button>
        )
      })}
    </div>
  )
}

// ─── Action rows for one context ──────────────────────────────────────────────

function ContextPane({
  doc,
  context,
  capture,
  onCapture,
  onRemove,
}: {
  doc: KeybindingsDoc
  context: string
  capture: Capture
  onCapture: (c: Capture) => void
  onRemove: (pattern: string) => void
}) {
  const block = blockFor(doc, context)
  const entries = Object.entries(block)
  const actions = actionsForContext(context)

  const disabled = entries.filter(([, v]) => v === null).map(([p]) => p)
  const commands = entries.filter(([, v]) => typeof v === 'string' && v.startsWith('command:'))
  const unknown = entries.filter(
    ([, v]) => typeof v === 'string' && !v.startsWith('command:') && !actions.includes(v),
  )

  return (
    <div className="p-4 flex flex-col gap-5 max-w-3xl">
      {/* Built-in actions */}
      <div className="flex flex-col">
        {actions.map((action) => {
          const bound = entries.filter(([, v]) => v === action).map(([p]) => p)
          const capturing = capture?.kind === 'bind' && capture.action === action
          return (
            <div
              key={action}
              className="flex items-center gap-3 py-1.5 border-b border-line/50 last:border-0"
            >
              <div className="flex-1 min-w-0">
                <span className="text-xs text-fg">{actionLabel(action)}</span>
                <span className="ml-2 text-[10.5px] font-mono text-fg-faint">{action}</span>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap justify-end">
                {bound.length === 0 && !capturing && (
                  <span className="text-[10.5px] text-fg-faint italic">default</span>
                )}
                {bound.map((p) => (
                  <Keycap key={p} pattern={p} onRemove={() => onRemove(p)} />
                ))}
                {capturing ? (
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded border border-accent text-accent animate-pulse">
                    press keys… (esc cancels)
                  </span>
                ) : (
                  <button
                    onClick={() => onCapture({ kind: 'bind', action })}
                    className="text-[11px] px-1.5 py-0.5 rounded border border-line text-fg-dim hover:text-fg hover:border-accent/40 transition-colors"
                    title="Bind a key to this action"
                  >
                    + bind
                  </button>
                )}
              </div>
            </div>
          )
        })}
        {actions.length === 0 && (
          <span className="text-xs text-fg-faint italic">no built-in actions for this context</span>
        )}
      </div>

      {/* Disabled default keys */}
      <div>
        <div className="text-[10.5px] uppercase tracking-wider text-fg-faint font-semibold mb-1.5">
          Disabled default keys
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {disabled.map((p) => (
            <Keycap key={p} pattern={p} tone="muted" onRemove={() => onRemove(p)} removeTitle="Re-enable default" />
          ))}
          {capture?.kind === 'disable' ? (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded border border-accent text-accent animate-pulse">
              press the key to disable… (esc cancels)
            </span>
          ) : (
            <button
              onClick={() => onCapture({ kind: 'disable' })}
              className="text-[11px] px-1.5 py-0.5 rounded border border-line text-fg-dim hover:text-fg hover:border-accent/40 transition-colors"
              title="Press a key to disable its Claude Code default in this context"
            >
              + disable a key
            </button>
          )}
        </div>
      </div>

      {/* Slash-command + unrecognized bindings (from the JSON view) */}
      {(commands.length > 0 || unknown.length > 0) && (
        <div>
          <div className="text-[10.5px] uppercase tracking-wider text-fg-faint font-semibold mb-1.5">
            Command & other bindings
          </div>
          {[...commands, ...unknown].map(([p, v]) => (
            <div key={p} className="flex items-center gap-2 py-1">
              <Keycap pattern={p} onRemove={() => onRemove(p)} />
              <span className="text-[11px] font-mono text-fg-dim truncate">{v}</span>
            </div>
          ))}
          <p className="text-[10.5px] text-fg-faint mt-1">edit these in the JSON view</p>
        </div>
      )}
    </div>
  )
}

// ─── Keycap chip ──────────────────────────────────────────────────────────────

function Keycap({
  pattern,
  tone = 'normal',
  onRemove,
  removeTitle = 'Remove binding (revert to default)',
}: {
  pattern: string
  tone?: 'normal' | 'muted'
  onRemove: () => void
  removeTitle?: string
}) {
  return (
    <span
      className={`group inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded border shadow-sm ${
        tone === 'muted'
          ? 'border-line text-fg-faint bg-bg-elev line-through'
          : 'border-line text-fg bg-bg-hi'
      }`}
    >
      {prettyPattern(pattern).join(', ')}
      <button
        onClick={onRemove}
        title={removeTitle}
        className="opacity-40 group-hover:opacity-100 hover:text-red-400 transition-opacity"
      >
        ✕
      </button>
    </span>
  )
}
