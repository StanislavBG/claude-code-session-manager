import { describe, it, expect } from 'vitest'
import { resolveStartupCommand } from '../../src/renderer/state/sessions'

describe('resolveStartupCommand model passthrough', () => {
  for (const model of ['claude-opus-5', 'opus[1m]', 'claude-fable-5-1[1m]', 'opus']) {
    it(`carries ${model} into --model shell-quoted and unchanged`, async () => {
      const { startupCommand } = await resolveStartupCommand({ cwd: '/tmp/x', sessionId: 'sid' }, true, model)
      expect(startupCommand).toContain(`--model '${model}'`)
    })
  }
})
