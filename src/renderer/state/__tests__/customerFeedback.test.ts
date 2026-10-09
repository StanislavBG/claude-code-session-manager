import { describe, it, expect, beforeEach, vi } from 'vitest'

const item = (over: Record<string, unknown> = {}) => ({
  id: 'a', receipt: null, tag: 'bug', title: 't', body: 'b', submittedAt: 1,
  status: 'open', statusNote: null, statusAt: null, seenStatusAt: null, ...over,
})
const inboxItem = (over: Record<string, unknown> = {}) => ({
  id: 'i1', receivedAt: 1, tag: 'bug', title: 't', body: 'b', clientVersion: null,
  clientPlatform: null, moderation: null, status: 'open', statusNote: null,
  statusAt: null, epicId: null, ...over,
})

function installApi() {
  const cf = {
    submit: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    refreshStatus: vi.fn().mockResolvedValue({ ok: true, updated: 1 }),
    markSeen: vi.fn().mockResolvedValue([]),
    ownerInfo: vi.fn().mockResolvedValue({ ownerMode: true, projectCwd: '/p' }),
    inboxPull: vi.fn().mockResolvedValue({ ok: true, fetched: 1, pages: 1 }),
    inboxList: vi.fn().mockResolvedValue({ ok: true, items: [] }),
    inboxSetStatus: vi.fn().mockResolvedValue({ ok: true, item: null }),
    inboxLinkEpic: vi.fn().mockResolvedValue({ ok: true }),
  }
  vi.stubGlobal('window', { api: { customerFeedback: cf } })
  return cf
}

async function load() {
  const mod = await import('../customerFeedback')
  const { toast } = await import('../toast')
  return { ...mod, infoSpy: vi.spyOn(toast, 'info'), errSpy: vi.spyOn(toast, 'error') }
}

describe('customerFeedback store', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('submit success prepends item and resets draft', async () => {
    const cf = installApi()
    const { useCustomerFeedback, infoSpy } = await load()
    const s = useCustomerFeedback
    s.setState({ items: [item({ id: 'old' })] as never })
    s.getState().setDraft({ title: 'T', body: 'B', tag: 'feature' })
    cf.submit.mockResolvedValue({ ok: true, item: item({ id: 'new' }) })
    await s.getState().submit()
    expect(cf.submit).toHaveBeenCalledWith({ title: 'T', body: 'B', tag: 'feature' })
    expect(s.getState().items.map((i) => i.id)).toEqual(['new', 'old'])
    expect(s.getState().draft).toEqual({ title: '', body: '', tag: 'bug' })
    expect(s.getState().submitting).toBe(false)
    expect(infoSpy).toHaveBeenCalledWith('Feedback sent — thank you')
  })

  it('submit failure keeps draft and toasts error (ok:false and reject)', async () => {
    const cf = installApi()
    const { useCustomerFeedback: s, errSpy } = await load()
    s.getState().setDraft({ title: 'T', body: 'B' })
    cf.submit.mockResolvedValueOnce({ ok: false, error: 'nope' })
    await s.getState().submit()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('nope'))
    expect(s.getState().draft.title).toBe('T')
    cf.submit.mockRejectedValueOnce(new Error('net down'))
    await s.getState().submit()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('net down'))
    expect(s.getState().draft.body).toBe('B')
    expect(s.getState().submitting).toBe(false)
  })

  it('ignores a second submit while one is in flight', async () => {
    const cf = installApi()
    const { useCustomerFeedback: s } = await load()
    let resolve!: (v: unknown) => void
    cf.submit.mockReturnValue(new Promise((r) => { resolve = r }))
    const p1 = s.getState().submit()
    await s.getState().submit()
    expect(cf.submit).toHaveBeenCalledTimes(1)
    resolve({ ok: true, item: item() })
    await p1
  })

  it('refreshStatus and markSeen reload items', async () => {
    const cf = installApi()
    const { useCustomerFeedback: s } = await load()
    cf.list.mockResolvedValue([item({ id: 'x', statusAt: 5 })])
    await s.getState().refreshStatus()
    expect(cf.refreshStatus).toHaveBeenCalled()
    expect(s.getState().items[0].id).toBe('x')
    cf.list.mockResolvedValue([item({ id: 'x', statusAt: 5, seenStatusAt: 5 })])
    await s.getState().markSeen()
    expect(cf.markSeen).toHaveBeenCalledWith({})
    expect(s.getState().items[0].seenStatusAt).toBe(5)
  })

  it('unseenStatusCount counts changed statuses', async () => {
    installApi()
    const { unseenStatusCount } = await load()
    expect(
      unseenStatusCount([
        item({ statusAt: null }),
        item({ statusAt: 5, seenStatusAt: null }),
        item({ statusAt: 5, seenStatusAt: 5 }),
        item({ statusAt: 6, seenStatusAt: 5 }),
      ] as never),
    ).toBe(2)
  })

  it('pullInbox, setInboxStatus and linkEpic update inbox; loadOwnerInfo stores info', async () => {
    const cf = installApi()
    const { useCustomerFeedback: s } = await load()
    await s.getState().loadOwnerInfo()
    expect(s.getState().ownerInfo).toEqual({ ownerMode: true, projectCwd: '/p' })
    cf.inboxList.mockResolvedValue({ ok: true, items: [inboxItem()] })
    await s.getState().pullInbox()
    expect(cf.inboxPull).toHaveBeenCalled()
    expect(s.getState().inbox).toHaveLength(1)
    expect(s.getState().inboxLoading).toBe(false)
    cf.inboxList.mockResolvedValue({ ok: true, items: [inboxItem({ status: 'resolved' })] })
    await s.getState().setInboxStatus('i1', 'resolved', 'done')
    expect(cf.inboxSetStatus).toHaveBeenCalledWith({ id: 'i1', status: 'resolved', note: 'done' })
    expect(s.getState().inbox[0].status).toBe('resolved')
    cf.inboxList.mockResolvedValue({ ok: true, items: [inboxItem({ epicId: 'e1' })] })
    await s.getState().linkEpic('i1', 'e1')
    expect(cf.inboxLinkEpic).toHaveBeenCalledWith({ id: 'i1', epicId: 'e1' })
    expect(s.getState().inbox[0].epicId).toBe('e1')
  })

  it('surfaces inbox failures via toast.error', async () => {
    const cf = installApi()
    const { useCustomerFeedback: s, errSpy } = await load()
    cf.inboxPull.mockResolvedValue({ ok: false, error: 'offline' })
    await s.getState().pullInbox()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('offline'))
  })
})
