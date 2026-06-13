/**
 * Keybindings model for the game-style Keybindings tab.
 *
 * Mirrors the official schema (json.schemastore.org/claude-code-keybindings.json):
 *   { bindings: [{ context, bindings: { "ctrl+k": "action" | "command:x" | null } }] }
 *
 * `null` disables a default shortcut. `command:<slug>` fires a slash command.
 * Reserved keystrokes that Claude Code refuses to rebind: ctrl+c, ctrl+d, ctrl+m.
 */

export type BindingValue = string | null

export interface KeyBlock {
  context: string
  bindings: Record<string, BindingValue>
}

export interface KeybindingsDoc {
  $schema?: string
  bindings: KeyBlock[]
}

export const SCHEMA_URL = 'https://json.schemastore.org/claude-code-keybindings.json'

export const RESERVED_PATTERNS = new Set(['ctrl+c', 'ctrl+d', 'ctrl+m'])

// ── Action catalog ────────────────────────────────────────────────────────────
// Built-in actions from the published schema, grouped under the context where
// they apply. Action ids are `namespace:name`; the namespace decides the group.

const CATALOG: ReadonlyArray<[context: string, actions: string[]]> = [
  ['Global', [
    'app:interrupt', 'app:exit', 'app:redraw', 'app:toggleTodos',
    'app:toggleTranscript', 'app:toggleTeammatePreview',
    'voice:pushToTalk', 'permission:toggleDebug',
  ]],
  ['Chat', [
    'chat:submit', 'chat:newline', 'chat:cancel', 'chat:clearInput',
    'chat:clearScreen', 'chat:undo', 'chat:stash', 'chat:externalEditor',
    'chat:imagePaste', 'chat:cycleMode', 'chat:modelPicker', 'chat:fastMode',
    'chat:thinkingToggle', 'chat:killAgents',
    'history:search', 'history:previous', 'history:next',
  ]],
  ['Autocomplete', [
    'autocomplete:accept', 'autocomplete:dismiss',
    'autocomplete:previous', 'autocomplete:next',
  ]],
  ['Confirmation', [
    'confirm:yes', 'confirm:no', 'confirm:previous', 'confirm:next',
    'confirm:nextField', 'confirm:previousField', 'confirm:toggle',
    'confirm:cycleMode', 'confirm:toggleExplanation',
  ]],
  ['Select', [
    'select:next', 'select:previous', 'select:accept', 'select:cancel',
    'select:pageUp', 'select:pageDown', 'select:first', 'select:last',
  ]],
  ['Scroll', [
    'scroll:lineUp', 'scroll:lineDown', 'scroll:pageUp', 'scroll:pageDown',
    'scroll:halfPageUp', 'scroll:halfPageDown', 'scroll:fullPageUp',
    'scroll:fullPageDown', 'scroll:top', 'scroll:bottom',
    'selection:copy', 'selection:clear', 'selection:extendLeft',
    'selection:extendRight', 'selection:extendUp', 'selection:extendDown',
    'selection:extendLineStart', 'selection:extendLineEnd',
  ]],
  ['Tabs', ['tabs:next', 'tabs:previous']],
  ['Transcript', ['transcript:toggleShowAll', 'transcript:exit']],
  ['HistorySearch', [
    'historySearch:next', 'historySearch:accept', 'historySearch:cancel',
    'historySearch:execute', 'historySearch:cycleScope',
  ]],
  ['MessageSelector', [
    'messageSelector:up', 'messageSelector:down', 'messageSelector:top',
    'messageSelector:bottom', 'messageSelector:select',
  ]],
  ['DiffDialog', [
    'diff:dismiss', 'diff:back', 'diff:viewDetails',
    'diff:previousSource', 'diff:nextSource', 'diff:previousFile', 'diff:nextFile',
  ]],
  ['ModelPicker', [
    'modelPicker:decreaseEffort', 'modelPicker:increaseEffort',
    'modelPicker:thisSessionOnly',
  ]],
  ['Attachments', [
    'attachments:next', 'attachments:previous', 'attachments:remove', 'attachments:exit',
  ]],
  ['Footer', [
    'footer:next', 'footer:previous', 'footer:up', 'footer:down',
    'footer:openSelected', 'footer:clearSelection', 'footer:close',
  ]],
  ['Task', ['task:background']],
  ['Settings', [
    'settings:search', 'settings:retry', 'settings:close',
    'settings:periodDay', 'settings:periodWeek', 'settings:sortByTokens',
  ]],
  ['ThemePicker', ['theme:toggleSyntaxHighlighting', 'theme:editCustom']],
  ['Plugin', ['plugin:toggle', 'plugin:install', 'plugin:favorite']],
  ['Help', ['help:dismiss']],
  ['Doctor', ['doctor:fix']],
]

export const CONTEXTS: ReadonlyArray<string> = CATALOG.map(([c]) => c)

export function actionsForContext(context: string): string[] {
  return CATALOG.find(([c]) => c === context)?.[1] ?? []
}

/** Friendly hint shown under each context in the sidebar. */
export const CONTEXT_HINT: Record<string, string> = {
  Global: 'always active, anywhere in the app',
  Chat: 'the prompt input line',
  Autocomplete: 'file / command completion popup',
  Confirmation: 'permission + confirmation dialogs',
  Select: 'list pickers (sessions, options…)',
  Scroll: 'scrollback + text selection mode',
  Tabs: 'session tab strip',
  Transcript: 'transcript viewer',
  HistorySearch: 'reverse history search',
  MessageSelector: 'jump-to-message picker',
  DiffDialog: 'diff review dialog',
  ModelPicker: 'model / effort picker',
  Attachments: 'attachment strip',
  Footer: 'footer link bar',
  Task: 'running task view',
  Settings: 'settings / usage screen',
  ThemePicker: 'theme picker',
  Plugin: 'plugin browser',
  Help: 'help overlay',
  Doctor: 'doctor diagnostics',
}

/** "chat:externalEditor" → "External editor" */
export function actionLabel(action: string): string {
  const name = action.split(':')[1] ?? action
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// ── Parse / serialize ─────────────────────────────────────────────────────────

/** Parse raw file text into a doc. Throws on malformed JSON or wrong shape. */
export function parseDoc(raw: string): KeybindingsDoc {
  if (raw.trim() === '') return { $schema: SCHEMA_URL, bindings: [] }
  const json = JSON.parse(raw)
  if (typeof json !== 'object' || json === null || !Array.isArray(json.bindings)) {
    throw new Error('expected { "bindings": [...] }')
  }
  const blocks: KeyBlock[] = []
  for (const b of json.bindings) {
    if (typeof b?.context !== 'string' || typeof b?.bindings !== 'object' || b.bindings === null) {
      throw new Error('each bindings entry needs { context, bindings }')
    }
    // Merge duplicate-context blocks: later entries win (JSON-order semantics),
    // so every binding is visible to blockFor/withBinding and edits can't
    // leave conflicting blocks behind.
    const existing = blocks.find((x) => x.context === b.context)
    if (existing) Object.assign(existing.bindings, b.bindings)
    else blocks.push({ context: b.context, bindings: { ...b.bindings } })
  }
  return { $schema: typeof json.$schema === 'string' ? json.$schema : SCHEMA_URL, bindings: blocks }
}

/** Serialize with stable context order (schema order, unknown contexts last). */
export function serializeDoc(doc: KeybindingsDoc): string {
  const order = (c: string) => {
    const i = CONTEXTS.indexOf(c)
    return i < 0 ? CONTEXTS.length : i
  }
  const blocks = [...doc.bindings]
    .filter((b) => Object.keys(b.bindings).length > 0)
    .sort((a, b) => order(a.context) - order(b.context))
  return JSON.stringify({ $schema: doc.$schema ?? SCHEMA_URL, bindings: blocks }, null, 2) + '\n'
}

/** Pure update: set (or delete, with value === undefined) one pattern in one context. */
export function withBinding(
  doc: KeybindingsDoc,
  context: string,
  pattern: string,
  value: BindingValue | undefined,
): KeybindingsDoc {
  const blocks = doc.bindings.map((b) => ({ ...b, bindings: { ...b.bindings } }))
  let block = blocks.find((b) => b.context === context)
  if (!block) {
    if (value === undefined) return doc
    block = { context, bindings: {} }
    blocks.push(block)
  }
  if (value === undefined) delete block.bindings[pattern]
  else block.bindings[pattern] = value
  return { ...doc, bindings: blocks }
}

export function blockFor(doc: KeybindingsDoc, context: string): Record<string, BindingValue> {
  return doc.bindings.find((b) => b.context === context)?.bindings ?? {}
}

// ── Key capture ───────────────────────────────────────────────────────────────

const NAMED_KEYS: Record<string, string> = {
  ' ': 'space', Enter: 'enter', Tab: 'tab', Backspace: 'backspace',
  Delete: 'delete', Escape: 'escape', ArrowUp: 'up', ArrowDown: 'down',
  ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', End: 'end',
  PageUp: 'pageup', PageDown: 'pagedown', Insert: 'insert',
}

/**
 * Convert a captured KeyboardEvent into a keystroke pattern ("ctrl+shift+k").
 * Returns null for modifier-only presses (keep listening). Meta/cmd is not
 * representable in a terminal app, so meta-modified presses are ignored too.
 */
export function eventToPattern(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null
  if (e.metaKey) return null

  let base: string
  if (NAMED_KEYS[e.key]) base = NAMED_KEYS[e.key]
  else if (/^F\d{1,2}$/.test(e.key)) base = e.key.toLowerCase()
  else if (e.key.length === 1) base = e.key.toLowerCase()
  else return null

  const mods: string[] = []
  if (e.ctrlKey) mods.push('ctrl')
  if (e.altKey) mods.push('alt')
  // Shift is only meaningful alongside letters / named keys; shifted
  // punctuation already arrives as the shifted character itself.
  if (e.shiftKey && (/^[a-z]$/.test(base) || base.length > 1)) mods.push('shift')

  return [...mods, base].join('+')
}

/** "ctrl+shift+k" → "Ctrl + Shift + K" for keycap display. */
export function prettyPattern(pattern: string): string[] {
  return pattern.split(' ').map((stroke) =>
    stroke
      .split('+')
      .map((part) => (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(' + '),
  )
}

// ── Presets ───────────────────────────────────────────────────────────────────

export interface Preset {
  id: string
  name: string
  tagline: string
  doc: KeybindingsDoc
}

export const PRESETS: ReadonlyArray<Preset> = [
  {
    id: 'defaults',
    name: 'Claude defaults',
    tagline: 'No overrides — ship with the stock Claude Code bindings.',
    doc: { $schema: SCHEMA_URL, bindings: [] },
  },
  {
    id: 'vim',
    name: 'Vim motion',
    tagline: 'j/k everywhere it is safe — scrollback, pickers, message jump.',
    doc: {
      $schema: SCHEMA_URL,
      bindings: [
        { context: 'Scroll', bindings: {
          j: 'scroll:lineDown', k: 'scroll:lineUp',
          d: 'scroll:halfPageDown', u: 'scroll:halfPageUp',
          g: 'scroll:top', 'shift+g': 'scroll:bottom',
        } },
        { context: 'Select', bindings: {
          'ctrl+j': 'select:next', 'ctrl+k': 'select:previous',
        } },
        { context: 'MessageSelector', bindings: {
          j: 'messageSelector:down', k: 'messageSelector:up',
          g: 'messageSelector:top', 'shift+g': 'messageSelector:bottom',
        } },
      ],
    },
  },
  {
    id: 'emacs',
    name: 'Emacs flow',
    tagline: 'C-n/C-p in pickers, C-g to bail out, C-v / M-v paging.',
    doc: {
      $schema: SCHEMA_URL,
      bindings: [
        { context: 'Select', bindings: {
          'ctrl+n': 'select:next', 'ctrl+p': 'select:previous', 'ctrl+g': 'select:cancel',
        } },
        { context: 'Chat', bindings: { 'ctrl+g': 'chat:cancel' } },
        { context: 'Scroll', bindings: {
          'ctrl+v': 'scroll:pageDown', 'alt+v': 'scroll:pageUp',
        } },
      ],
    },
  },
]

/** Normalize-compare a doc against each preset; returns the matching id or null. */
export function detectPreset(doc: KeybindingsDoc): string | null {
  const canon = (d: KeybindingsDoc) =>
    JSON.stringify(
      [...d.bindings]
        .filter((b) => Object.keys(b.bindings).length > 0)
        .map((b) => [b.context, Object.entries(b.bindings).sort(([a], [z]) => a.localeCompare(z))])
        .sort(([a], [z]) => String(a).localeCompare(String(z))),
    )
  const mine = canon(doc)
  return PRESETS.find((p) => canon(p.doc) === mine)?.id ?? null
}
