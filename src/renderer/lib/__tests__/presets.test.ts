import { describe, it, expect } from 'vitest'
import { DEFAULT_PRESETS, renderCommand, modelFlag } from '../presets'

describe('modelFlag', () => {
  it('renders a shell-quoted --model flag for an explicit model', () => {
    expect(modelFlag('opus')).toBe(" --model 'opus'")
  })

  it('omits the flag when model is undefined', () => {
    expect(modelFlag(undefined)).toBe('')
  })

  it("omits the flag when model is 'inherit'", () => {
    expect(modelFlag('inherit')).toBe('')
  })
})

describe('renderCommand — sm-dangerous (claudeDangerous)', () => {
  const preset = DEFAULT_PRESETS.find((p) => p.id === 'sm-dangerous')!

  it('appends --model when ctx.model is set', () => {
    const cmd = renderCommand(preset, { sessionId: 'abc', cwd: '/proj', model: 'opus' })
    expect(cmd).toBe("claude --dangerously-skip-permissions --session-id 'abc' --model 'opus'")
  })

  it('is byte-identical to the no-model command when ctx.model is unset', () => {
    const withModel = renderCommand(preset, { sessionId: 'abc', cwd: '/proj' })
    const explicit = renderCommand(preset, { sessionId: 'abc', cwd: '/proj', model: undefined })
    expect(withModel).toBe("claude --dangerously-skip-permissions --session-id 'abc'")
    expect(withModel).toBe(explicit)
  })

  it("is byte-identical to the no-model command when ctx.model is 'inherit'", () => {
    const inherited = renderCommand(preset, { sessionId: 'abc', cwd: '/proj', model: 'inherit' })
    const noModel = renderCommand(preset, { sessionId: 'abc', cwd: '/proj' })
    expect(inherited).toBe(noModel)
  })
})

describe('renderCommand — sm-safe (claudeSafe)', () => {
  const preset = DEFAULT_PRESETS.find((p) => p.id === 'sm-safe')!

  it('appends --model when ctx.model is set', () => {
    const cmd = renderCommand(preset, { sessionId: 'abc', cwd: '/proj', model: 'sonnet' })
    expect(cmd).toBe("claude --session-id 'abc' --model 'sonnet'")
  })

  it('is byte-identical to the no-model command when ctx.model is unset', () => {
    const withModel = renderCommand(preset, { sessionId: 'abc', cwd: '/proj' })
    expect(withModel).toBe("claude --session-id 'abc'")
  })
})
