// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { NeedsYouSection } from '../Home'
import { buildNeedsYouRows, parseToolConfirmation, type OutsideItemLite } from '../../../lib/homeNeedsYou'
import { toast } from '../../../state/toast'

const DIGEST = 'ab'.repeat(32)

// Same shape needsYouStore.cjs postConfirmationRequest writes.
const confirmItem = (over: Partial<OutsideItemLite> = {}): OutsideItemLite => ({
  app: 'tool-risk',
  id: 'confirm-0123456789abcdef0123456789abcdef01234567',
  title: 'Confirm Bash: git push origin main',
  why: `A headless job (3810-x) tried \`Bash: git push origin main\`, which is marked 'confirm' by rule \`Bash(git push:*)\`, and was refused. Args digest: ${DIGEST}. Approve resumes that same job session and lets this exact call (same arguments) run once; Deny keeps the job parked (confirmation_denied).`,
  link: null,
  options: ['Approve', 'Deny'],
  status: 'open',
  createdAt: '2026-11-23T10:00:00.000Z',
  ...over,
})

let container: HTMLDivElement | null = null
let root: Root | null = null
let confirmMock: ReturnType<typeof vi.fn>
let answerMock: ReturnType<typeof vi.fn<(app: string, id: string, value: string) => Promise<{ ok: true; item: never }>>>

async function mount(items: OutsideItemLite[]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const rows = buildNeedsYouRows({}, {}, [], 0, items)
  await act(async () => {
    root!.render(createElement(NeedsYouSection, { rows, onAnswer: answerMock }))
    await Promise.resolve()
  })
  return container
}

const click = async (b: Element) => {
  await act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}
const expand = async (el: HTMLElement) =>
  click(Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Confirm Bash'))!)

beforeEach(() => {
  confirmMock = vi.fn().mockResolvedValue({ ok: true, item: {} })
  answerMock = vi.fn().mockResolvedValue({ ok: true, item: {} })
  ;(window as unknown as { api: unknown }).api = {
    needsYou: { list: vi.fn(), answer: answerMock, confirmTool: confirmMock, onChanged: vi.fn(() => () => {}) },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.restoreAllMocks()
  delete (window as unknown as { api?: unknown }).api
})

describe('parseToolConfirmation', () => {
  it('reads tool, summary and digest from a tool-risk item', () => {
    expect(parseToolConfirmation(confirmItem())).toEqual({ tool: 'Bash', summary: 'git push origin main', argsDigest: DIGEST })
  })
  it('handles a call without a summary', () => {
    const it2 = confirmItem({ title: 'Confirm mcp__x__y', why: `A headless job tried \`mcp__x__y\`, which is marked 'confirm', and was refused. Args digest: ${DIGEST}.` })
    expect(parseToolConfirmation(it2)).toEqual({ tool: 'mcp__x__y', summary: '', argsDigest: DIGEST })
  })
  it('is null for other apps or a missing digest', () => {
    expect(parseToolConfirmation(confirmItem({ app: 'Portfolio' }))).toBeNull()
    expect(parseToolConfirmation(confirmItem({ why: 'tried `Bash`' }))).toBeNull()
  })
})

describe('NeedsYouSection tool confirmation rows', () => {
  it('shows the tool, the args summary, and Approve / Deny instead of the option buttons', async () => {
    const el = await mount([confirmItem()])
    await expand(el)
    expect(el.querySelector('[data-testid="confirm-tool"]')?.textContent).toBe('Bash')
    expect(el.querySelector('[data-testid="confirm-args"]')?.textContent).toBe('git push origin main')
    expect(el.querySelector('[data-testid="confirm-approve"]')).toBeTruthy()
    expect(el.querySelector('[data-testid="confirm-deny"]')).toBeTruthy()
    expect(el.querySelectorAll('button').length).toBe(3) // row header + Approve + Deny
  })

  it('Approve calls the clearance IPC with the item digest and toasts', async () => {
    const info = vi.spyOn(toast, 'info')
    const el = await mount([confirmItem()])
    await expand(el)
    await click(el.querySelector('[data-testid="confirm-approve"]')!)
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(confirmMock).toHaveBeenCalledWith({ tool: 'Bash', argsDigest: DIGEST, approved: true })
    expect(answerMock).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('Deny calls the clearance IPC with the item digest and approved:false', async () => {
    const el = await mount([confirmItem()])
    await expand(el)
    await click(el.querySelector('[data-testid="confirm-deny"]')!)
    expect(confirmMock).toHaveBeenCalledWith({ tool: 'Bash', argsDigest: DIGEST, approved: false })
  })

  it('a refused answer toasts the error in words', async () => {
    const err = vi.spyOn(toast, 'error')
    confirmMock.mockResolvedValue({ ok: false, error: 'Already answered.' })
    const el = await mount([confirmItem()])
    await expand(el)
    await click(el.querySelector('[data-testid="confirm-approve"]')!)
    expect(err).toHaveBeenCalledWith('Already answered.')
  })
})
