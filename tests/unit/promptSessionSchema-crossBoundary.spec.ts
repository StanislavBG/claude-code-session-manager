/**
 * Cross-boundary regression test for PRD 953 (dependent on PRD 952's
 * canonical PromptSessionSchema, src/main/lib/promptSessionSchema.cjs).
 *
 * Historically two independently hand-built PromptSession object literals
 * existed: the main-process mint path (epicMint.cjs's ensureEpic) and the
 * renderer's own construction path (createPromptSession's buildPromptSession,
 * state/promptSessions.ts). PRD 955 (commit ba54269) retired the renderer-side
 * construction entirely — createPromptSession now calls main's ensureEpic over IPC
 * (window.api.promptSessions.create) instead of hand-building the object, so
 * there is no second literal left to drift-check here. What remains load-
 * bearing is the IPC boundary itself: `promptSessionsMergeActiveIndex` must
 * still validate session CONTENT sent by a renderer for any NON-creation
 * mutation (event append, approveProposed, etc.), not just the envelope — and
 * it must do so per-ROW: persistActiveIndex sends every open Epic for a cwd in
 * one call, so a malformed row is dropped while its valid siblings still
 * persist, never failing the whole batch. The second describe block below is
 * the actual "exactly one construction path" regression guard (PRD after
 * 955's cleanup pass) — a structural check against createPromptSession's own
 * source rather than a second-literal drift comparison, since there is no
 * longer a second literal to compare against.
 *
 * Run: timeout 300 npx vitest run tests/unit/promptSessionSchema-crossBoundary.spec.ts
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { schemas } = require('../../src/main/ipcSchemas.cjs') as {
  schemas: {
    promptSessionsMergeActiveIndex: {
      safeParse: (v: unknown) => { success: boolean; data?: { sessions: Record<string, unknown> }; error?: unknown }
    }
  }
}

const promptSessionsStateSrc = readFileSync(
  fileURLToPath(new URL('../../src/renderer/state/promptSessions.ts', import.meta.url)),
  'utf8',
)

function validEnvelope(sessions: Record<string, unknown>) {
  return { cwd: '/home/user/project', sessions, events: {}, source: 'epics' as const }
}

describe('promptSessionsMergeActiveIndex IPC boundary validates session content', () => {
  it('drops a session missing claudeSessionId', () => {
    const malformed = {
      id: 'psess-bad1',
      cwd: '/home/user/project',
      goalText: 'do the thing',
      // claudeSessionId omitted
      status: 'active',
      createdAt: '2026-08-02T13:48:00.000Z',
      completedAt: null,
    }
    const result = schemas.promptSessionsMergeActiveIndex.safeParse(validEnvelope({ 'psess-bad1': malformed }))
    expect(result.success).toBe(true)
    expect(result.data?.sessions).toEqual({})
  })

  it('drops a session with an invalid status value', () => {
    const malformed = {
      id: 'psess-bad2',
      cwd: '/home/user/project',
      goalText: 'do the thing',
      claudeSessionId: 'claude-bad2',
      status: 'in-progress', // not one of proposed/active/completed
      createdAt: '2026-08-02T13:48:00.000Z',
      completedAt: null,
    }
    const result = schemas.promptSessionsMergeActiveIndex.safeParse(validEnvelope({ 'psess-bad2': malformed }))
    expect(result.success).toBe(true)
    expect(result.data?.sessions).toEqual({})
  })

  it('accepts a well-formed session', () => {
    const ok = {
      id: 'psess-ok1',
      cwd: '/home/user/project',
      goalText: 'do the thing',
      claudeSessionId: 'claude-ok1',
      status: 'active',
      createdAt: '2026-08-02T13:48:00.000Z',
      completedAt: null,
    }
    const result = schemas.promptSessionsMergeActiveIndex.safeParse(validEnvelope({ 'psess-ok1': ok }))
    expect(result.success).toBe(true)
    expect(Object.keys(result.data?.sessions ?? {})).toEqual(['psess-ok1'])
  })

  // The whole point of per-row validation: one bad Epic must not stop every
  // other Epic in the same cwd from persisting (they all ride one call).
  it('persists the valid sessions in a batch that also contains a malformed one', () => {
    const ok = {
      id: 'psess-ok2',
      cwd: '/home/user/project',
      goalText: 'keep me',
      claudeSessionId: 'claude-ok2',
      status: 'active',
      createdAt: '2026-08-02T13:48:00.000Z',
      completedAt: null,
    }
    const malformed = { id: 'psess-bad3', cwd: '/home/user/project', status: 'active' }

    const result = schemas.promptSessionsMergeActiveIndex.safeParse(
      validEnvelope({ 'psess-ok2': ok, 'psess-bad3': malformed }),
    )

    expect(result.success).toBe(true)
    expect(Object.keys(result.data?.sessions ?? {})).toEqual(['psess-ok2'])
  })

  it('drops a session whose id is a prototype-pollution key rather than failing the batch', () => {
    const ok = {
      id: 'psess-ok3',
      cwd: '/home/user/project',
      goalText: 'keep me too',
      claudeSessionId: 'claude-ok3',
      status: 'proposed',
      createdAt: '2026-08-02T13:48:00.000Z',
      completedAt: null,
    }
    const sessions: Record<string, unknown> = { 'psess-ok3': ok }
    Object.defineProperty(sessions, '__proto__', { value: ok, enumerable: true, configurable: true })

    const result = schemas.promptSessionsMergeActiveIndex.safeParse(validEnvelope(sessions))

    expect(result.success).toBe(true)
    expect(Object.keys(result.data?.sessions ?? {})).toEqual(['psess-ok3'])
  })
})

// Structural guard for the actual PRD 953/955 claim: there is exactly ONE
// place a PromptSession's id/claudeSessionId is minted (main's ensureEpic,
// epicMint.cjs). Asserts against the renderer source text itself rather than
// runtime behavior, so a regression that reintroduces a local hand-built
// object literal (e.g. `mintId('psess', ...)` or `crypto.randomUUID()` for
// the Epic id) fails this test even before any other test would catch it.
describe('createPromptSession has exactly one construction path', () => {
  it('never mints an Epic id/claudeSessionId locally', () => {
    expect(promptSessionsStateSrc).not.toMatch(/mintId\(\s*['"]psess['"]/)
    expect(promptSessionsStateSrc).not.toContain('crypto.randomUUID')
  })

  it('always constructs the Epic via window.api.promptSessions.create', () => {
    expect(promptSessionsStateSrc).toContain('window.api.promptSessions.create(')
  })
})
