// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsRemoteServices, SERVICE_TOOLS, DEFAULT_SCOPE } from '../SettingsRemoteServices'
import { useToast } from '../../../state/toast'
import { useSessions } from '../../../state/sessions'
import type { WebRemoteServicesListResult } from '../../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null
let list: WebRemoteServicesListResult
let api: Record<string, ReturnType<typeof vi.fn>>
let clipboard: ReturnType<typeof vi.fn>

const service = {
  serviceId: 'svc-1', name: 'Kiln', homeCwd: '/home/u/Self', scope: [...DEFAULT_SCOPE],
  projectRoot: null as string | null, relayClientId: 'rc-1', pairedAt: 1_700_000_000_000, lastSeenAt: 1_700_000_000_000,
}
const pendingEntry = {
  pairingId: 'pair-1', name: 'Kiln', homeCwd: '/home/u/Self', scope: [...DEFAULT_SCOPE],
  projectRoot: null as string | null, createdAt: Date.now(), expiresAt: Date.now() + 300_000,
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

async function mount(props: { enabled?: boolean; hasDevice?: boolean } = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(SettingsRemoteServices, { enabled: props.enabled ?? true, hasDevice: props.hasDevice ?? true }))
    await flush()
  })
}

const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const qa = (id: string) => container!.querySelectorAll(`[data-testid="${id}"]`)
const click = async (el: HTMLElement | null) => {
  expect(el).not.toBeNull()
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
  })
}
const type = async (el: HTMLElement | null, value: string) => {
  const input = el as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
  })
}
const lastToast = () => useToast.getState().toasts.at(-1)

async function openFormAndStart(name = 'Kiln') {
  await click(q('remote-service-pair'))
  await type(q('remote-service-name'), name)
  await click(q('remote-service-start'))
}

beforeEach(() => {
  list = { ok: true, services: [], pending: [], relayOrphans: [] }
  api = {
    servicesList: vi.fn(async () => list),
    servicePairStart: vi.fn(async () => ({
      ok: true, code: 'ABCD1234', pairingId: 'pair-1', codeExpiresAt: Date.now() + 5 * 60 * 1000, deviceId: 'dev12345abcdef',
    })),
    serviceConfirmSas: vi.fn(async () => ({ ok: true, service })),
    serviceRevoke: vi.fn(async () => ({ ok: true, relayRevoked: true })),
    serviceSetStartWork: vi.fn(async () => ({ ok: true, service })),
    relayClientRevoke: vi.fn(async () => ({ ok: true })),
    servicePairCancel: vi.fn(async () => {
      list = { ...list, pending: list.pending.filter((p) => p.pairingId !== 'pair-1') }
      return { ok: true, cancelled: true, dropped: 1 }
    }),
  }
  clipboard = vi.fn(async () => ({ ok: true }))
  ;(window as unknown as { api: unknown }).api = {
    webRemote: api,
    clipboard: { writeText: clipboard },
    app: { homeDir: vi.fn(async () => '/home/u/') },
  }
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  useSessions.setState({ tabs: [{ id: 't1', cwd: '/home/u/Self' }, { id: 't2', cwd: '/home/u/Other' }] as never })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.clearAllMocks()
})

describe('SettingsRemoteServices', () => {
  it('marks a locally paired service in its subtitle and keeps Revoke', async () => {
    list = {
      ok: true,
      services: [
        { ...service, serviceId: 'svc-w', name: 'Win' },
        { ...service, serviceId: 'svc-l', name: 'Loc', pairedVia: 'local' as const },
      ],
      pending: [], relayOrphans: [],
    }
    await mount()
    const rows = Array.from(document.querySelectorAll('[data-testid="remote-service-row"]'))
    const date = new Date(service.pairedAt).toLocaleDateString()
    expect(rows[0].textContent).toContain(`· paired ${date}`)
    expect(rows[0].textContent).not.toContain('paired locally')
    expect(rows[1].textContent).toContain(`· paired locally ${date}`)
    expect(rows[1].querySelector('[data-testid="remote-service-revoke"]')).not.toBeNull()
  })

  it('is collapsed by default: one Pair a service… button, no form', async () => {
    await mount()
    expect(q('remote-service-pair')?.textContent).toContain('Pair a service…')
    expect(q('remote-service-form')).toBeNull()
    expect(q('remote-service-code')).toBeNull()
  })

  it('opens a form with a 64-char name, a home project picker and every tool but project_create ticked', async () => {
    await mount()
    await click(q('remote-service-pair'))
    expect(q('remote-service-form')).not.toBeNull()
    expect((q('remote-service-name') as HTMLInputElement).maxLength).toBe(64)
    const select = q('remote-service-home') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['/home/u/Self', '/home/u/Other'])
    expect(SERVICE_TOOLS).toHaveLength(7)
    expect(DEFAULT_SCOPE).toEqual(SERVICE_TOOLS.filter((t) => t !== 'project_create'))
    for (const tool of SERVICE_TOOLS) {
      expect((q(`remote-service-scope-${tool}`) as HTMLInputElement).checked).toBe(tool !== 'project_create')
    }
    expect(q('remote-service-scope-project_create')!.parentElement!.textContent).toContain('Create projects')
    expect(q('remote-service-project-root')).toBeNull()
    await click(q('remote-service-scope-macro_run'))
    await type(q('remote-service-name'), 'Kiln')
    await click(q('remote-service-start'))
    expect(api.servicePairStart).toHaveBeenCalledWith({
      name: 'Kiln', homeCwd: '/home/u/Self', scope: DEFAULT_SCOPE.filter((t) => t !== 'macro_run'),
    })
  })

  it('ticking project_create shows a prefilled New projects go in field; unticking hides it', async () => {
    await mount()
    await click(q('remote-service-pair'))
    await click(q('remote-service-scope-project_create'))
    const field = q('remote-service-project-root') as HTMLInputElement
    expect(field).not.toBeNull()
    expect(field.value).toBe('/home/u/Projects')
    expect(field.closest('label')!.textContent).toContain('New projects go in')
    await click(q('remote-service-scope-project_create'))
    expect(q('remote-service-project-root')).toBeNull()
  })

  it('sends the trimmed projectRoot only with project_create, and keeps Start disabled on an empty field', async () => {
    await mount()
    await click(q('remote-service-pair'))
    await type(q('remote-service-name'), 'Kiln')
    await click(q('remote-service-scope-project_create'))
    await type(q('remote-service-project-root'), '   ')
    expect((q('remote-service-start') as HTMLButtonElement).disabled).toBe(true)
    await type(q('remote-service-project-root'), '  /home/u/Builds  ')
    expect((q('remote-service-start') as HTMLButtonElement).disabled).toBe(false)
    await click(q('remote-service-start'))
    expect(api.servicePairStart).toHaveBeenCalledWith({
      name: 'Kiln', homeCwd: '/home/u/Self', scope: SERVICE_TOOLS, projectRoot: '/home/u/Builds',
    })
  })

  it('omits projectRoot when project_create is not ticked', async () => {
    await mount()
    await openFormAndStart()
    const input = api.servicePairStart.mock.calls[0][0] as Record<string, unknown>
    expect(input).not.toHaveProperty('projectRoot')
    expect(input.scope).toEqual(DEFAULT_SCOPE)
  })

  it('shows the projects folder on paired and pending rows that have one', async () => {
    list = {
      ok: true,
      services: [{ ...service, scope: [...SERVICE_TOOLS], projectRoot: '/home/u/Projects' }, { ...service, serviceId: 'svc-2' }],
      pending: [{ ...pendingEntry, projectRoot: '/home/u/Builds' }],
      relayOrphans: [],
    }
    await mount()
    expect(q('remote-service-project-root-svc-1')?.textContent).toContain('/home/u/Projects')
    expect(q('remote-service-project-root-svc-2')).toBeNull()
    expect(q('remote-service-project-root-pair-1')?.textContent).toContain('/home/u/Builds')
  })

  it('shows the code with a 5-minute countdown and copies the pair command', async () => {
    await mount()
    await openFormAndStart()
    expect(q('remote-service-code')?.textContent).toBe('ABCD1234')
    expect(q('remote-service-countdown')?.textContent).toMatch(/expires in (5:00|4:5\d)/)
    await click(q('remote-service-copy'))
    expect(clipboard).toHaveBeenCalledTimes(1)
    const cmd = clipboard.mock.calls[0][0] as string
    expect(cmd).toMatch(/^npx claude-code-session-manager service pair --code ABCD1234 --device dev12345 --name Kiln --state-dir \S+$/)
  })

  it.each([
    ['relay_unsupported', 'The bilko.run relay does not accept services yet'],
    ['device_token_invalid', 'Re-pair this desktop with the phone first'],
    ['rate_limited', 'Too many codes this hour'],
  ])('shows %s inline', async (error, text) => {
    api.servicePairStart.mockResolvedValueOnce({ ok: false, error })
    await mount()
    await openFormAndStart()
    expect(q('remote-service-error')?.textContent).toBe(text)
    expect(q('remote-service-code')).toBeNull()
    expect(useToast.getState().toasts).toHaveLength(0)
  })

  it('routes any other error to an error toast', async () => {
    api.servicePairStart.mockResolvedValueOnce({ ok: false, error: 'boom' })
    await mount()
    await openFormAndStart()
    expect(q('remote-service-error')).toBeNull()
    expect(lastToast()?.kind).toBe('error')
    expect(lastToast()?.message).toContain('boom')
  })

  it('empty state renders no list headings or rows', async () => {
    await mount()
    expect(container!.textContent).not.toContain('Paired services')
    expect(container!.textContent).not.toContain('Relay clients without a service')
    expect(qa('remote-service-row')).toHaveLength(0)
    expect(qa('remote-relay-orphan-row')).toHaveLength(0)
  })

  it('is disabled with an explanation while Web Remote is off or no device is paired', async () => {
    list = { ok: true, services: [service], pending: [], relayOrphans: [] }
    await mount({ enabled: false })
    expect((q('remote-service-pair') as HTMLButtonElement).disabled).toBe(true)
    expect(q('remote-service-disabled')?.textContent).toContain('Allow remote control from the web')
    expect(api.servicesList).not.toHaveBeenCalled()
    act(() => root?.unmount())
    container?.remove()
    await mount({ hasDevice: false })
    expect((q('remote-service-pair') as HTMLButtonElement).disabled).toBe(true)
    expect(q('remote-service-disabled')?.textContent).toContain('Pair a device')
  })

  it('confirms a pending SAS', async () => {
    list = { ok: true, services: [], pending: [pendingEntry], relayOrphans: [] }
    await mount()
    expect((q('remote-service-sas-confirm') as HTMLButtonElement).disabled).toBe(true)
    await type(q('remote-service-sas-input'), '123456')
    await click(q('remote-service-sas-confirm'))
    expect(api.serviceConfirmSas).toHaveBeenCalledWith('pair-1', '123456')
  })

  it('Deny cancels the pairing through servicePairCancel and reloads the list', async () => {
    list = { ok: true, services: [], pending: [pendingEntry], relayOrphans: [] }
    await mount()
    expect(api.servicesList).toHaveBeenCalledTimes(1)
    await click(q('remote-service-sas-deny'))
    expect(api.servicePairCancel).toHaveBeenCalledWith('pair-1')
    expect(api.servicesList).toHaveBeenCalledTimes(2)
    expect(q('remote-service-pending')).toBeNull()
    expect(useToast.getState().toasts.filter((t) => t.kind === 'error')).toHaveLength(0)
  })

  it('Deny failure (ok:false) shows an error toast and keeps the row', async () => {
    list = { ok: true, services: [], pending: [pendingEntry], relayOrphans: [] }
    api.servicePairCancel.mockResolvedValueOnce({ ok: false, error: 'nope' })
    await mount()
    await click(q('remote-service-sas-deny'))
    expect(api.servicePairCancel).toHaveBeenCalledWith('pair-1')
    expect(lastToast()?.kind).toBe('error')
    expect(lastToast()?.message).toContain('nope')
    expect(q('remote-service-pending')).not.toBeNull()
  })

  it('Deny failure (thrown) shows an error toast and keeps the row', async () => {
    list = { ok: true, services: [], pending: [pendingEntry], relayOrphans: [] }
    api.servicePairCancel.mockRejectedValueOnce(new Error('ipc down'))
    await mount()
    await click(q('remote-service-sas-deny'))
    expect(lastToast()?.kind).toBe('error')
    expect(lastToast()?.message).toContain('ipc down')
    expect(q('remote-service-pending')).not.toBeNull()
  })

  it('lists paired services and revokes one behind a confirm', async () => {
    list = { ok: true, services: [service], pending: [], relayOrphans: [] }
    await mount()
    expect(qa('remote-service-row')).toHaveLength(1)
    expect(container!.textContent).toContain('Paired services')
    await click(q('remote-service-revoke'))
    expect(api.serviceRevoke).not.toHaveBeenCalled()
    await click(q('remote-service-revoke-confirm'))
    expect(api.serviceRevoke).toHaveBeenCalledWith('svc-1')
  })

  describe('May start work it opens', () => {
    const setMode = async (v: string) => {
      const sel = q('remote-service-start-work-mode') as HTMLSelectElement
      await act(async () => {
        sel.value = v
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        await flush()
      })
    }
    const withGrant = (targets: string[] | null) => {
      list = { ok: true, services: [{ ...service, startWork: targets ? { targets } : null }], pending: [], relayOrphans: [] }
    }

    it('is off by default and shows no project list', async () => {
      withGrant(null)
      await mount()
      expect((q('remote-service-start-work-mode') as HTMLSelectElement).value).toBe('off')
      expect(qa('remote-service-start-work-project')).toHaveLength(0)
    })

    it('turns on for all projects', async () => {
      withGrant(null)
      await mount()
      await setMode('all')
      expect(api.serviceSetStartWork).toHaveBeenCalledWith('svc-1', ['*'])
    })

    it('shows the current grant and changes its scope', async () => {
      withGrant(['/home/u/Self'])
      await mount()
      expect((q('remote-service-start-work-mode') as HTMLSelectElement).value).toBe('selected')
      const other = container!.querySelector('[data-cwd="/home/u/Other"]') as HTMLElement
      await click(other)
      expect(api.serviceSetStartWork).toHaveBeenCalledWith('svc-1', ['/home/u/Self', '/home/u/Other'])
    })

    it('Selected projects saves nothing until a project is ticked', async () => {
      withGrant(null)
      await mount()
      await setMode('selected')
      expect(api.serviceSetStartWork).not.toHaveBeenCalled()
      expect((q('remote-service-start-work-mode') as HTMLSelectElement).value).toBe('selected')
      expect(qa('remote-service-start-work-project').length).toBeGreaterThan(0)
      expect(q('remote-service-start-work-note')!.textContent).toContain('Tick at least one project')
      await click(container!.querySelector('[data-cwd="/home/u/Other"]') as HTMLElement)
      expect(api.serviceSetStartWork).toHaveBeenCalledWith('svc-1', ['/home/u/Other'])
    })

    it('a grant revoked elsewhere after Selected was ticked reads Off, not pending', async () => {
      withGrant(null)
      await mount()
      await setMode('selected')
      api.serviceSetStartWork.mockImplementationOnce(async () => {
        withGrant(['/home/u/Other'])
        return { ok: true, service }
      })
      await click(container!.querySelector('[data-cwd="/home/u/Other"]') as HTMLElement)
      expect((q('remote-service-start-work-mode') as HTMLSelectElement).value).toBe('selected')
      // Revoked elsewhere; the still-mounted control re-reads the list.
      withGrant(null)
      await act(async () => {
        root!.render(createElement(SettingsRemoteServices, { enabled: true, hasDevice: true, refreshKey: 'k2' }))
        await flush()
      })
      expect((q('remote-service-start-work-mode') as HTMLSelectElement).value).toBe('off')
      expect(q('remote-service-start-work-note')!.textContent).toContain('waits for your approval')
    })

    it('Selected projects with no known projects explains and stays selected', async () => {
      withGrant(null)
      useSessions.setState({ tabs: [] as never })
      await mount()
      await setMode('selected')
      expect(api.serviceSetStartWork).not.toHaveBeenCalled()
      expect((q('remote-service-start-work-mode') as HTMLSelectElement).value).toBe('selected')
      expect(q('remote-service-start-work-note')!.textContent).toContain('no projects to pick')
    })

    it('unticking the last project revokes and reads Off', async () => {
      withGrant(['/home/u/Self'])
      await mount()
      api.serviceSetStartWork.mockImplementationOnce(async () => {
        withGrant(null)
        return { ok: true, service }
      })
      await click(container!.querySelector('[data-cwd="/home/u/Self"]') as HTMLElement)
      expect(api.serviceSetStartWork).toHaveBeenCalledWith('svc-1', [])
      expect((q('remote-service-start-work-mode') as HTMLSelectElement).value).toBe('off')
    })

    it('turns off to revoke', async () => {
      withGrant(['*'])
      await mount()
      expect((q('remote-service-start-work-mode') as HTMLSelectElement).value).toBe('all')
      await setMode('off')
      expect(api.serviceSetStartWork).toHaveBeenCalledWith('svc-1', [])
    })

    it('shows a failed save as a toast error', async () => {
      withGrant(null)
      api.serviceSetStartWork.mockResolvedValueOnce({ ok: false, error: 'no_such_service' })
      await mount()
      await setMode('all')
      expect(lastToast()?.kind).toBe('error')
      expect(lastToast()?.message).toContain('no_such_service')
    })
  })

  it('lists relay orphans and revokes one behind a confirm', async () => {
    list = { ok: true, services: [], pending: [], relayOrphans: [{ clientId: 'rc-9', clientName: 'old kiln', issuedAt: null }] }
    await mount()
    expect(qa('remote-relay-orphan-row')).toHaveLength(1)
    expect(container!.textContent).not.toContain('Paired services')
    await click(q('remote-relay-orphan-revoke'))
    expect(api.relayClientRevoke).not.toHaveBeenCalled()
    await click(q('remote-relay-orphan-revoke-confirm'))
    expect(api.relayClientRevoke).toHaveBeenCalledWith('rc-9')
  })
})
