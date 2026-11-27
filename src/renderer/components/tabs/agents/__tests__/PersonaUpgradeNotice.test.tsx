// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { PersonaUpgradeNotice } from '../PersonaUpgradeNotice'
import type { AgentPersona } from '../../../../../preload/api'
import { toast } from '../../../../state/toast'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base = { name: 'architect', body: 'a\nb', upgrade: { installedVersion: 6, bundledVersion: 8, edited: true, bundledBody: 'a\nc' } } as unknown as AgentPersona
let host: HTMLElement
let root: Root
const take = vi.fn()
const dismiss = vi.fn()
const onDone = vi.fn()

const mount = async (p: AgentPersona) => {
  await act(async () => { root.render(createElement(PersonaUpgradeNotice, { persona: p, onDone })) })
}
const click = async (id: string) => {
  await act(async () => { (host.querySelector(`[data-testid="${id}"]`) as HTMLElement).click() })
}

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  take.mockReset().mockResolvedValue({ backupPath: '/b/x.md', seedVersion: 8 })
  dismiss.mockReset().mockResolvedValue({ ok: true })
  onDone.mockReset()
  ;(window as unknown as { api: unknown }).api = { agents: { takeBundledPersona: take, dismissPersonaUpgrade: dismiss } }
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })

describe('PersonaUpgradeNotice', () => {
  it('shows versions and kept-edits copy', async () => {
    await mount(base)
    const t = host.querySelector('[data-testid="persona-upgrade-notice"]')?.textContent ?? ''
    expect(t).toContain('v6')
    expect(t).toContain('v8')
    expect(t).toContain('edits were kept')
    expect(host.querySelector('details')).toBeTruthy()
  })
  it('Take calls takeBundledPersona then onDone', async () => {
    await mount(base)
    await click('persona-upgrade-take')
    expect(take).toHaveBeenCalledWith({ name: 'architect' })
    expect(onDone).toHaveBeenCalled()
  })
  it('Keep dismisses with bundledVersion', async () => {
    await mount(base)
    await click('persona-upgrade-keep')
    expect(dismiss).toHaveBeenCalledWith({ name: 'architect', bundledVersion: 8 })
    expect(onDone).toHaveBeenCalled()
  })
  it('toasts error on rejection', async () => {
    take.mockRejectedValue(new Error('boom'))
    const err = vi.spyOn(toast, 'error')
    await mount(base)
    await click('persona-upgrade-take')
    expect(err).toHaveBeenCalledWith('boom')
    expect(onDone).not.toHaveBeenCalled()
  })
  it('renders nothing when upgrade is null', async () => {
    await mount({ ...base, upgrade: null })
    expect(host.querySelector('[data-testid="persona-upgrade-notice"]')).toBeNull()
  })
})
