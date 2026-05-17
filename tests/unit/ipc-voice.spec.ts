import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { schemas } = require('../../src/main/ipcSchemas.cjs') as {
  schemas: Record<string, { safeParse: (v: unknown) => { success: boolean } }>
}

// ──────────────────────────────────────────── voice:set-hotkey
// VOICE_ACCELERATOR_RE enforces modifier+key pairs. Malformed accelerators
// get silently ignored by Electron's globalShortcut but would never register —
// the schema catches them at the IPC boundary instead.

describe('voiceSetHotkey schema', () => {
  it('accepts Control+Space', () => {
    expect(schemas.voiceSetHotkey.safeParse({
      accelerator: 'Control+Space', mode: 'hold', global: true,
    }).success).toBe(true)
  })

  it('accepts CommandOrControl+Shift+V', () => {
    expect(schemas.voiceSetHotkey.safeParse({
      accelerator: 'CommandOrControl+Shift+V', mode: 'toggle', global: false,
    }).success).toBe(true)
  })

  it('accepts Alt+F1', () => {
    expect(schemas.voiceSetHotkey.safeParse({
      accelerator: 'Alt+F1', mode: 'hold', global: false,
    }).success).toBe(true)
  })

  it('accepts with optional schemaVersion', () => {
    expect(schemas.voiceSetHotkey.safeParse({
      accelerator: 'Ctrl+Space', mode: 'hold', global: true, schemaVersion: 1,
    }).success).toBe(true)
  })

  it('rejects missing accelerator', () => {
    expect(schemas.voiceSetHotkey.safeParse({ mode: 'hold', global: true }).success).toBe(false)
  })

  it('rejects empty accelerator string', () => {
    expect(schemas.voiceSetHotkey.safeParse({ accelerator: '', mode: 'hold', global: true }).success).toBe(false)
  })

  it('rejects plain key with no modifier (e.g. Space alone)', () => {
    expect(schemas.voiceSetHotkey.safeParse({ accelerator: 'Space', mode: 'hold', global: true }).success).toBe(false)
  })

  it('rejects invalid mode value', () => {
    expect(schemas.voiceSetHotkey.safeParse({
      accelerator: 'Ctrl+Space', mode: 'push-to-talk', global: true,
    }).success).toBe(false)
  })

  it('rejects non-boolean global', () => {
    expect(schemas.voiceSetHotkey.safeParse({
      accelerator: 'Ctrl+Space', mode: 'hold', global: 'yes',
    }).success).toBe(false)
  })

  it('rejects missing mode', () => {
    expect(schemas.voiceSetHotkey.safeParse({ accelerator: 'Ctrl+Space', global: true }).success).toBe(false)
  })

  it('allows passthrough of extra fields', () => {
    // voiceSetHotkey uses .passthrough() — extra keys should not reject
    expect(schemas.voiceSetHotkey.safeParse({
      accelerator: 'Ctrl+Space', mode: 'hold', global: true, extra: 'ok',
    }).success).toBe(true)
  })
})

// ──────────────────────────────────────────── voice:set-device-pref
describe('voiceSetDevicePref schema', () => {
  it('accepts null selectedDeviceId (unset preference)', () => {
    expect(schemas.voiceSetDevicePref.safeParse({
      selectedDeviceId: null, selectedLabel: null,
    }).success).toBe(true)
  })

  it('accepts valid device id and label', () => {
    expect(schemas.voiceSetDevicePref.safeParse({
      selectedDeviceId: 'default', selectedLabel: 'Built-in Microphone',
    }).success).toBe(true)
  })

  it('accepts device id at max length (256 chars)', () => {
    expect(schemas.voiceSetDevicePref.safeParse({
      selectedDeviceId: 'a'.repeat(256), selectedLabel: null,
    }).success).toBe(true)
  })

  it('rejects device id exceeding 256 chars', () => {
    expect(schemas.voiceSetDevicePref.safeParse({
      selectedDeviceId: 'a'.repeat(257), selectedLabel: null,
    }).success).toBe(false)
  })

  it('rejects label exceeding 256 chars', () => {
    expect(schemas.voiceSetDevicePref.safeParse({
      selectedDeviceId: null, selectedLabel: 'x'.repeat(257),
    }).success).toBe(false)
  })

  it('rejects missing selectedDeviceId', () => {
    expect(schemas.voiceSetDevicePref.safeParse({ selectedLabel: null }).success).toBe(false)
  })

  it('rejects missing selectedLabel', () => {
    expect(schemas.voiceSetDevicePref.safeParse({ selectedDeviceId: null }).success).toBe(false)
  })

  it('allows passthrough of extra fields (schemaVersion)', () => {
    expect(schemas.voiceSetDevicePref.safeParse({
      selectedDeviceId: null, selectedLabel: null, schemaVersion: 1,
    }).success).toBe(true)
  })
})

// ──────────────────────────────────────────── voice:set-turn-detector
describe('voiceSetTurnDetector schema', () => {
  it('accepts enabled=false, mode=off', () => {
    expect(schemas.voiceSetTurnDetector.safeParse({ enabled: false, mode: 'off' }).success).toBe(true)
  })

  it('accepts enabled=true, mode=audio', () => {
    expect(schemas.voiceSetTurnDetector.safeParse({ enabled: true, mode: 'audio' }).success).toBe(true)
  })

  it('accepts mode=text', () => {
    expect(schemas.voiceSetTurnDetector.safeParse({ enabled: false, mode: 'text' }).success).toBe(true)
  })

  it('rejects invalid mode', () => {
    expect(schemas.voiceSetTurnDetector.safeParse({ enabled: true, mode: 'magic' }).success).toBe(false)
  })

  it('rejects non-boolean enabled', () => {
    expect(schemas.voiceSetTurnDetector.safeParse({ enabled: 1, mode: 'off' }).success).toBe(false)
  })

  it('rejects missing enabled', () => {
    expect(schemas.voiceSetTurnDetector.safeParse({ mode: 'off' }).success).toBe(false)
  })

  it('rejects missing mode', () => {
    expect(schemas.voiceSetTurnDetector.safeParse({ enabled: false }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── voice:set-recording
describe('voiceSetRecording schema', () => {
  it('accepts true', () => {
    expect(schemas.voiceSetRecording.safeParse(true).success).toBe(true)
  })

  it('accepts false', () => {
    expect(schemas.voiceSetRecording.safeParse(false).success).toBe(true)
  })

  it('rejects string', () => {
    expect(schemas.voiceSetRecording.safeParse('true').success).toBe(false)
  })

  it('rejects number', () => {
    expect(schemas.voiceSetRecording.safeParse(1).success).toBe(false)
  })

  it('rejects null', () => {
    expect(schemas.voiceSetRecording.safeParse(null).success).toBe(false)
  })
})
