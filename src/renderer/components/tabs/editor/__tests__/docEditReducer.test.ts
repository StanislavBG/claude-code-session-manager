import { describe, it, expect } from 'vitest'
import { docEditReducer, IDLE_STATE, type DocEditState, type SelectionInfo } from '../docEditReducer'

const selection: SelectionInfo = { text: 'hello', rect: { top: 0, left: 0, bottom: 0, right: 0 } }

describe('docEditReducer', () => {
  it('walks the full happy path popover -> listening -> review -> thinking -> diff -> accept', () => {
    let s: DocEditState = IDLE_STATE
    s = docEditReducer(s, { type: 'SELECT', selection })
    expect(s.phase).toBe('popover')

    s = docEditReducer(s, { type: 'LISTEN' })
    expect(s.phase).toBe('listening')

    s = docEditReducer(s, { type: 'HEARD', transcript: 'make this concise' })
    expect(s.phase).toBe('review')
    expect(s.transcript).toBe('make this concise')

    s = docEditReducer(s, { type: 'RUN', instruction: 'make this concise', recordInstruction: true })
    expect(s.phase).toBe('thinking')
    expect(s.instruction).toBe('make this concise')

    s = docEditReducer(s, { type: 'RUN_OK', diff: { before: 'hello', after: 'hi' } })
    expect(s.phase).toBe('diff')
    expect(s.diff).toEqual({ before: 'hello', after: 'hi' })

    s = docEditReducer(s, { type: 'ACCEPT' })
    expect(s.phase).toBe('idle')
    expect(s.editCount).toBe(1)
  })

  it('re-record loops review -> listening', () => {
    let s: DocEditState = docEditReducer(IDLE_STATE, { type: 'SELECT', selection })
    s = docEditReducer(s, { type: 'LISTEN' })
    s = docEditReducer(s, { type: 'HEARD', transcript: 'first take' })
    expect(s.phase).toBe('review')

    s = docEditReducer(s, { type: 'LISTEN' })
    expect(s.phase).toBe('listening')
    expect(s.transcript).toBe('')
  })

  it('cancel from every non-idle phase returns to idle', () => {
    const phases: Array<() => DocEditState> = [
      () => docEditReducer(IDLE_STATE, { type: 'SELECT', selection }),
      () => docEditReducer(docEditReducer(IDLE_STATE, { type: 'SELECT', selection }), { type: 'LISTEN' }),
      () => {
        let s = docEditReducer(IDLE_STATE, { type: 'SELECT', selection })
        s = docEditReducer(s, { type: 'LISTEN' })
        return docEditReducer(s, { type: 'HEARD', transcript: 'x' })
      },
      () => {
        let s = docEditReducer(IDLE_STATE, { type: 'SELECT', selection })
        return docEditReducer(s, { type: 'RUN', instruction: 'x', recordInstruction: true })
      },
      () => {
        let s = docEditReducer(IDLE_STATE, { type: 'SELECT', selection })
        s = docEditReducer(s, { type: 'RUN', instruction: 'x', recordInstruction: true })
        return docEditReducer(s, { type: 'RUN_OK', diff: { before: 'a', after: 'b' } })
      },
    ]

    for (const build of phases) {
      const s = build()
      expect(s.phase).not.toBe('idle')
      const cancelled = docEditReducer(s, { type: 'CANCEL' })
      expect(cancelled.phase).toBe('idle')
      expect(cancelled.editCount).toBe(s.editCount)
    }
  })

  it('RUN is a no-op from idle or listening', () => {
    const fromIdle = docEditReducer(IDLE_STATE, { type: 'RUN', instruction: 'x', recordInstruction: true })
    expect(fromIdle.phase).toBe('idle')

    let listening = docEditReducer(IDLE_STATE, { type: 'SELECT', selection })
    listening = docEditReducer(listening, { type: 'LISTEN' })
    const stillListening = docEditReducer(listening, { type: 'RUN', instruction: 'x', recordInstruction: true })
    expect(stillListening.phase).toBe('listening')
  })

  it('MODEL_STATUS sets modelStatus without changing phase', () => {
    let s: DocEditState = docEditReducer(IDLE_STATE, { type: 'SELECT', selection })
    s = docEditReducer(s, { type: 'LISTEN' })
    expect(s.modelStatus).toBeNull()

    s = docEditReducer(s, { type: 'MODEL_STATUS', status: 'loading', message: '42%' })
    expect(s.phase).toBe('listening')
    expect(s.modelStatus).toBe('loading: 42%')
  })

  it('resets modelStatus to null on LISTEN, HEARD, and CANCEL', () => {
    let s: DocEditState = docEditReducer(IDLE_STATE, { type: 'SELECT', selection })
    s = docEditReducer(s, { type: 'LISTEN' })
    s = docEditReducer(s, { type: 'MODEL_STATUS', status: 'loading', message: '10%' })
    expect(s.modelStatus).toBe('loading: 10%')

    s = docEditReducer(s, { type: 'HEARD', transcript: 'hello' })
    expect(s.modelStatus).toBeNull()

    s = docEditReducer(s, { type: 'LISTEN' })
    s = docEditReducer(s, { type: 'MODEL_STATUS', status: 'loading', message: '10%' })
    expect(s.modelStatus).toBe('loading: 10%')
    s = docEditReducer(s, { type: 'CANCEL' })
    expect(s.modelStatus).toBeNull()

    s = docEditReducer(IDLE_STATE, { type: 'SELECT', selection })
    s = docEditReducer(s, { type: 'LISTEN' })
    expect(s.modelStatus).toBeNull()
  })

  it('MODEL_STATUS is a no-op outside the listening phase', () => {
    const popover = docEditReducer(IDLE_STATE, { type: 'SELECT', selection })
    const unchanged = docEditReducer(popover, { type: 'MODEL_STATUS', status: 'loading', message: '1%' })
    expect(unchanged).toEqual(popover)
  })

  it('RESET_FILE zeroes the edit counter', () => {
    let s = docEditReducer(IDLE_STATE, { type: 'SELECT', selection })
    s = docEditReducer(s, { type: 'RUN', instruction: 'x', recordInstruction: true })
    s = docEditReducer(s, { type: 'RUN_OK', diff: { before: 'a', after: 'b' } })
    s = docEditReducer(s, { type: 'ACCEPT' })
    expect(s.editCount).toBe(1)
    s = docEditReducer(s, { type: 'RESET_FILE' })
    expect(s).toEqual(IDLE_STATE)
  })
})
