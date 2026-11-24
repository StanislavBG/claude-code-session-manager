import { describe, it, expect, beforeEach, vi } from 'vitest'

const CWD = '/p'

const widget = (over: Record<string, unknown> = {}) => ({
  boxId: 'b1', projectCwd: CWD, fingerprint: 'fp', createdAt: '2026-11-23T00:00:00Z',
  snippet: '<script></script>', label: 'Site', allowedOrigins: ['https://a.test'],
  state: 'open', pending: 0, hint: null, ...over,
})
const meta = (over: Record<string, unknown> = {}) => ({
  hostId: 'FB-AAAAA', boxId: 'b1', receivedAt: '2026-11-23T00:00:00Z', origin: 'https://a.test',
  status: 'open', statusNote: null, epicId: null, statusChangedAt: '2026-11-23T00:00:00Z', ...over,
})
const item = (over: Record<string, unknown> = {}) => ({
  ...meta(), title: 't', type: 'bug', reporter: null, ...over,
})
const detail = (over: Record<string, unknown> = {}) => ({
  meta: meta(over), report: null, imagePaths: { screenshot: null, annotated: null },
})
const fail = (message = 'boom') => ({ ok: false, error: 'relay_error', message })

function installApi() {
  const sf = {
    widgetCreate: vi.fn().mockResolvedValue({ ok: true, boxId: 'b2', fingerprint: 'fp2', snippet: 's' }),
    widgetList: vi.fn().mockResolvedValue({ ok: true, widgets: [widget()] }),
    widgetUpdate: vi.fn(),
    widgetDelete: vi.fn().mockResolvedValue({ ok: true, boxId: 'b1' }),
    widgetSnippet: vi.fn(),
    inboxList: vi.fn().mockResolvedValue({ ok: true, items: [item()] }),
    inboxGet: vi.fn().mockResolvedValue({ ok: true, item: detail() }),
    inboxImage: vi.fn(),
    inboxSetStatus: vi.fn(),
    inboxLinkEpic: vi.fn(),
    inboxRemove: vi.fn(),
    drainNow: vi.fn().mockResolvedValue({
      ok: true, stored: 2, duplicates: 0, rejected: 0, goneBoxes: [], heldBoxes: [],
    }),
  }
  vi.stubGlobal('window', { api: { siteFeedback: sf } })
  return sf
}

async function load() {
  const mod = await import('../siteFeedback')
  const s = mod.useSiteFeedback
  const slice = () => mod.selectSiteFeedback(CWD)(s.getState())
  return { ...mod, s, slice }
}

describe('siteFeedback store', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('selector falls back to the same constant for an unknown cwd', async () => {
    installApi()
    const { s, selectSiteFeedback, EMPTY_SITE_FEEDBACK } = await load()
    const sel = selectSiteFeedback('/nope')
    expect(sel(s.getState())).toBe(EMPTY_SITE_FEEDBACK)
    expect(sel(s.getState())).toBe(sel(s.getState()))
  })

  it('loadWidgets stores widgets and relayError, clears loading', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    const relayError = fail('relay down')
    sf.widgetList.mockResolvedValue({ ok: true, widgets: [widget({ state: 'unknown' })], relayError })
    const r = await s.getState().loadWidgets(CWD)
    expect(r.ok).toBe(true)
    expect(sf.widgetList).toHaveBeenCalledWith({ cwd: CWD })
    expect(slice().widgets).toHaveLength(1)
    expect(slice().relayError).toEqual(relayError)
    expect(slice().widgetsLoading).toBe(false)
    expect(slice().error).toBeNull()
  })

  it('loadWidgets failure is returned and recorded as error', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    sf.widgetList.mockResolvedValue(fail('nope'))
    const r = await s.getState().loadWidgets(CWD)
    expect(r).toEqual(fail('nope'))
    expect(slice().error).toBe('nope')
    expect(slice().widgetsLoading).toBe(false)
  })

  it('a thrown IPC error becomes an ipc_error failure result', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    sf.widgetList.mockRejectedValue(new Error('ipc gone'))
    const r = await s.getState().loadWidgets(CWD)
    expect(r).toEqual({ ok: false, error: 'ipc_error', message: 'ipc gone' })
    expect(slice().error).toBe('ipc gone')
  })

  it('createWidget calls widgetCreate then reloads widgets', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    sf.widgetList.mockResolvedValue({ ok: true, widgets: [widget(), widget({ boxId: 'b2' })] })
    const r = await s.getState().createWidget(CWD, 'Site', ['https://a.test'])
    expect(r).toMatchObject({ ok: true, boxId: 'b2', snippet: 's' })
    expect(sf.widgetCreate).toHaveBeenCalledWith({ cwd: CWD, label: 'Site', allowedOrigins: ['https://a.test'] })
    expect(slice().widgets.map((w) => w.boxId)).toEqual(['b1', 'b2'])
  })

  it('createWidget failure does not reload and surfaces error', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    sf.widgetCreate.mockResolvedValue(fail('origin_invalid'))
    const r = await s.getState().createWidget(CWD, 'Site', ['bad'])
    expect(r.ok).toBe(false)
    expect(sf.widgetList).not.toHaveBeenCalled()
    expect(slice().error).toBe('origin_invalid')
  })

  it('updateWidget merges the relay echo into the stored widget', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    await s.getState().loadWidgets(CWD)
    sf.widgetUpdate.mockResolvedValue({ ok: true, widget: { boxId: 'b1', state: 'paused', label: 'New' } })
    const r = await s.getState().updateWidget(CWD, 'b1', { state: 'paused', label: 'New' })
    expect(r.ok).toBe(true)
    expect(sf.widgetUpdate).toHaveBeenCalledWith({ boxId: 'b1', state: 'paused', label: 'New' })
    expect(slice().widgets[0]).toMatchObject({ state: 'paused', label: 'New', allowedOrigins: ['https://a.test'] })
  })

  it('updateWidget failure leaves widgets unchanged', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    await s.getState().loadWidgets(CWD)
    sf.widgetUpdate.mockResolvedValue(fail('box_gone'))
    const r = await s.getState().updateWidget(CWD, 'b1', { state: 'paused' })
    expect(r.ok).toBe(false)
    expect(slice().widgets[0].state).toBe('open')
    expect(slice().error).toBe('box_gone')
  })

  it('deleteWidget removes the widget; failure keeps it', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    await s.getState().loadWidgets(CWD)
    sf.widgetDelete.mockResolvedValueOnce(fail('x'))
    expect((await s.getState().deleteWidget(CWD, 'b1')).ok).toBe(false)
    expect(slice().widgets).toHaveLength(1)
    expect((await s.getState().deleteWidget(CWD, 'b1')).ok).toBe(true)
    expect(sf.widgetDelete).toHaveBeenCalledWith({ boxId: 'b1' })
    expect(slice().widgets).toHaveLength(0)
    expect(slice().error).toBeNull()
  })

  it('loadItems stores items and passes the status filter', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    await s.getState().loadItems(CWD)
    expect(sf.inboxList).toHaveBeenLastCalledWith({ cwd: CWD })
    await s.getState().loadItems(CWD, 'resolved')
    expect(sf.inboxList).toHaveBeenLastCalledWith({ cwd: CWD, status: 'resolved' })
    expect(slice().items).toHaveLength(1)
    expect(slice().statusFilter).toBe('resolved')
    expect(slice().itemsLoading).toBe(false)
  })

  it('loadItems failure surfaces error', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    sf.inboxList.mockResolvedValue(fail('inbox broken'))
    expect((await s.getState().loadItems(CWD)).ok).toBe(false)
    expect(slice().error).toBe('inbox broken')
  })

  it('openItem loads the detail; closeItem clears it', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    const r = await s.getState().openItem(CWD, 'FB-AAAAA')
    expect(r.ok).toBe(true)
    expect(sf.inboxGet).toHaveBeenCalledWith({ cwd: CWD, hostId: 'FB-AAAAA' })
    expect(slice().selectedHostId).toBe('FB-AAAAA')
    expect(slice().selected?.meta.hostId).toBe('FB-AAAAA')
    expect(slice().itemLoading).toBe(false)
    s.getState().closeItem(CWD)
    expect(slice().selected).toBeNull()
    expect(slice().selectedHostId).toBeNull()
  })

  it('openItem failure surfaces error and leaves no detail', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    sf.inboxGet.mockResolvedValue(fail('not_found'))
    expect((await s.getState().openItem(CWD, 'FB-ZZZZZ')).ok).toBe(false)
    expect(slice().selected).toBeNull()
    expect(slice().error).toBe('not_found')
  })

  it('setStatus updates the row and the open item', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    await s.getState().loadItems(CWD)
    await s.getState().openItem(CWD, 'FB-AAAAA')
    sf.inboxSetStatus.mockResolvedValue({ ok: true, meta: meta({ status: 'resolved', statusNote: 'done' }) })
    const r = await s.getState().setStatus(CWD, 'FB-AAAAA', 'resolved', 'done')
    expect(r.ok).toBe(true)
    expect(sf.inboxSetStatus).toHaveBeenCalledWith({ cwd: CWD, hostId: 'FB-AAAAA', status: 'resolved', note: 'done' })
    expect(slice().items[0].status).toBe('resolved')
    expect(slice().selected?.meta.statusNote).toBe('done')
  })

  it('setStatus failure keeps the old status', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    await s.getState().loadItems(CWD)
    sf.inboxSetStatus.mockResolvedValue(fail('bad'))
    expect((await s.getState().setStatus(CWD, 'FB-AAAAA', 'wontfix')).ok).toBe(false)
    expect(sf.inboxSetStatus).toHaveBeenCalledWith({ cwd: CWD, hostId: 'FB-AAAAA', status: 'wontfix' })
    expect(slice().items[0].status).toBe('open')
    expect(slice().error).toBe('bad')
  })

  it('linkEpic records the epic id; failure surfaces error', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    await s.getState().loadItems(CWD)
    sf.inboxLinkEpic.mockResolvedValueOnce(fail('no epic'))
    expect((await s.getState().linkEpic(CWD, 'FB-AAAAA', 'e1')).ok).toBe(false)
    expect(slice().error).toBe('no epic')
    sf.inboxLinkEpic.mockResolvedValueOnce({ ok: true, meta: meta({ epicId: 'e1' }) })
    expect((await s.getState().linkEpic(CWD, 'FB-AAAAA', 'e1')).ok).toBe(true)
    expect(sf.inboxLinkEpic).toHaveBeenLastCalledWith({ cwd: CWD, hostId: 'FB-AAAAA', epicId: 'e1' })
    expect(slice().items[0].epicId).toBe('e1')
    expect(slice().error).toBeNull()
  })

  it('pendingEpicByItem: setPendingEpic records the minted id; a failed link keeps it, a successful link clears it', async () => {
    const sf = installApi()
    const { s, slice, selectPendingEpic, EMPTY_SITE_FEEDBACK } = await load()
    expect(EMPTY_SITE_FEEDBACK.pendingEpicByItem).toEqual({})
    expect(selectPendingEpic(CWD, 'FB-AAAAA')(s.getState())).toBeNull()
    await s.getState().loadItems(CWD)
    s.getState().setPendingEpic(CWD, 'FB-AAAAA', 'e1')
    expect(slice().pendingEpicByItem).toEqual({ 'FB-AAAAA': 'e1' })
    expect(selectPendingEpic(CWD, 'FB-AAAAA')(s.getState())).toBe('e1')
    s.getState().closeItem(CWD)
    expect(selectPendingEpic(CWD, 'FB-AAAAA')(s.getState())).toBe('e1')
    sf.inboxLinkEpic.mockResolvedValueOnce(fail('disk full'))
    await s.getState().linkEpic(CWD, 'FB-AAAAA', 'e1')
    expect(selectPendingEpic(CWD, 'FB-AAAAA')(s.getState())).toBe('e1')
    sf.inboxLinkEpic.mockResolvedValueOnce({ ok: true, meta: meta({ epicId: 'e1' }) })
    await s.getState().linkEpic(CWD, 'FB-AAAAA', 'e1')
    expect(selectPendingEpic(CWD, 'FB-AAAAA')(s.getState())).toBeNull()
    expect(slice().pendingEpicByItem).toEqual({})
  })

  it('removeItem drops the item and its selection; failure keeps it', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    await s.getState().loadItems(CWD)
    sf.inboxRemove.mockResolvedValueOnce(fail('gone'))
    expect((await s.getState().removeItem(CWD, 'FB-AAAAA')).ok).toBe(false)
    expect(slice().items).toHaveLength(1)
    expect(slice().error).toBe('gone')
    await s.getState().openItem(CWD, 'FB-AAAAA')
    sf.inboxRemove.mockResolvedValueOnce({ ok: true, hostId: 'FB-AAAAA' })
    expect((await s.getState().removeItem(CWD, 'FB-AAAAA')).ok).toBe(true)
    expect(sf.inboxRemove).toHaveBeenLastCalledWith({ cwd: CWD, hostId: 'FB-AAAAA' })
    expect(slice().items).toHaveLength(0)
    expect(slice().selectedHostId).toBeNull()
    expect(slice().selected).toBeNull()
  })

  it('drainNow stores the result and reloads widgets and items with the filter', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    await s.getState().loadItems(CWD, 'open')
    sf.inboxList.mockClear()
    const r = await s.getState().drainNow(CWD)
    expect(r.ok).toBe(true)
    expect(slice().lastDrain).toEqual({ stored: 2, duplicates: 0, rejected: 0, goneBoxes: [], heldBoxes: [] })
    expect(slice().draining).toBe(false)
    expect(sf.widgetList).toHaveBeenCalledWith({ cwd: CWD })
    expect(sf.inboxList).toHaveBeenCalledWith({ cwd: CWD, status: 'open' })
  })

  it('drainNow failure surfaces error and skips reload', async () => {
    const sf = installApi()
    const { s, slice } = await load()
    sf.drainNow.mockResolvedValue({ ...fail('rate_limited'), retryAfterSec: 30 })
    const r = await s.getState().drainNow(CWD)
    expect(r).toMatchObject({ ok: false, retryAfterSec: 30 })
    expect(sf.widgetList).not.toHaveBeenCalled()
    expect(slice().error).toBe('rate_limited')
    expect(slice().draining).toBe(false)
  })

  it('keeps state per cwd', async () => {
    installApi()
    const { s, selectSiteFeedback } = await load()
    await s.getState().loadWidgets(CWD)
    expect(selectSiteFeedback('/other')(s.getState()).widgets).toHaveLength(0)
  })
})
