// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { RemoteCard, RevokeButton, SasBanner, EmptyState } from '../remoteUi'

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(el: Parameters<Root['render']>[0]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(el) })
}

const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = async (el: HTMLElement | null) => {
  await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

describe('remoteUi', () => {
  it('RemoteCard renders title, subtitle, badge and action', async () => {
    const onClick = vi.fn()
    await mount(createElement(RemoteCard, {
      testId: 'card',
      icon: 'wifi',
      title: 'Laptop',
      subtitle: 'dev-1 · last seen now',
      badge: createElement('span', { 'data-testid': 'b' }, 'online'),
      action: createElement(RevokeButton, { testId: 'rev', onClick }),
    }))
    expect(q('card')!.textContent).toContain('Laptop')
    expect(q('card')!.textContent).toContain('dev-1 · last seen now')
    expect(q('b')!.textContent).toBe('online')
    expect(q('rev')!.textContent).toBe('Revoke')
    await click(q('rev'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('SasBanner shows the code and fires onConfirm', async () => {
    const onConfirm = vi.fn()
    await mount(createElement(SasBanner, {
      testId: 'sas', codeTestId: 'code', confirmTestId: 'ok', code: '123456', onConfirm,
    }))
    expect(q('sas')).not.toBeNull()
    expect(q('code')!.textContent).toBe('123456')
    await click(q('ok'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('EmptyState renders its text and testid', async () => {
    await mount(createElement(EmptyState, { testId: 'empty', children: 'Nothing here.' }))
    expect(q('empty')!.textContent).toBe('Nothing here.')
  })
})
