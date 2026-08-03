/**
 * Cross-boundary regression test for PRD 953 (dependent on PRD 952's
 * canonical PromptSessionSchema, src/main/lib/promptSessionSchema.cjs).
 *
 * Two independently hand-built PromptSession object literals exist in this
 * codebase: the main-process mint path (epicMint.cjs's ensureEpic, validated
 * against PromptSessionSchema by PRD 952) and the renderer's own construction
 * path (createPromptSession, state/promptSessions.ts). This file closes the
 * second drift risk directly:
 *
 *  - the IPC boundary (`promptSessionsMergeActiveIndex`) must now reject a
 *    malformed session sent by a renderer, not just validate the envelope.
 *  - the renderer's REAL construction output (via the extracted, pure
 *    `buildPromptSession`) must validate cleanly against the same schema —
 *    if either side drifts from the other, this test fails.
 *
 * Run: timeout 300 npx vitest run tests/unit/promptSessionSchema-crossBoundary.spec.ts
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { buildPromptSession } from '../../src/renderer/state/promptSessions'

const require = createRequire(import.meta.url)
const { schemas } = require('../../src/main/ipcSchemas.cjs') as {
  schemas: { promptSessionsMergeActiveIndex: { safeParse: (v: unknown) => { success: boolean; error?: unknown } } }
}
const { PromptSessionSchema } = require('../../src/main/lib/promptSessionSchema.cjs') as {
  PromptSessionSchema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }
}

function validEnvelope(sessions: Record<string, unknown>) {
  return { cwd: '/home/user/project', sessions, events: {}, source: 'epics' as const }
}

describe('promptSessionsMergeActiveIndex IPC boundary validates session content', () => {
  it('rejects a session missing claudeSessionId', () => {
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
    expect(result.success).toBe(false)
  })

  it('rejects a session with an invalid status value', () => {
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
    expect(result.success).toBe(false)
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
  })
})

describe('renderer createPromptSession output matches the canonical schema (drift detector)', () => {
  it('validates a plain cwd/goalText session cleanly', () => {
    const session = buildPromptSession('/home/user/project', 'Fix the login bug')
    const result = PromptSessionSchema.safeParse(session)
    expect(result.success).toBe(true)
  })

  it('validates a session with tag + agentType set cleanly', () => {
    const session = buildPromptSession('/home/user/project', 'Ship the new onboarding flow', 'feature', 'dev-lead')
    const result = PromptSessionSchema.safeParse(session)
    expect(result.success).toBe(true)
    expect(session.tag).toBe('feature')
    expect(session.agentType).toBe('dev-lead')
  })
})
