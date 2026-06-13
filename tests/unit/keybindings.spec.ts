/**
 * Keybindings model — parse/serialize round-trip + capture/preset logic.
 *
 * The Keybindings tab writes back to ~/.claude/keybindings.json, so any
 * serializer regression silently corrupts a user's shortcuts. This spec locks
 * in: round-trip fidelity, the duplicate-context merge, withBinding immutability
 * and delete semantics, key-event → pattern conversion edge cases, and preset
 * detection.
 *
 * Source: src/renderer/lib/keybindings.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  parseDoc,
  serializeDoc,
  withBinding,
  blockFor,
  eventToPattern,
  prettyPattern,
  detectPreset,
  PRESETS,
  SCHEMA_URL,
  type KeybindingsDoc,
} from '../../src/renderer/lib/keybindings'

/** Minimal KeyboardEvent stand-in — eventToPattern only reads these fields. */
function key(k: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}): KeyboardEvent {
  return { key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods } as KeyboardEvent
}

describe('parseDoc', () => {
  it('empty / whitespace input → empty doc with schema', () => {
    expect(parseDoc('')).toEqual({ $schema: SCHEMA_URL, bindings: [] })
    expect(parseDoc('   \n ')).toEqual({ $schema: SCHEMA_URL, bindings: [] })
  })

  it('throws on malformed JSON', () => {
    expect(() => parseDoc('{not json')).toThrow()
  })

  it('throws on wrong top-level shape', () => {
    expect(() => parseDoc('{"foo": 1}')).toThrow(/bindings/)
    expect(() => parseDoc('[]')).toThrow(/bindings/)
  })

  it('throws when a block lacks context or bindings', () => {
    expect(() => parseDoc('{"bindings":[{"context":"Chat"}]}')).toThrow(/context, bindings/)
    expect(() => parseDoc('{"bindings":[{"bindings":{}}]}')).toThrow(/context, bindings/)
  })

  it('merges duplicate-context blocks, later entries winning', () => {
    const raw = JSON.stringify({
      bindings: [
        { context: 'Scroll', bindings: { j: 'scroll:lineDown', k: 'scroll:lineUp' } },
        { context: 'Scroll', bindings: { k: 'scroll:halfPageUp', g: 'scroll:top' } },
      ],
    })
    const doc = parseDoc(raw)
    expect(doc.bindings).toHaveLength(1)
    expect(doc.bindings[0].bindings).toEqual({
      j: 'scroll:lineDown',
      k: 'scroll:halfPageUp', // later block wins
      g: 'scroll:top',
    })
  })

  it('preserves a null binding (disabled default) and a custom $schema', () => {
    const doc = parseDoc('{"$schema":"x","bindings":[{"context":"Chat","bindings":{"ctrl+u":null}}]}')
    expect(doc.$schema).toBe('x')
    expect(doc.bindings[0].bindings['ctrl+u']).toBeNull()
  })
})

describe('serializeDoc', () => {
  it('round-trips a parsed doc', () => {
    const raw = JSON.stringify({
      $schema: SCHEMA_URL,
      bindings: [{ context: 'Chat', bindings: { 'ctrl+k': 'chat:clearScreen', 'ctrl+u': null } }],
    })
    expect(parseDoc(serializeDoc(parseDoc(raw)))).toEqual(parseDoc(raw))
  })

  it('sorts blocks into schema-context order, unknown contexts last', () => {
    const doc: KeybindingsDoc = {
      bindings: [
        { context: 'Zzz-custom', bindings: { a: 'x:y' } },
        { context: 'Chat', bindings: { 'ctrl+k': 'chat:clearScreen' } },
        { context: 'Global', bindings: { 'ctrl+r': 'app:redraw' } },
      ],
    }
    const out = JSON.parse(serializeDoc(doc))
    expect(out.bindings.map((b: { context: string }) => b.context)).toEqual(['Global', 'Chat', 'Zzz-custom'])
  })

  it('drops empty blocks and ends with a trailing newline', () => {
    const doc: KeybindingsDoc = {
      bindings: [
        { context: 'Chat', bindings: {} },
        { context: 'Global', bindings: { 'ctrl+r': 'app:redraw' } },
      ],
    }
    const text = serializeDoc(doc)
    expect(text.endsWith('\n')).toBe(true)
    const out = JSON.parse(text)
    expect(out.bindings).toHaveLength(1)
    expect(out.bindings[0].context).toBe('Global')
  })
})

describe('withBinding', () => {
  const base: KeybindingsDoc = { bindings: [{ context: 'Chat', bindings: { 'ctrl+k': 'chat:clearScreen' } }] }

  it('sets a binding without mutating the input doc', () => {
    const next = withBinding(base, 'Chat', 'ctrl+u', 'chat:clearInput')
    expect(next.bindings[0].bindings).toEqual({ 'ctrl+k': 'chat:clearScreen', 'ctrl+u': 'chat:clearInput' })
    expect(base.bindings[0].bindings).toEqual({ 'ctrl+k': 'chat:clearScreen' }) // unchanged
  })

  it('creates a new context block when absent', () => {
    const next = withBinding(base, 'Scroll', 'j', 'scroll:lineDown')
    expect(blockFor(next, 'Scroll')).toEqual({ j: 'scroll:lineDown' })
  })

  it('deletes a binding when value is undefined', () => {
    const next = withBinding(base, 'Chat', 'ctrl+k', undefined)
    expect(blockFor(next, 'Chat')).toEqual({})
  })

  it('is a no-op when deleting from an absent context', () => {
    const next = withBinding(base, 'Scroll', 'j', undefined)
    expect(next).toBe(base)
  })
})

describe('eventToPattern', () => {
  it('returns null for modifier-only presses', () => {
    for (const k of ['Control', 'Shift', 'Alt', 'Meta']) expect(eventToPattern(key(k))).toBeNull()
  })

  it('ignores meta/cmd-modified presses (not representable in a terminal)', () => {
    expect(eventToPattern(key('k', { metaKey: true }))).toBeNull()
  })

  it('builds ctrl/alt/shift combos in canonical order', () => {
    expect(eventToPattern(key('k', { ctrlKey: true }))).toBe('ctrl+k')
    expect(eventToPattern(key('K', { ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+k')
    expect(eventToPattern(key('v', { altKey: true }))).toBe('alt+v')
  })

  it('maps named keys and function keys', () => {
    expect(eventToPattern(key('Enter'))).toBe('enter')
    expect(eventToPattern(key('ArrowUp', { ctrlKey: true }))).toBe('ctrl+up')
    expect(eventToPattern(key(' '))).toBe('space')
    expect(eventToPattern(key('F5'))).toBe('f5')
  })

  it('does not attach shift to already-shifted punctuation', () => {
    // "?" arrives as its shifted character; shift must not be re-added.
    expect(eventToPattern(key('?', { shiftKey: true }))).toBe('?')
  })

  it('returns null for unhandled long key names', () => {
    expect(eventToPattern(key('AudioVolumeUp'))).toBeNull()
  })
})

describe('prettyPattern', () => {
  it('humanizes a single stroke', () => {
    expect(prettyPattern('ctrl+shift+k')).toEqual(['Ctrl + Shift + K'])
  })
  it('splits a chord into multiple strokes', () => {
    expect(prettyPattern('ctrl+k ctrl+s')).toEqual(['Ctrl + K', 'Ctrl + S'])
  })
})

describe('detectPreset', () => {
  it('identifies each built-in preset from its own doc', () => {
    for (const p of PRESETS) expect(detectPreset(p.doc)).toBe(p.id)
  })

  it('is order-insensitive (matches vim regardless of block/key order)', () => {
    const vim = PRESETS.find((p) => p.id === 'vim')!
    const shuffled: KeybindingsDoc = {
      $schema: SCHEMA_URL,
      bindings: [...vim.doc.bindings].reverse().map((b) => ({
        context: b.context,
        bindings: Object.fromEntries(Object.entries(b.bindings).reverse()),
      })),
    }
    expect(detectPreset(shuffled)).toBe('vim')
  })

  it('returns null for a doc that matches no preset', () => {
    expect(detectPreset({ bindings: [{ context: 'Chat', bindings: { 'ctrl+z': 'chat:undo' } }] })).toBeNull()
  })
})
