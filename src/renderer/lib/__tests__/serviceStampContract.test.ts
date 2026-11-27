// @vitest-environment node
/**
 * Contract: the `source.autoApprove` stamp main builds for a granted paired-service
 * call (crossProjectFeedback.cjs) is what the renderer narrows on
 * (promptSessions.ts union, inboundAutoApprove.isStampedInbound, epicOrigin).
 * Runs the REAL openFeedbackSession and feeds its captured stamp to the renderer.
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isStampedInbound } from '../inboundAutoApprove'
import { inboundFeedbackOrigin } from '../epicOrigin'
import type { PromptSession } from '../../state/promptSessions'

const req = createRequire(import.meta.url)
const config = req('../../../main/config.cjs')
const { openFeedbackSession } = req('../../../main/lib/feedback-remote/crossProjectFeedback.cjs')

/** The renderer's `requestedBy: 'service'` autoApprove variant — keep in step with promptSessions.ts. */
const RENDERER_SERVICE_STAMP_KEYS = ['fromClaudeSessionId', 'requestedBy', 'serviceId', 'serviceName', 'verifiedAt']

const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true })
})

function mkProject(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-stamp-'))
  tmpDirs.push(cwd)
  config.addAllowedRoot(cwd)
  fs.mkdirSync(path.join(cwd, 'session-manager-operations'), { recursive: true })
  return fs.realpathSync(cwd)
}

async function captureServiceStamp(): Promise<{ source: Record<string, unknown>; stamp: Record<string, unknown> }> {
  const to = mkProject()
  const from = mkProject()
  let captured: { source?: Record<string, unknown> } = {}
  const service = { serviceId: 'svc-1', name: 'Kiln', startWork: { targets: [to] } }
  const r = await openFeedbackSession(
    {
      toCwd: to,
      fromCwd: from,
      title: 'Service stamp contract',
      body: 'Symptom: the stamp shape drifts between main and renderer.',
      motivation: 'A rename on either side must be caught.',
      acceptanceCriteria: ['Stamp round-trips'],
      autoStart: true,
      tag: 'bug',
      plan: ['Step one'],
    },
    {
      trustedServiceId: 'svc-1',
      findService: () => service,
      ensureEpic: async (_cwd: string, args: { source: Record<string, unknown> }) => {
        captured = args
        return { epicId: 'epic-contract' }
      },
      appendResponseEventIfKnown: async () => {},
      notifyRenderer: () => {},
      appendAudit: () => {},
    },
  )
  expect(r.error).toBeUndefined()
  const source = captured.source as Record<string, unknown>
  return { source, stamp: source.autoApprove as Record<string, unknown> }
}

describe('service autoApprove stamp contract (main → renderer)', () => {
  it('renderer accepts the stamp main produces and reports the service name', async () => {
    const { source, stamp } = await captureServiceStamp()
    expect(stamp.requestedBy).toBe('service')
    const epic = { id: 'epic-contract', status: 'proposed', cwd: '/x', source } as unknown as PromptSession
    expect(isStampedInbound(epic)).toBe(true)
    expect(inboundFeedbackOrigin(epic)?.label).toContain('Kiln')
  })

  it('stamp key set equals the renderer-expected key list (a rename fails here)', async () => {
    const { stamp } = await captureServiceStamp()
    expect(Object.keys(stamp).sort()).toEqual(RENDERER_SERVICE_STAMP_KEYS)
    expect(stamp.serviceName).toBe('Kiln')
    expect(stamp.fromClaudeSessionId).toBeNull()
  })
})
