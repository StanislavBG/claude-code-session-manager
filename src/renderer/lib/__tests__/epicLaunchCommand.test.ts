import { describe, expect, it } from 'vitest'
import { buildEpicClaudeCommand, DEV_PLUGIN_ENABLED_KEY } from '../epicLaunchCommand'

describe('buildEpicClaudeCommand', () => {
  it('loop-on resume is byte-identical to the legacy command', () => {
    const base = { sessionId: 'abc', resume: true, model: 'sonnet', effort: 'high' }
    const legacy = "claude --dangerously-skip-permissions --resume 'abc' --model 'sonnet' --effort 'high'\r"
    expect(buildEpicClaudeCommand(base)).toBe(legacy)
    expect(buildEpicClaudeCommand({ ...base, developLoop: true })).toBe(legacy)
  })

  it('loop-on fresh launch is byte-identical to the legacy command', () => {
    expect(buildEpicClaudeCommand({ sessionId: 'abc', resume: false, model: 'sonnet', effort: null })).toBe(
      "claude --dangerously-skip-permissions --session-id 'abc' --model 'sonnet'\r",
    )
  })

  it('loop-off appends --settings with enabledPlugins false', () => {
    const cmd = buildEpicClaudeCommand({ sessionId: 'abc', resume: true, model: 'sonnet', developLoop: false })
    expect(cmd.endsWith('\r')).toBe(true)
    const m = cmd.slice(0, -1).match(/ --settings '(.*)'$/)
    expect(m).not.toBeNull()
    expect(JSON.parse(m![1])).toEqual({ enabledPlugins: { [DEV_PLUGIN_ENABLED_KEY]: false } })
  })
})
