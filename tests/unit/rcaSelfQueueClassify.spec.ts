import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const requireCjs = createRequire(import.meta.url)
const { classifyFailure, stripHarnessInitEvents } = requireCjs('../../src/main/lib/rcaReport.cjs')

// Real init line shape from sigma run 2026-09-20T18-17-03-476Z (tools list abbreviated).
const INIT_LINE =
  '{"type":"system","subtype":"init","cwd":"/home/bilko/Projects/sigma","session_id":"e6deb989-d8e5-42ea-a99e-2f3cd9450511","tools":["Task","Bash","CronCreate","Monitor","ScheduleWakeup","SendMessage","Skill","Write"]}'
const INIT_WITH_SLEEP =
  '{"type":"system","subtype":"init","cwd":"/x","session_id":"s","tools":["Bash"],"description":"sleep 30 until done"}'

describe('stripHarnessInitEvents', () => {
  it('drops init lines and keeps everything else', () => {
    const other = '{"type":"system","subtype":"api_retry","note":"ScheduleWakeup"}'
    const out = stripHarnessInitEvents([INIT_LINE, 'hello', other].join('\n'))
    expect(out).not.toContain('"subtype":"init"')
    expect(out).toContain('hello')
    expect(out).toContain(other)
  })
  it('handles empty input', () => {
    expect(stripHarnessInitEvents('')).toBe('')
    expect(stripHarnessInitEvents(undefined)).toBe('')
  })
})

describe('classifyFailure self-queue detection', () => {
  it('(a) init-only ScheduleWakeup mention is not self-queue', () => {
    const logTail = [INIT_LINE, '{"type":"assistant","text":"done"}'].join('\n')
    expect(classifyFailure({ verdict: 'pass_no_commit', logTail })).toBe('no-sentinel')
  })
  it('(b) real tool_use block is self-queue', () => {
    const logTail = [INIT_LINE, '{"type":"tool_use","id":"t1","name":"ScheduleWakeup","input":{}}'].join('\n')
    expect(classifyFailure({ verdict: 'pass_no_commit', logTail })).toBe('self-queue')
  })
  it('(c) skill launch is self-queue', () => {
    const logTail = [INIT_LINE, 'Launching skill: session-manager-dev:develop'].join('\n')
    expect(classifyFailure({ verdict: 'pass_no_commit', logTail })).toBe('self-queue')
  })
  it('(d) precedence preserved over self-queue', () => {
    const wake = '{"type":"tool_use","name":"ScheduleWakeup"}'
    expect(classifyFailure({ verdict: 'blocked_by_foreign_wip_streak', logTail: wake })).not.toBe('self-queue')
    expect(
      classifyFailure({ verdict: 'pass_no_commit', logTail: `${wake}\nnothing to commit` }),
    ).not.toBe('self-queue')
    expect(classifyFailure({ verdict: 'abandoned_background_task', logTail: wake })).not.toBe('self-queue')
  })
  it('init-only log containing "sleep" is not stuck-loop', () => {
    const cls = classifyFailure({ verdict: 'pass_no_commit', logTail: INIT_WITH_SLEEP })
    expect(cls).not.toBe('stuck-loop')
    expect(cls).toBe('no-sentinel')
  })
})
