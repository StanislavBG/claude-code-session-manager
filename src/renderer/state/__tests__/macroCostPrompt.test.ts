// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMacroCostPrompt, type MacroCostRequest } from '../macroCostPrompt'

const req: MacroCostRequest = {
  cwd: '/p',
  macroLabel: 'Demo Video',
  agentName: 'demo-video-builder',
  model: 'opus',
  effort: 'max',
  message: '"Demo Video" runs demo-video-builder on opus at max effort, which can use a large share of your Claude usage.',
}

beforeEach(() => {
  const s = useMacroCostPrompt.getState()
  if (s.request) s.answer({ proceed: false })
  useMacroCostPrompt.setState({ request: null, hostMounted: false })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useMacroCostPrompt', () => {
  it('falls back to window.confirm when no host is mounted (accept)', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await expect(useMacroCostPrompt.getState().ask(req)).resolves.toEqual({ proceed: true, effort: null })
    expect(spy).toHaveBeenCalledWith(`${req.message} Continue?`)
    expect(useMacroCostPrompt.getState().request).toBeNull()
  })

  it('falls back to window.confirm when no host is mounted (cancel)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await expect(useMacroCostPrompt.getState().ask(req)).resolves.toEqual({ proceed: false })
  })

  it('opens a request when the host is mounted and resolves on answer, clearing it', async () => {
    const spy = vi.spyOn(window, 'confirm')
    useMacroCostPrompt.getState().setHostMounted(true)
    const p = useMacroCostPrompt.getState().ask(req)
    expect(useMacroCostPrompt.getState().request).toEqual(req)
    useMacroCostPrompt.getState().answer({ proceed: true, effort: 'medium' })
    await expect(p).resolves.toEqual({ proceed: true, effort: 'medium' })
    expect(useMacroCostPrompt.getState().request).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('a second ask while one is open resolves { proceed: false } and leaves the open one alone', async () => {
    useMacroCostPrompt.getState().setHostMounted(true)
    const first = useMacroCostPrompt.getState().ask(req)
    const second = useMacroCostPrompt.getState().ask({ ...req, macroLabel: 'Other' })
    await expect(second).resolves.toEqual({ proceed: false })
    expect(useMacroCostPrompt.getState().request).toEqual(req)
    useMacroCostPrompt.getState().answer({ proceed: true, effort: null })
    await expect(first).resolves.toEqual({ proceed: true, effort: null })
  })

  it('unmounting the host with a request open cancels it', async () => {
    useMacroCostPrompt.getState().setHostMounted(true)
    const p = useMacroCostPrompt.getState().ask(req)
    useMacroCostPrompt.getState().setHostMounted(false)
    await expect(p).resolves.toEqual({ proceed: false })
    expect(useMacroCostPrompt.getState().request).toBeNull()
    expect(useMacroCostPrompt.getState().hostMounted).toBe(false)
  })
})
